/**
 * Ribosome - WASM Zome Executor
 *
 * Main entry point for executing Holochain zome calls in the browser.
 */

import sodium from "libsodium-wrappers";
import { ZomeCallRequest, CallContext } from "./call-context";
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
 *
 * @param request - Zome call request
 * @returns Deserialized result from zome function
 * @throws {RibosomeError} If compilation, instantiation, or execution fails
 */
export async function callZome(request: ZomeCallRequest): Promise<unknown> {
  const { dnaWasm, cellId, zome, fn, payload, provenance } = request;

  console.log(
    `[Ribosome] Calling zome function: ${zome}::${fn}`
  );

  // Ensure libsodium is ready (required for signing host functions)
  await sodium.ready;

  // Get runtime and compile/cache module
  const runtime = getRibosomeRuntime();
  const [dnaHash] = cellId;
  const module = await runtime.getOrCompileModule(dnaHash, dnaWasm);

  // Create call context
  const context: CallContext = {
    cellId,
    zome,
    fn,
    payload,
    provenance,
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

  return result;
}

// Re-export key types and utilities
export type { ZomeCallRequest, CallContext, CellId } from "./call-context";
export type { HostFunctionContext, HostFunctionImpl } from "./host-fn/base";
export { getHostFunctionRegistry } from "./host-fn";
export { RibosomeError, RibosomeErrorType } from "./error";
