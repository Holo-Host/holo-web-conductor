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
 * - Receive pointer to serialized input (MessagePack)
 * - Return i64 with ptr in high 32 bits, len in low 32 bits
 */
export type HostFunctionImpl = (
  context: HostFunctionContext,
  inputPtr: number
) => bigint;

/**
 * Wrap a host function with error handling
 *
 * @param name - Host function name for error reporting
 * @param impl - Host function implementation
 * @returns Wrapped function with error handling
 */
export function wrapHostFunction(
  name: string,
  impl: HostFunctionImpl
): (instance: WebAssembly.Instance, context: CallContext) => (ptr: number) => bigint {
  return (instance: WebAssembly.Instance, context: CallContext) => {
    return (inputPtr: number): bigint => {
      try {
        const hostContext: HostFunctionContext = {
          callContext: context,
          instance,
        };
        return impl(hostContext, inputPtr);
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
