/**
 * Call Context Types
 *
 * Defines the context and state for WASM function invocations.
 */

/**
 * Cell ID: [DNA hash, Agent public key]
 */
export type CellId = [Uint8Array, Uint8Array];

/**
 * Context for a zome call invocation
 */
export interface CallContext {
  /** Cell ID [DNA hash, Agent pub key] */
  cellId: CellId;

  /** Name of the zome being called */
  zome: string;

  /** Name of the function being called */
  fn: string;

  /** Serialized payload for the function */
  payload: Uint8Array;

  /** Agent making the call (provenance) */
  provenance: Uint8Array;
}

/**
 * State tracked during a zome call invocation
 */
export interface InvocationState {
  /** The call context */
  context: CallContext;

  /** WASM instance for this invocation */
  instance: WebAssembly.Instance;

  /** Start time of invocation (for performance tracking) */
  startTime: number;
}

/**
 * Request to call a zome function
 */
export interface ZomeCallRequest {
  /** DNA WASM bytes */
  dnaWasm: Uint8Array;

  /** Cell ID [DNA hash, Agent pub key] */
  cellId: CellId;

  /** Zome name */
  zome: string;

  /** Function name */
  fn: string;

  /** Serialized payload */
  payload: Uint8Array;

  /** Agent making the call */
  provenance: Uint8Array;
}
