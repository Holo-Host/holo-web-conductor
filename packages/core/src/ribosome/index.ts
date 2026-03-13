/**
 * Ribosome - WASM Zome Executor
 *
 * Main entry point for executing Holochain zome calls in the browser.
 */

import sodium from "libsodium-wrappers";
import { createLogger } from '@hwc/shared';

const log = createLogger('Ribosome');
import {
  ZomeCallRequest,
  CallContext,
  EmittedSignal,
  PendingRecord,
  QueuedRemoteSignal,
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
import { getNetworkCache } from "../network";
import {
  startZomeCallMetrics,
  endZomeCallMetrics,
  recordPhase,
  timeSync,
  timeAsync,
} from "./perf";
import { buildRecords, buildSignedActionHashedArray } from "../dht/record-converter";
import type { Record as HolochainRecord, SignedActionHashed } from "@holochain/client";

/**
 * Result of a zome call execution
 */
export interface ZomeCallResult {
  /** Deserialized result from the zome function */
  result: unknown;

  /** Signals emitted during zome execution */
  signals: EmittedSignal[];

  /** Records created during zome execution (ready for publishing) */
  pendingRecords?: HolochainRecord[];

  /** Remote signals queued for delivery via kitsune2 network */
  remoteSignals?: QueuedRemoteSignal[];
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
  const callStart = performance.now();
  const { dnaWasm, cellId, zome, fn, payload, provenance, dnaManifest } = request;

  log.debug(`Calling zome function: ${zome}::${fn}`);

  // Start performance tracking
  startZomeCallMetrics(zome, fn);

  // Get or create storage provider
  // Fallback to IndexedDB-based SourceChainStorage for vitest (fake-indexeddb).
  // In the browser extension, DirectSQLiteStorage is set before any zome calls.
  if (!hasStorageProvider()) {
    const sourceChainStorage = SourceChainStorage.getInstance();
    await sourceChainStorage.init();
    setStorageProvider(sourceChainStorage as unknown as StorageProvider);
  }
  const storage = getStorageProvider();

  // Initialize genesis actions if this is a new cell
  const [dnaHash, agentPubKey] = cellId;
  let genesisRecords: { action: any; entry?: any }[] = [];
  await timeAsync('genesisCheck', async () => {
    const { initializeGenesis } = await import('../storage/genesis');
    const genesisResult = await initializeGenesis(storage as any, dnaHash, agentPubKey);
    if (genesisResult.initialized) {
      genesisRecords = genesisResult.pendingRecords;
      log.debug(` Genesis initialized with ${genesisRecords.length} records to publish`);
    }
  });

  // Pre-load chain into session cache if storage requires it (IndexedDB pattern)
  // SQLiteStorage doesn't need this - it queries on demand
  if (storage.preloadChainForCell) {
    await storage.preloadChainForCell(dnaHash, agentPubKey);
    log.debug(' Chain pre-loaded into session cache');
  }

  // Begin transaction for atomic chain updates
  storage.beginTransaction();
  log.debug(' Transaction started for zome call');

  try {
    // Ensure libsodium is ready (required for signing host functions)
    await timeAsync('sodiumReady', () => sodium.ready);

    // Find the correct WASM for the target zome
    // Each zome (integrity or coordinator) has its own WASM module
    let zomeWasm: Uint8Array | null = null;

    if (dnaManifest) {
      // Check integrity zomes
      const integrityZome = dnaManifest.integrity_zomes.find(z => z.name === zome);
      if (integrityZome?.wasm) {
        log.debug(` Using WASM from integrity zome: ${zome}`);
        zomeWasm = integrityZome.wasm;
      } else {
        // Check coordinator zomes
        const coordinatorZome = dnaManifest.coordinator_zomes?.find(z => z.name === zome);
        if (coordinatorZome?.wasm) {
          log.debug(` Using WASM from coordinator zome: ${zome}`);
          zomeWasm = coordinatorZome.wasm;
        }
      }
    }

    // Fallback to dnaWasm if zome not found in manifest
    if (!zomeWasm || zomeWasm.length === 0) {
      if (dnaWasm && dnaWasm.length > 0) {
        log.debug(` Using fallback dnaWasm for zome: ${zome}`);
        zomeWasm = dnaWasm;
      } else {
        throw new Error(`No WASM available for zome: ${zome}. Check manifest or provide dnaWasm.`);
      }
    }

    // Get runtime and compile/cache module
    // Use zome-specific WASM hash for caching (so different zomes get different modules)
    const runtime = getRibosomeRuntime();
    const zomeWasmHash = new Uint8Array([...dnaHash, ...new TextEncoder().encode(zome)]);
    const module = await timeAsync('wasmCompile', () => runtime.getOrCompileModule(zomeWasmHash, zomeWasm!));

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

    log.debug(`Instantiating with ${registry.size} host functions`);

    // Instantiate with host function imports
    let instance: WebAssembly.Instance;
    try {
      instance = await timeAsync('wasmInstantiate', () => runtime.instantiateModule(module, imports));
    } catch (error) {
      throw wasmInstantiationError(error);
    }

    // Update the instance reference so host functions use the real instance
    instanceRef.current = instance;

    // Initialize entry_defs and link_types for integrity zomes
    // Each integrity zome has its own WASM that exports entry_defs and link_types
    // We need to instantiate each integrity WASM separately to get these
    // Check runtime cache first to avoid repeated WASM calls
    const metadataStart = performance.now();
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
          log.debug(' Initializing metadata for integrity zome:', integrityZome.name);

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
            log.debug(' Getting entry_defs from integrity zome:', integrityZome.name);
            integrityZome.entryDefs = await initializeEntryDefs(integrityInstance, integrityZome.name);
          }

          // Get link_types from integrity WASM
          if (needsLinkTypes) {
            log.debug(' Getting link_types from integrity zome:', integrityZome.name);
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
    recordPhase('metadataInit', performance.now() - metadataStart);

    // Serialize input payload to WASM memory
    const { ptr: dataPtr, len: dataLen } = timeSync('serialize', () => serializeToWasm(instance, payload));

    log.debug(`Calling ${zome}::${fn}(ptr=${dataPtr}, len=${dataLen})`);

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
    const zomeExecStart = performance.now();
    const resultI64 = zomeFn(dataPtr, dataLen);
    recordPhase('zomeExecute', performance.now() - zomeExecStart);

    // Extract result: HIGH 32 bits = ptr, LOW 32 bits = len (from merge_usize)
    const resultPtr = Number(resultI64 >> 32n); // ptr in high 32 bits
    const resultLen = Number(resultI64 & 0xffffffffn); // len in low 32 bits

    log.debug(`Result at ptr=${resultPtr}, len=${resultLen}`);

    // Deserialize result from WASM memory
    const result = timeSync('deserialize', () => deserializeFromWasm(instance, resultPtr, resultLen));

    // Check if result is an ExternResult::Err variant
    // ExternResult is serialized as { Err: { ... } } or { Ok: value }
    // When zome returns Err(...), we should rollback, not commit
    let unwrappedResult = result;
    if (result && typeof result === 'object') {
      if ('Err' in result) {
        log.debug(' Zome returned error, rolling back transaction');
        if (storage.isTransactionActive()) {
          storage.rollbackTransaction();
        }
        // Extract error message and throw
        const errPayload = (result as any).Err;
        const errorMsg = errPayload?.Guest || errPayload?.message || JSON.stringify(errPayload);
        throw new Error(`Zome error: ${errorMsg}`);
      } else if ('Ok' in result) {
        // Unwrap the Ok variant
        let okValue = (result as any).Ok;

        // If Ok value is Uint8Array (ExternIO), decode it
        if (okValue instanceof Uint8Array) {
          const { decode } = await import('@msgpack/msgpack');
          okValue = decode(okValue);
          log.debug(' Decoded ExternIO Ok value');
        }

        unwrappedResult = okValue;
      }
    }

    // Run inline validation on pending records (not genesis records)
    // This matches Holochain's inline_validation in call_zome_workflow.rs
    const zomeCallPendingRecords = context.pendingRecords || [];
    if (zomeCallPendingRecords.length > 0 && dnaManifest) {
      try {
        const { invokeInlineValidation } = await import('./validate');
        await invokeInlineValidation(zomeCallPendingRecords, context, dnaManifest);
        log.debug(' Inline validation passed');
      } catch (validationError) {
        log.debug(' Inline validation failed, rolling back');
        if (storage.isTransactionActive()) {
          storage.rollbackTransaction();
        }
        throw new Error(
          `Validation failed: ${validationError instanceof Error ? validationError.message : String(validationError)}`
        );
      }
    }

    // Commit transaction - all chain updates succeed atomically
    // May be sync (SQLiteStorage) or async (SourceChainStorage)
    const commitStart = performance.now();
    const commitResult = storage.commitTransaction();
    if (commitResult instanceof Promise) {
      await commitResult;
    }
    recordPhase('txCommit', performance.now() - commitStart);
    log.debug(' Transaction committed successfully');

    // Apply pending cache operations now that data is persisted
    if (context.pendingCacheOps && context.pendingCacheOps.length > 0) {
      const cache = getNetworkCache();
      for (const op of context.pendingCacheOps) {
        if (op.type === 'mergeLink') {
          cache.mergeLinkIntoCache(op.baseAddress, op.link);
        } else if (op.type === 'removeLink') {
          cache.removeLinkFromCache(op.baseAddress, op.createLinkHash);
        } else if (op.type === 'mergeLinkDetail') {
          cache.mergeLinkDetailIntoCache(op.baseAddress, op.link);
        } else if (op.type === 'addDeleteToLinkDetails') {
          cache.addDeleteToLinkDetailsCache(op.baseAddress, op.createLinkHash, op.deleteHash);
        }
      }
      log.debug(` Applied ${context.pendingCacheOps.length} cache operations`);
    }

    // Collect ALL pending records including genesis
    const allPendingRecords = [
      ...genesisRecords,
      ...(context.pendingRecords || []),
    ];

    // Call post_commit callback if WASM exports it and there are committed actions
    // post_commit is fire-and-forget: errors are logged but don't fail the zome call
    // post_commit can emit_signal but CANNOT write to source chain
    if (allPendingRecords.length > 0) {
      try {
        await invokePostCommit(instance, context, allPendingRecords);
      } catch (postCommitError) {
        console.error('[Ribosome] post_commit error (non-fatal):', postCommitError);
      }
    }

    // Merge any signals emitted during post_commit
    const allSignals = context.emittedSignals || [];

    // Convert pending records to @holochain/client Record format for publishing
    let pendingRecords: HolochainRecord[] | undefined;
    log.debug(` allPendingRecords count: ${allPendingRecords.length} (genesis: ${genesisRecords.length}, zome: ${context.pendingRecords?.length || 0})`);
    if (allPendingRecords.length > 0) {
      try {
        log.debug(' Building records for publishing...');
        log.debug(' First pending record:', JSON.stringify({
          actionType: allPendingRecords[0]?.action?.actionType,
          hasEntry: !!allPendingRecords[0]?.entry,
          entryType: allPendingRecords[0]?.entry?.entryType,
        }));
        pendingRecords = buildRecords(allPendingRecords);
        log.debug(` ${pendingRecords.length} records ready for publishing`);
        if (pendingRecords.length > 0) {
          log.debug(' First built record entry type:', pendingRecords[0]?.entry);
        }
      } catch (error) {
        console.error('[Ribosome] Failed to convert records for publishing:', error);
        console.error('[Ribosome] Error stack:', error instanceof Error ? error.stack : 'no stack');
        // Don't fail the zome call - publishing is secondary
      }
    }

    // End performance tracking
    endZomeCallMetrics(performance.now() - callStart);

    return {
      result: unwrappedResult,
      signals: allSignals,
      pendingRecords,
      remoteSignals: context.remoteSignals,
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
 * Invoke the post_commit callback if the WASM exports it
 *
 * post_commit is called AFTER the source chain commit is complete.
 * It receives a Vec<SignedActionHashed> of all committed actions.
 *
 * Key behaviors (matching Holochain):
 * - Errors are logged but don't fail the zome call
 * - post_commit CAN emit_signal and call other zome functions
 * - post_commit CANNOT write to source chain (create, update, delete)
 *
 * @param instance - WASM instance
 * @param context - Call context (for signals)
 * @param pendingRecords - Records that were committed
 */
async function invokePostCommit(
  instance: WebAssembly.Instance,
  context: CallContext,
  pendingRecords: PendingRecord[]
): Promise<void> {
  // Check if WASM exports post_commit
  const postCommitFn = instance.exports.post_commit as
    | ((ptr: number, len: number) => bigint)
    | undefined;

  if (!postCommitFn) {
    log.debug('[post_commit] No post_commit export found, skipping');
    return;
  }

  log.debug(`[post_commit] Invoking post_commit with ${pendingRecords.length} committed actions`);

  try {
    // Build Vec<SignedActionHashed> from pending records
    const signedActions = buildSignedActionHashedArray(pendingRecords);

    // Serialize the actions for WASM
    // post_commit expects Vec<SignedActionHashed> encoded as ExternIO (msgpack bytes)
    const { encode } = await import('@msgpack/msgpack');
    const actionsBytes = new Uint8Array(encode(signedActions));
    const { ptr: inputPtr, len: inputLen } = serializeToWasm(instance, actionsBytes);

    log.debug(`[post_commit] Calling post_commit with ${actionsBytes.length} bytes input`);

    // Call post_commit
    const resultI64 = postCommitFn(inputPtr, inputLen);

    // Extract ptr and len from result
    const resultPtr = Number(resultI64 >> 32n);
    const resultLen = Number(resultI64 & 0xffffffffn);

    // Deserialize result (should be ExternResult<()>)
    const result = deserializeFromWasm(instance, resultPtr, resultLen);

    // Check for errors
    if (result && typeof result === 'object' && 'Err' in result) {
      const errPayload = (result as any).Err;
      const errorMsg = errPayload?.Guest || errPayload?.message || JSON.stringify(errPayload);
      console.error(`[post_commit] post_commit returned error: ${errorMsg}`);
      // Don't throw - post_commit errors are non-fatal
    } else {
      log.debug('[post_commit] post_commit completed successfully');
    }

    // Any signals emitted during post_commit are already in context.emittedSignals
    const signalCount = context.emittedSignals?.length || 0;
    log.debug(`[post_commit] Total signals after post_commit: ${signalCount}`);
  } catch (error) {
    // Log error but don't propagate - post_commit is fire-and-forget
    console.error('[post_commit] Exception during post_commit:', error);
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
    log.debug(`[initializeEntryDefs] No entry_defs export found for zome: ${zomeName}`);
    return [];
  }

  log.debug(`[initializeEntryDefs] Calling entry_defs() for zome: ${zomeName}`);

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

    log.debug(`[initializeEntryDefs] Got result:`, result);

    // Result is wrapped in Ok/Err
    if (result && typeof result === 'object' && 'Ok' in result) {
      let okValue = (result as any).Ok;

      // If Ok value is Uint8Array, decode it (ExternIO output wrapper)
      if (okValue instanceof Uint8Array) {
        const { decode } = await import('@msgpack/msgpack');
        okValue = decode(okValue);
        log.debug(`[initializeEntryDefs] Decoded Ok value:`, okValue);
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
    log.debug(`[initializeLinkTypes] __num_link_types() returned ${count} for zome: ${zomeName}`);
    return count;
  }

  // Fallback: try link_types callback (older style)
  const linkTypesFn = instance.exports.link_types as
    | ((ptr: number, len: number) => bigint)
    | undefined;

  if (!linkTypesFn) {
    log.debug(`[initializeLinkTypes] No link_types export found for zome: ${zomeName}`);
    return 0;
  }

  log.debug(`[initializeLinkTypes] link_types callback not supported, returning 0`);
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
