/**
 * Ribosome - WASM Zome Executor
 *
 * Main entry point for executing Holochain zome calls in the browser.
 */

import sodium from "libsodium-wrappers";
import {
  ZomeCallRequest,
  CallContext,
  EmittedSignal,
} from "./call-context";
import { getRibosomeRuntime } from "./runtime";
import { getHostFunctionRegistry } from "./host-fn";
import {
  deserializeFromWasm,
  serializeToWasm,
  writeGuestPtr,
} from "./serialization";
import {
  zomeFunctionNotFoundError,
  wasmInstantiationError,
} from "./error";
import {
  getStorageProvider,
  hasStorageProvider,
  setStorageProvider,
  SourceChainStorage,
  type StorageProvider,
} from "../storage";
import type { EntryDef } from "../types/holochain-types";

/**
 * Result of a zome call execution
 */
export interface ZomeCallResult {
  /** Deserialized result from the zome function */
  result: unknown;

  /** Signals emitted during zome execution */
  signals: EmittedSignal[];
}

/**
 * Execute a zome function call
 *
 * This is the main entry point for executing WASM zome functions.
 *
 * Flow:
 * 1. Compile/retrieve cached WASM module
 * 2. Build import object with host functions
 * 3. Instantiate WASM module
 * 4. Serialize input payload to WASM memory
 * 5. Call zome function
 * 6. Deserialize result from WASM memory
 * 7. Collect any emitted signals
 *
 * @param request - Zome call request
 * @returns Object with result and emitted signals
 * @throws {RibosomeError} If compilation, instantiation, or execution fails
 */
