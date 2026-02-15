/**
 * Host Function Base Types
 *
 * Core types and utilities for implementing Holochain host functions.
 */

import { CallContext } from "../call-context";
import { hostFunctionError } from "../error";
import { recordHostFunction } from "../perf";

/**
 * Context available to host functions during execution
 */
export interface HostFunctionContext {
  /** Current zome call context */
  callContext: CallContext;

  /** WASM instance being executed */
  instance: WebAssembly.Instance;
}

/**
 * Host function implementation signature
 *
 * All host functions follow this pattern:
 * - Receive pointer and length of serialized input (MessagePack)
 * - Return i64 with ptr in high 32 bits, len in low 32 bits
 * - Can be synchronous or asynchronous
 *   - Async host functions are NOT truly supported by WASM spec
 *   - Workaround: We'll handle async by making zome execution itself async
 *   - Storage reads/writes use IndexedDB (async), so host functions must support await
 */
export type HostFunctionImpl = (
  context: HostFunctionContext,
  inputPtr: number,
  inputLen: number
) => bigint | Promise<bigint>;

/**
 * Wrap a host function with error handling
 *
 * This uses a mutable instance reference that gets updated after WASM instantiation.
 * This allows host functions to access the real WASM instance memory instead of
 * a placeholder instance used during import object creation.
 *
 * @param name - Host function name for error reporting
 * @param impl - Host function implementation
 * @returns Wrapped function with error handling
 */
export function wrapHostFunction(
  name: string,
  impl: HostFunctionImpl
): (
  instanceRef: { current: WebAssembly.Instance | null },
  context: CallContext
) => (ptr: number, len: number) => bigint {
  return (instanceRef: { current: WebAssembly.Instance | null }, context: CallContext) => {
    return (inputPtr: number, inputLen: number): bigint => {
      const start = performance.now();
      try {
        // Extract actual instance from reference
        if (!instanceRef.current) {
          throw new Error(`Host function ${name} called before WASM instantiation`);
        }

        const hostContext: HostFunctionContext = {
          callContext: context,
          instance: instanceRef.current,
        };
        const result = impl(hostContext, inputPtr, inputLen);

        // If result is a Promise, we can't handle it synchronously from WASM
        // This should not happen in Step 6 with our session cache pattern
        if (result instanceof Promise) {
          throw new Error(
            `Host function ${name} returned Promise - async not supported in WASM context ` +
            `(Step 7+ will add proper async support)`
          );
        }

        return result;
      } catch (error) {
        // Re-throw RibosomeErrors as-is
        if (error instanceof Error && error.name === "RibosomeError") {
          throw error;
        }
        // Re-throw UnresolvedDependenciesError for validation short-circuit
        if (error instanceof Error && error.name === "UnresolvedDependenciesError") {
          throw error;
        }
        // Wrap other errors, including the cause message for debuggability
        const causeMsg = error instanceof Error ? error.message : String(error);
        throw hostFunctionError(`${name}: ${causeMsg}`, error);
      } finally {
        recordHostFunction(name, performance.now() - start);
      }
    };
  };
}
