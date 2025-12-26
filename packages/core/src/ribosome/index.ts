/**
 * Ribosome - WASM Zome Executor
 *
 * Main entry point for executing Holochain zome calls in the browser.
 */

import { ZomeCallRequest, CallContext } from "./call-context";
import { getRibosomeRuntime } from "./runtime";
import { getHostFunctionRegistry } from "./host-fn";
import { deserializeFromWasm, serializeToWasm } from "./serialization";
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

  // For now, instantiate without imports to get memory
  // We'll need to re-instantiate with imports once we have the instance
  let instance: WebAssembly.Instance;

  try {
    // First instantiation: no imports (just to get memory)
    const tempInstance = await runtime.instantiateModule(module, {});

    // Build import object with host functions
    const registry = getHostFunctionRegistry();
    const imports = registry.buildImportObject(tempInstance, context);

    console.log(
      `[Ribosome] Instantiating with ${registry.size} host functions`
    );

    // Second instantiation: with host function imports
    instance = await runtime.instantiateModule(module, imports);
  } catch (error) {
    throw wasmInstantiationError(error);
  }

  // Serialize input payload to WASM memory
  const { ptr: inputPtr, len: inputLen } = serializeToWasm(instance, payload);

  // Get zome function export
  const zomeFnName = `__hc_${zome}_${fn}`;
  const zomeFn = instance.exports[zomeFnName] as
    | ((ptr: number) => bigint)
    | undefined;

  if (!zomeFn) {
    throw zomeFunctionNotFoundError(zome, fn);
  }

  console.log(`[Ribosome] Calling ${zomeFnName}(${inputPtr})`);

  // Call zome function (returns i64: high 32 bits = ptr, low 32 bits = len)
  const resultI64 = zomeFn(inputPtr);

  // Extract pointer and length from i64
  const resultPtr = Number(resultI64 >> 32n);
  const resultLen = Number(resultI64 & 0xffffffffn);

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