export async function callZome(request: ZomeCallRequest): Promise<ZomeCallResult> {
  const { dnaWasm, cellId, zome, fn, payload, provenance, dnaManifest } = request;

  console.log(
    `[Ribosome] Calling zome function: ${zome}::${fn}`
  );

  // Get or create storage provider
  // Default to SourceChainStorage for backwards compatibility (tests)
  if (!hasStorageProvider()) {
    const sourceChainStorage = SourceChainStorage.getInstance();
    await sourceChainStorage.init();
    setStorageProvider(sourceChainStorage as unknown as StorageProvider);
  }
  const storage = getStorageProvider();

  // Initialize genesis actions if this is a new cell
  const [dnaHash, agentPubKey] = cellId;
  const { initializeGenesis } = await import('../storage/genesis');
  await initializeGenesis(storage as any, dnaHash, agentPubKey);

  // Pre-load chain into session cache if storage requires it (IndexedDB pattern)
  // SQLiteStorage doesn't need this - it queries on demand
  if (storage.preloadChainForCell) {
    await storage.preloadChainForCell(dnaHash, agentPubKey);
    console.log('[Ribosome] Chain pre-loaded into session cache');
  }

  // Begin transaction for atomic chain updates
  storage.beginTransaction();
  console.log('[Ribosome] Transaction started for zome call');

  try {
    // Ensure libsodium is ready (required for signing host functions)
    await sodium.ready;

    // Find the correct WASM for the target zome
    // Each zome (integrity or coordinator) has its own WASM module
    let zomeWasm: Uint8Array | null = null;

    if (dnaManifest) {
      // Check integrity zomes
      const integrityZome = dnaManifest.integrity_zomes.find(z => z.name === zome);
      if (integrityZome?.wasm) {
        console.log(`[Ribosome] Using WASM from integrity zome: ${zome}`);
        zomeWasm = integrityZome.wasm;
      } else {
        // Check coordinator zomes
        const coordinatorZome = dnaManifest.coordinator_zomes?.find(z => z.name === zome);
        if (coordinatorZome?.wasm) {
          console.log(`[Ribosome] Using WASM from coordinator zome: ${zome}`);
          zomeWasm = coordinatorZome.wasm;
        }
      }
    }

    // Fallback to dnaWasm if zome not found in manifest
    if (!zomeWasm || zomeWasm.length === 0) {
      if (dnaWasm && dnaWasm.length > 0) {
        console.log(`[Ribosome] Using fallback dnaWasm for zome: ${zome}`);
        zomeWasm = dnaWasm;
      } else {
        throw new Error(`No WASM available for zome: ${zome}. Check manifest or provide dnaWasm.`);
      }
    }

    // Get runtime and compile/cache module
    // Use zome-specific WASM hash for caching (so different zomes get different modules)
    const runtime = getRibosomeRuntime();
    const zomeWasmHash = new Uint8Array([...dnaHash, ...new TextEncoder().encode(zome)]);
    const module = await runtime.getOrCompileModule(zomeWasmHash, zomeWasm);

    // Create call context
    const context: CallContext = {
      cellId,
      zome,
      fn,
      payload,
      provenance,
      dnaManifest,
    };

    // Create a mutable instance reference that will be updated after instantiation
    // This allows host functions to access the real instance's memory
    const instanceRef = { current: null as WebAssembly.Instance | null };

    // Build import object with host functions
    // We'll use a getter to access the instance, which will be updated after instantiation
    const registry = getHostFunctionRegistry();
    const imports = registry.buildImportObject(instanceRef, context);

    console.log(
      `[Ribosome] Instantiating with ${registry.size} host functions`
    );

    // Instantiate with host function imports
    let instance: WebAssembly.Instance;
    try {
      instance = await runtime.instantiateModule(module, imports);
    } catch (error) {
      throw wasmInstantiationError(error);
    }

    // Update the instance reference so host functions use the real instance
    instanceRef.current = instance;

    // Initialize entry_defs and link_types for integrity zomes
    // Each integrity zome has its own WASM that exports entry_defs and link_types
    // We need to instantiate each integrity WASM separately to get these
    // Check runtime cache first to avoid repeated WASM calls
    if (dnaManifest) {
      for (const integrityZome of dnaManifest.integrity_zomes) {
        // Check runtime cache first
        const cachedMetadata = runtime.getZomeMetadata(dnaHash, integrityZome.name);
        if (cachedMetadata) {
          // Use cached metadata
          integrityZome.entryDefs = cachedMetadata.entryDefs as EntryDef[];
          integrityZome.linkTypeCount = cachedMetadata.linkTypeCount;
          continue;
        }

        const needsEntryDefs = !integrityZome.entryDefs;
        const needsLinkTypes = integrityZome.linkTypeCount === undefined;

        if ((needsEntryDefs || needsLinkTypes) && integrityZome.wasm) {
          console.log('[Ribosome] Initializing metadata for integrity zome:', integrityZome.name);

          // Compile and instantiate the integrity zome's WASM
          const integrityWasmHash = new Uint8Array([...dnaHash, ...new TextEncoder().encode(integrityZome.name)]);
          const integrityModule = await runtime.getOrCompileModule(integrityWasmHash, integrityZome.wasm);
          const integrityInstanceRef = { current: null as WebAssembly.Instance | null };
          const integrityContext: CallContext = {
            cellId,
            zome: integrityZome.name,
            fn: '__init__',
            payload: null,
            provenance,
            dnaManifest,
          };
          const integrityImports = registry.buildImportObject(integrityInstanceRef, integrityContext);
          const integrityInstance = await runtime.instantiateModule(integrityModule, integrityImports);
          integrityInstanceRef.current = integrityInstance;

          // Get entry_defs from integrity WASM
          if (needsEntryDefs) {
            console.log('[Ribosome] Getting entry_defs from integrity zome:', integrityZome.name);
            integrityZome.entryDefs = await initializeEntryDefs(integrityInstance, integrityZome.name);
          }

          // Get link_types from integrity WASM
          if (needsLinkTypes) {
            console.log('[Ribosome] Getting link_types from integrity zome:', integrityZome.name);
            integrityZome.linkTypeCount = initializeLinkTypes(integrityInstance, integrityZome.name);
          }

          // Cache the metadata for future calls
          runtime.setZomeMetadata(dnaHash, integrityZome.name, {
            entryDefs: integrityZome.entryDefs || [],
            linkTypeCount: integrityZome.linkTypeCount ?? 0,
          });
        }
      }
    }

    // Serialize input payload to WASM memory
    const { ptr: dataPtr, len: dataLen } = serializeToWasm(instance, payload);

    console.log(
      `[Ribosome] Calling ${zome}::${fn}(ptr=${dataPtr}, len=${dataLen})`
    );

    // Get zome function export
    // HDK exports functions with just their bare names (e.g., "get_agent_info")
    // Signature: fn(guest_ptr: usize, len: usize) -> DoubleUSize
    const zomeFnName = fn;
    const zomeFn = instance.exports[zomeFnName] as
      | ((ptr: number, len: number) => bigint)
      | undefined;

    if (!zomeFn) {
      throw zomeFunctionNotFoundError(zome, fn);
    }

    // Call zome function with TWO parameters: pointer and length
    const resultI64 = zomeFn(dataPtr, dataLen);

    // Extract result: HIGH 32 bits = ptr, LOW 32 bits = len (from merge_usize)
    const resultPtr = Number(resultI64 >> 32n); // ptr in high 32 bits
    const resultLen = Number(resultI64 & 0xffffffffn); // len in low 32 bits

    console.log(
      `[Ribosome] Result at ptr=${resultPtr}, len=${resultLen}`
    );

    // Deserialize result from WASM memory
    const result = deserializeFromWasm(instance, resultPtr, resultLen);

    // Collect any emitted signals
    const signals = context.emittedSignals || [];

    // Commit transaction - all chain updates succeed atomically
    // May be sync (SQLiteStorage) or async (SourceChainStorage)
    const commitResult = storage.commitTransaction();
    if (commitResult instanceof Promise) {
      await commitResult;
    }
    console.log('[Ribosome] Transaction committed successfully');

    return {
      result,
      signals,
    };
  } catch (error) {
    // Rollback transaction on any error - discard all chain updates
    if (storage.isTransactionActive()) {
      storage.rollbackTransaction();
      console.error('[Ribosome] Transaction rolled back due to error:', error);
    }

    // Re-throw error for caller to handle
    throw error;
  }
}

