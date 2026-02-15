/**
 * Ribosome Error Types
 *
 * Defines error types for WASM execution and host function failures.
 */

/**
 * Types of ribosome errors
 */
export enum RibosomeErrorType {
  WasmCompilationFailed = "WasmCompilationFailed",
  WasmInstantiationFailed = "WasmInstantiationFailed",
  ZomeFunctionNotFound = "ZomeFunctionNotFound",
  HostFunctionError = "HostFunctionError",
  SerializationError = "SerializationError",
  DeserializationError = "DeserializationError",
  MemoryAllocationFailed = "MemoryAllocationFailed",
}

/**
 * Ribosome error class
 */
export class RibosomeError extends Error {
  constructor(
    public type: RibosomeErrorType,
    message: string,
    public cause?: unknown
  ) {
    super(message);
    this.name = "RibosomeError";
  }
}

/**
 * Create a ribosome error for WASM compilation failure
 */
export function wasmCompilationError(cause: unknown): RibosomeError {
  return new RibosomeError(
    RibosomeErrorType.WasmCompilationFailed,
    "Failed to compile WASM module",
    cause
  );
}

/**
 * Create a ribosome error for WASM instantiation failure
 */
export function wasmInstantiationError(cause: unknown): RibosomeError {
  return new RibosomeError(
    RibosomeErrorType.WasmInstantiationFailed,
    "Failed to instantiate WASM module",
    cause
  );
}

/**
 * Create a ribosome error for zome function not found
 */
export function zomeFunctionNotFoundError(zome: string, fn: string): RibosomeError {
  return new RibosomeError(
    RibosomeErrorType.ZomeFunctionNotFound,
    `Function '${fn}' not found in zome '${zome}'`
  );
}

/**
 * Create a ribosome error for host function errors
 */
export function hostFunctionError(message: string, cause?: unknown): RibosomeError {
  return new RibosomeError(
    RibosomeErrorType.HostFunctionError,
    message,
    cause
  );
}

/**
 * Create a ribosome error for serialization errors
 */
export function serializationError(message: string, cause?: unknown): RibosomeError {
  return new RibosomeError(
    RibosomeErrorType.SerializationError,
    message,
    cause
  );
}

/**
 * Create a ribosome error for deserialization errors
 */
export function deserializationError(message: string, cause?: unknown): RibosomeError {
  return new RibosomeError(
    RibosomeErrorType.DeserializationError,
    message,
    cause
  );
}

/**
 * Create a ribosome error for memory allocation failures
 */
export function memoryAllocationError(): RibosomeError {
  return new RibosomeError(
    RibosomeErrorType.MemoryAllocationFailed,
    "WASM memory allocation failed"
  );
}

/**
 * Error thrown by must_get_* host functions when data is not found
 * during a validation context. This short-circuits the validate callback
 * and converts to ValidateCallbackResult::UnresolvedDependencies.
 *
 * Equivalent to Holochain's WasmErrorInner::HostShortCircuit mechanism.
 */
export class UnresolvedDependenciesError extends Error {
  constructor(public dependencies: import("../dht/validate-types").UnresolvedDependencies) {
    super("Unresolved dependencies during validation");
    this.name = "UnresolvedDependenciesError";
  }
}
