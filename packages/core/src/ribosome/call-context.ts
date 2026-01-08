/**
 * Call Context Types
 *
 * Defines the context and state for WASM function invocations.
 */

import type { DnaManifestRuntime } from '../types/bundle-types';
import type { StoredAction, StoredEntry } from '../storage/types';

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
 * Pending record for publishing
 */
export interface PendingRecord {
  /** The stored action */
  action: StoredAction;
  /** The stored entry (if applicable) */
  entry?: StoredEntry;
}

/**
 * Remote signal queued for delivery via kitsune2
 */
export interface QueuedRemoteSignal {
  /** Target agent public key (as number array for transport) */
  target_agent: number[];
  /** Serialized ZomeCallParams (as number array for transport) */
  zome_call_params: number[];
  /** Signature over the params (as number array for transport) */
  signature: number[];
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

  /** Remote signals queued for delivery via kitsune2 (populated by send_remote_signal host function) */
  remoteSignals?: QueuedRemoteSignal[];

  /** DNA manifest (from .happ bundle) */
  dnaManifest?: DnaManifestRuntime;

  /** Records created during this call (populated by create, update, delete, etc.) */
  pendingRecords?: PendingRecord[];
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

  /** DNA manifest (from .happ bundle) */
  dnaManifest?: DnaManifestRuntime;
}