/**
 * Initialize entry_defs by calling the raw entry_defs callback export
 * This is called after WASM instantiation when host functions are available
 */
async function initializeEntryDefs(
  instance: WebAssembly.Instance,
  zomeName: string
): Promise<EntryDef[]> {
  // Check if entry_defs export exists
  const entryDefsFn = instance.exports.entry_defs as
    | ((ptr: number, len: number) => bigint)
    | undefined;

  if (!entryDefsFn) {
    console.log(`[initializeEntryDefs] No entry_defs export found for zome: ${zomeName}`);
    return [];
  }

  console.log(`[initializeEntryDefs] Calling entry_defs() for zome: ${zomeName}`);

  try {
    // Serialize unit type () as input - HDK expects SerializedBytes wrapping unit
    // Unit type () serializes as nil (0xC0 = 192) in MessagePack
    // Wrap in Uint8Array: ExternIO expects SerializedBytes(Vec<u8>) containing the msgpack bytes
    const { ptr: inputPtr, len: inputLen } = serializeToWasm(instance, new Uint8Array([192]));

    // Call the entry_defs callback
    const resultI64 = entryDefsFn(inputPtr, inputLen);

    // Extract ptr and len
    const resultPtr = Number(resultI64 >> 32n);
    const resultLen = Number(resultI64 & 0xffffffffn);

    // Deserialize the result
    const result = deserializeFromWasm(instance, resultPtr, resultLen);

    console.log(`[initializeEntryDefs] Got result:`, result);

    // Result is wrapped in Ok/Err
    if (result && typeof result === 'object' && 'Ok' in result) {
      let okValue = (result as any).Ok;

      // If Ok value is Uint8Array, decode it (ExternIO output wrapper)
      if (okValue instanceof Uint8Array) {
        const { decode } = await import('@msgpack/msgpack');
        okValue = decode(okValue);
        console.log(`[initializeEntryDefs] Decoded Ok value:`, okValue);
      }

      // Ok value is { Defs: [array of EntryDef] }
      if (okValue && typeof okValue === 'object' && 'Defs' in okValue) {
        return okValue.Defs as EntryDef[];
      }
    }
  } catch (error) {
    console.warn(`[initializeEntryDefs] Failed to initialize entry_defs:`, error);
  }

  return [];
}

/**
 * Link type definition from link_types callback
 */
interface LinkTypeDef {
  name: string;
  index: number;
}

/**
 * Get the number of link types from the WASM __num_link_types export
 * This is a simple export that returns the count directly (no serialization needed)
 */
function initializeLinkTypes(
  instance: WebAssembly.Instance,
  zomeName: string
): number {
  // HDI generates __num_link_types export that returns the count directly
  const numLinkTypesFn = instance.exports.__num_link_types as
    | (() => number)
    | undefined;

  if (numLinkTypesFn) {
    const count = numLinkTypesFn();
    console.log(`[initializeLinkTypes] __num_link_types() returned ${count} for zome: ${zomeName}`);
    return count;
  }

  // Fallback: try link_types callback (older style)
  const linkTypesFn = instance.exports.link_types as
    | ((ptr: number, len: number) => bigint)
    | undefined;

  if (!linkTypesFn) {
    console.log(`[initializeLinkTypes] No link_types export found for zome: ${zomeName}`);
    return 0;
  }

  console.log(`[initializeLinkTypes] link_types callback not supported, returning 0`);
  return 0;
}

// Re-export key types and utilities
export type {
  ZomeCallRequest,
  CallContext,
  CellId,
  EmittedSignal,
} from "./call-context";
export type { HostFunctionContext, HostFunctionImpl } from "./host-fn/base";
export { getHostFunctionRegistry } from "./host-fn";
export { RibosomeError, RibosomeErrorType } from "./error";
