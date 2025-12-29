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
import { SourceChainStorage } from "../storage";

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

  // Get storage instance for transaction management
  const storage = SourceChainStorage.getInstance();
  await storage.init();

  // Initialize genesis actions if this is a new cell
  const [dnaHash, agentPubKey] = cellId;
  const { initializeGenesis } = await import('../storage/genesis');
  await initializeGenesis(storage, dnaHash, agentPubKey);

  // Pre-load entire chain into session cache for synchronous reads during WASM execution
  await storage.preloadChainForCell(dnaHash, agentPubKey);
  console.log('[Ribosome] Chain pre-loaded into session cache');

  // Begin transaction for atomic chain updates
  storage.beginTransaction();
  console.log('[Ribosome] Transaction started for zome call');

  try {
    // Ensure libsodium is ready (required for signing host functions)
    await sodium.ready;

    // Get runtime and compile/cache module
    const runtime = getRibosomeRuntime();
    const module = await runtime.getOrCompileModule(dnaHash, dnaWasm);

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

    // Initialize entry_defs immediately after instantiation (before any zome calls)
    // This ensures entry_defs are available for validation in all zome calls
    if (dnaManifest) {
      for (const z of dnaManifest.integrity_zomes) {
        if (!z.entryDefs) {
          console.log('[Ribosome] Initializing entry_defs for zome:', z.name);
          z.entryDefs = await initializeEntryDefs(instance, z.name);
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
    await storage.commitTransaction();
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
): Promise<unknown[]> {
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
        return okValue.Defs as unknown[];
      }
    }
  } catch (error) {
    console.warn(`[initializeEntryDefs] Failed to initialize entry_defs:`, error);
  }

  return [];
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
