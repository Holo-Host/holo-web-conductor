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
 * Signal emitted during zome execution
 */
export interface EmittedSignal {
  /** Cell ID that emitted the signal */
  cell_id: CellId;

  /** Zome that emitted the signal */
  zome_name: string;

  /** Signal payload (msgpack-encoded bytes) */
  signal: Uint8Array;

  /** Timestamp when signal was emitted */
  timestamp: number;
}

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

  /** Payload for the function (will be serialized when passed to WASM) */
  payload: unknown;

  /** Agent making the call (provenance) */
  provenance: Uint8Array;

  /** Signals emitted during this call (populated by emit_signal host function) */
  emittedSignals?: EmittedSignal[];
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

  /** Payload to serialize and pass to the zome function */
  payload: unknown;

  /** Agent making the call */
  provenance: Uint8Array;
}
