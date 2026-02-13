/**
 * Host function: __hc__call_1
 *
 * Implements cross-zome calls within the same cell (Local target).
 * This is critical for complex DNAs like mewsfeed where coordinator
 * zomes call each other (e.g., mews calls profiles).
 *
 * Input: Vec<Call> (HDK wraps single Call in a Vec)
 * Output: Result<Vec<ZomeCallResponse>, WasmError>
 *   where ZomeCallResponse::Ok(ExternIO) wraps the called function's return bytes
 */

import { HostFunctionImpl } from "./base";
import {
  deserializeFromWasm,
  serializeToWasm,
  serializeResult,
} from "../serialization";

import { extractPtrAndLen } from "../runtime";
import { getHostFunctionRegistry } from "./index";
import type { CallContext } from "../call-context";

/**
 * Cross-zome call host function.
 *
 * Only supports CallTarget::ConductorCell(CallTargetCell::Local) — calling
 * another zome within the same cell. NetworkAgent and OtherCell/OtherRole
 * targets are not supported (would require conductor routing).
 */
export const call: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { callContext, instance: callerInstance } = context;

  // Deserialize the Vec<Call> input from WASM memory
  const input = deserializeFromWasm(callerInstance, inputPtr, inputLen) as any;

  // HDK sends Vec<Call> — a 1-element array wrapping the Call struct.
  // Unwrap the Vec to get the single Call.
  let callObj: any = input;
  if (Array.isArray(callObj) && callObj.length === 1) {
    callObj = callObj[0];
  }

  // Helper to get a field from an object or Map
  const field = (obj: any, key: string): any => {
    if (obj instanceof Map) return obj.get(key);
    return obj?.[key];
  };

  const target = field(callObj, 'target');
  const targetZome = field(callObj, 'zome_name') as string;
  const targetFn = field(callObj, 'fn_name') as string;
  const rawPayload = field(callObj, 'payload');

  if (!target) {
    const keys = callObj instanceof Map ? Array.from(callObj.keys()) :
                 callObj ? Object.keys(callObj) : [];
    throw new Error(`[HostFn:call] Missing target (keys=${keys})`);
  }

  // Extract ConductorCell from target
  // CallTarget::ConductorCell(CallTargetCell::Local) → { ConductorCell: "Local" }
  const conductorCell = field(target, 'ConductorCell');
  if (conductorCell === undefined) {
    throw new Error(`[HostFn:call] No ConductorCell in target`);
  }

  if (conductorCell !== 'Local' && !(conductorCell && conductorCell.Local !== undefined)) {
    throw new Error(`[HostFn:call] Unsupported cell target: ${JSON.stringify(conductorCell)}`);
  }

  if (!targetZome || !targetFn) {
    throw new Error(`[HostFn:call] Missing zome_name or fn_name`);
  }

  console.log(`[HostFn:call] Cross-zome call: ${targetZome}::${targetFn}`);

  // Find the target zome's WASM from the DNA manifest
  const dnaManifest = callContext.dnaManifest;
  if (!dnaManifest) {
    throw new Error(`[HostFn:call] No dnaManifest available for cross-zome call`);
  }

  let targetWasm: Uint8Array | null = null;

  // Check coordinator zomes first (most cross-zome calls target coordinators)
  const coordZome = dnaManifest.coordinator_zomes?.find(z => z.name === targetZome);
  if (coordZome?.wasm) {
    targetWasm = coordZome.wasm;
  } else {
    // Check integrity zomes
    const integrityZome = dnaManifest.integrity_zomes.find(z => z.name === targetZome);
    if (integrityZome?.wasm) {
      targetWasm = integrityZome.wasm;
    }
  }

  if (!targetWasm) {
    throw new Error(`[HostFn:call] Zome '${targetZome}' not found in DNA manifest`);
  }

  // Compile the target zome's WASM module synchronously (works in worker context)
  let module: WebAssembly.Module;
  try {
    module = new WebAssembly.Module(targetWasm);
  } catch (e) {
    throw new Error(`[HostFn:call] Failed to compile WASM for zome '${targetZome}': ${e}`);
  }

  // Build import object for the target zome instance.
  // Use the same CallContext but with updated zome/fn names.
  // This shares the same storage transaction context.
  const targetContext: CallContext = {
    ...callContext,
    zome: targetZome,
    fn: targetFn,
    // Fresh arrays for the target's side effects
    pendingRecords: [],
    emittedSignals: [],
    remoteSignals: [],
  };

  const registry = getHostFunctionRegistry();
  const targetInstanceRef = { current: null as WebAssembly.Instance | null };
  const imports = registry.buildImportObject(targetInstanceRef, targetContext);

  // Instantiate synchronously (works in worker context)
  let targetInstance: WebAssembly.Instance;
  try {
    targetInstance = new WebAssembly.Instance(module, imports);
  } catch (e) {
    throw new Error(`[HostFn:call] Failed to instantiate zome '${targetZome}': ${e}`);
  }
  targetInstanceRef.current = targetInstance;

  // Find the target function in the WASM exports
  // Zome functions take TWO params: (ptr: number, len: number) => bigint
  const wasmFn = targetInstance.exports[targetFn] as
    | ((ptr: number, len: number) => bigint)
    | undefined;
  if (!wasmFn) {
    throw new Error(`[HostFn:call] Function '${targetFn}' not found in zome '${targetZome}'`);
  }

  // The rawPayload is ExternIO inner bytes (rmp_serde-encoded payload).
  // The WASM function's host_args() deserializes as ExternIO, which is a
  // serde_bytes newtype — it expects msgpack binary format wrapping the inner bytes.
  // serializeToWasm(Uint8Array) produces msgpack bin format, which is exactly
  // what ExternIO expects. The inner bytes stay as the original rmp_serde encoding.
  let payloadBytes: Uint8Array;
  if (rawPayload instanceof Uint8Array) {
    payloadBytes = rawPayload;
  } else if (Array.isArray(rawPayload)) {
    payloadBytes = new Uint8Array(rawPayload);
  } else if (rawPayload === null || rawPayload === undefined) {
    payloadBytes = new Uint8Array([0xC0]); // msgpack nil
  } else {
    payloadBytes = new Uint8Array(rawPayload);
  }

  // serializeToWasm encodes Uint8Array as msgpack bin → host_args deserializes as ExternIO
  const { ptr: inputGuestPtr, len: inputLen2 } = serializeToWasm(targetInstance, payloadBytes);

  // Call the target zome function with BOTH ptr and len
  console.log(`[HostFn:call] Executing ${targetZome}::${targetFn} (ptr=${inputGuestPtr}, len=${inputLen2})...`);
  const resultI64 = wasmFn(inputGuestPtr, inputLen2);

  // Extract result from the target instance's memory
  const { ptr: resultPtr, len: resultLen } = extractPtrAndLen(resultI64);
  const result = deserializeFromWasm(targetInstance, resultPtr, resultLen);

  console.log(`[HostFn:call] ${targetZome}::${targetFn} completed`);

  // Propagate side effects from target context back to caller context
  if (targetContext.pendingRecords && targetContext.pendingRecords.length > 0) {
    if (!callContext.pendingRecords) callContext.pendingRecords = [];
    callContext.pendingRecords.push(...targetContext.pendingRecords);
  }
  if (targetContext.emittedSignals && targetContext.emittedSignals.length > 0) {
    if (!callContext.emittedSignals) callContext.emittedSignals = [];
    callContext.emittedSignals.push(...targetContext.emittedSignals);
  }
  if (targetContext.remoteSignals && targetContext.remoteSignals.length > 0) {
    if (!callContext.remoteSignals) callContext.remoteSignals = [];
    callContext.remoteSignals.push(...targetContext.remoteSignals);
  }

  // The result from the target function is the raw ExternIO Ok/Err value.
  // We need to wrap it as ZomeCallResponse::Ok(ExternIO) inside Vec<ZomeCallResponse>.
  // The HDK caller expects Vec<ZomeCallResponse> (since it sent Vec<Call>).
  let externIOBytes: Uint8Array;

  if (result && typeof result === 'object' && 'Ok' in result) {
    const okValue = (result as any).Ok;
    if (okValue instanceof Uint8Array) {
      externIOBytes = okValue;
    } else if (Array.isArray(okValue)) {
      externIOBytes = new Uint8Array(okValue);
    } else {
      console.warn(`[HostFn:call] Unexpected Ok value type: ${typeof okValue}`);
      externIOBytes = new Uint8Array([0xC0]);
    }
  } else if (result && typeof result === 'object' && 'Err' in result) {
    // The target returned Err - propagate the error
    throw new Error(`[HostFn:call] ${targetZome}::${targetFn} returned error: ${JSON.stringify((result as any).Err)}`);
  } else {
    console.warn(`[HostFn:call] Unexpected result format:`, result);
    externIOBytes = new Uint8Array([0xC0]);
  }

  // Return Vec<ZomeCallResponse> wrapped in Result::Ok
  // HDK passes Vec<Call> and expects Vec<ZomeCallResponse> back.
  // ZomeCallResponse::Ok wraps ExternIO (raw bytes).
  const zomeCallResponse = { Ok: externIOBytes };
  const responseVec = [zomeCallResponse]; // Vec<ZomeCallResponse>
  return serializeResult(callerInstance, responseVec);
};
