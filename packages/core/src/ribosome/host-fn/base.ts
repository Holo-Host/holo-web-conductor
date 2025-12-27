/**
 * Host Function Base Types
 *
 * Core types and utilities for implementing Holochain host functions.
 */

import { CallContext } from "../call-context";
import { hostFunctionError } from "../error";

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
 * - Must be synchronous (WASM imports can't be async)
 *   - libsodium is initialized before WASM instantiation (ribosome/index.ts)
 *   - Lair operations should be awaited before calling zome (Step 6+)
 */
export type HostFunctionImpl = (
  context: HostFunctionContext,
  inputPtr: number,
  inputLen: number
) => bigint;

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
      try {
        // Extract actual instance from reference
        if (!instanceRef.current) {
          throw new Error(`Host function ${name} called before WASM instantiation`);
        }

        const hostContext: HostFunctionContext = {
          callContext: context,
          instance: instanceRef.current,
        };
        return impl(hostContext, inputPtr, inputLen);
      } catch (error) {
        // Re-throw RibosomeErrors as-is
        if (error instanceof Error && error.name === "RibosomeError") {
          throw error;
        }
        // Wrap other errors
        throw hostFunctionError(name, error);
      }
    };
  };
}
