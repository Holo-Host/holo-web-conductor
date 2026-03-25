/**
 * ZomeExecutor - abstraction over the WASM execution environment.
 *
 * Chrome: implemented via offscreen document + ribosome worker (ChromeOffscreenExecutor).
 * Firefox: will be implemented via background page worker (future).
 *
 * This interface isolates all Chrome-specific offscreen document management
 * behind a typed contract, allowing the background service worker to be
 * browser-agnostic.
 */

import type { ZomeCallRequest } from "@hwc/core/ribosome";

// ============================================================================
// Types
// ============================================================================

/**
 * Minimal zome call request sent through Chrome message passing.
 * WASM and manifest are fetched from shared IndexedDB by the executor.
 * Uint8Arrays are pre-converted to number[] for Chrome structured cloning.
 */
export interface MinimalZomeCallRequest {
  contextId: string;
  dnaHashBase64: string;
  cellId: [number[], number[]]; // [dnaHash, agentPubKey] as arrays
  zome: string;
  fn: string;
  payload: number[];
  provenance: number[];
}

/**
 * Result from a zome call execution.
 */
export interface ZomeCallResult {
  result: unknown;
  signals: any[];
  didWrite?: boolean;
}

/**
 * Result from a chain recovery operation.
 */
export interface RecoveryResult {
  recoveredCount: number;
  failedCount: number;
  verifiedCount: number;
  unverifiedCount: number;
  errors: string[];
}

/**
 * WebSocket state as reported by the executor.
 */
export interface WsStateInfo {
  state: string;
  isConnected: boolean;
  authenticated: boolean;
  registrations?: Array<{ dna_hash: string; agent_pubkey: string }>;
  peerCount?: number;
}

/**
 * Remote signal data forwarded from the linker via the executor.
 */
export interface RemoteSignalData {
  dna_hash: string;
  to_agent: string;
  from_agent: string;
  zome_name: string;
  signal: number[];
}

/**
 * Sign request from the executor (needs Lair access in background).
 */
export interface SignRequestData {
  agent_pubkey: number[];
  message: number[];
}

/**
 * Sign response returned to the executor.
 */
export interface SignResponseData {
  success: boolean;
  signature?: number[];
  error?: string;
}

// ============================================================================
// Callback types
// ============================================================================

export type RemoteSignalCallback = (data: RemoteSignalData) => void;
export type SignRequestCallback = (data: SignRequestData) => Promise<SignResponseData>;
export type WsStateChangeCallback = (state: string, authenticated: boolean) => void;
export type SessionTokenCallback = (token: string) => void;

// ============================================================================
// Interface
// ============================================================================

export interface ZomeExecutor {
  // --- Lifecycle ---

  /** Ensure the executor is initialized and ready to accept calls. */
  initialize(): Promise<void>;

  /** Check if the executor is ready. */
  isReady(): boolean;

  /** Whether the network has been configured on the executor. */
  readonly networkConfigured: boolean;

  // --- Network configuration ---

  /** Configure linker network (URL + optional session token). */
  configureNetwork(config: { linkerUrl: string; sessionToken?: string }): Promise<void>;

  /** Update the linker session token. */
  updateSessionToken(token: string | null): Promise<void>;

  // --- Agent registration (for linker signal forwarding) ---

  /** Register an agent for linker signal forwarding. */
  registerAgent(dnaHashB64: string, agentPubKeyB64: string): Promise<void>;

  // --- Zome execution ---

  /** Execute a zome call. Returns result and any emitted signals. */
  executeZomeCall(contextId: string, request: ZomeCallRequest): Promise<ZomeCallResult>;

  // --- Records & publishing ---

  /** Get all records for a cell (used for republishing). */
  getAllRecords(dnaHash: number[], agentPubKey: number[]): Promise<{ records: any[] }>;

  /** Trigger publish queue processing for the given DNAs. */
  processPublishQueue(dnaHashes: number[][]): Promise<void>;

  // --- Genesis ---

  /**
   * Run genesis_self_check + initializeGenesis for a cell with the given membrane proof.
   * Throws if genesis_self_check returns Invalid.
   */
  runGenesis(
    cellId: [number[], number[]],
    dnaWasm: number[],
    dnaManifest: unknown,
    membraneProof: number[] | null,
  ): Promise<{ pendingRecords: any[] }>;

  // --- Chain recovery ---

  /** Recover chain actions from the network for a hApp context. */
  recoverChain(
    contextId: string,
    dnaHashes: number[][],
    agentPubKey: number[]
  ): Promise<{ recoveredCount: number; failedCount: number; errors: string[] }>;

  // --- Linker connectivity ---

  /** Disconnect the linker WebSocket. */
  disconnectLinker(): Promise<void>;

  /** Reconnect the linker WebSocket. */
  reconnectLinker(): Promise<void>;

  /** Query current WebSocket connection state. */
  getWebSocketState(): Promise<WsStateInfo>;

  // --- Signing key preload (Firefox) ---

  /**
   * Tell the executor to preload a signing key in its worker.
   * On Chrome (offscreen executor), this is a no-op — signing uses SharedArrayBuffer roundtrip.
   * On Firefox, the worker creates its own LairClient from IndexedDB and calls
   * preloadKeyForSync() with the given public key. No secret key crosses the boundary.
   */
  preloadSigningKey?(pubKey: Uint8Array): Promise<void>;

  /**
   * Send the master encryption key to the worker for encrypted storage access.
   * On Chrome this is undefined — the worker doesn't access IndexedDB directly.
   * On Firefox, the worker needs the key to decrypt seeds from shared IndexedDB.
   */
  sendMasterKeyToWorker?(masterKey: Uint8Array): Promise<void>;

  /**
   * Tell the worker to clear its master encryption key and preloaded signing keys.
   */
  clearWorkerMasterKey?(): Promise<void>;

  // --- Events (executor → background) ---

  /** Register callback for incoming remote signals from the linker. */
  onRemoteSignal(callback: RemoteSignalCallback): void;

  /** Register callback for sign requests (executor needs Lair signing from background). */
  onSignRequest(callback: SignRequestCallback): void;

  /** Register callback for WebSocket state changes. */
  onWebSocketStateChange(callback: WsStateChangeCallback): void;

  /** Register callback for session token changes (from WS auth). */
  onSessionToken(callback: SessionTokenCallback): void;
}
