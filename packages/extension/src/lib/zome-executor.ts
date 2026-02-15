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

import type { ZomeCallRequest } from "@fishy/core/ribosome";

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
}

/**
 * WebSocket state as reported by the executor.
 */
export interface WsStateInfo {
  state: string;
  isConnected: boolean;
  registrations?: Array<{ dna_hash: string; agent_pubkey: string }>;
}

/**
 * Remote signal data forwarded from the gateway via the executor.
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
export type WsStateChangeCallback = (state: string) => void;

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

  /** Configure gateway network (URL + optional session token). */
  configureNetwork(config: { gatewayUrl: string; sessionToken?: string }): Promise<void>;

  /** Update the gateway session token. */
  updateSessionToken(token: string | null): Promise<void>;

  // --- Agent registration (for gateway signal forwarding) ---

  /** Register an agent for gateway signal forwarding. */
  registerAgent(dnaHashB64: string, agentPubKeyB64: string): Promise<void>;

  // --- Zome execution ---

  /** Execute a zome call. Returns result and any emitted signals. */
  executeZomeCall(contextId: string, request: ZomeCallRequest): Promise<ZomeCallResult>;

  // --- Records & publishing ---

  /** Get all records for a cell (used for republishing). */
  getAllRecords(dnaHash: number[], agentPubKey: number[]): Promise<{ records: any[] }>;

  /** Trigger publish queue processing for the given DNAs. */
  processPublishQueue(dnaHashes: number[][]): Promise<void>;

  // --- Gateway connectivity ---

  /** Disconnect the gateway WebSocket. */
  disconnectGateway(): Promise<void>;

  /** Reconnect the gateway WebSocket. */
  reconnectGateway(): Promise<void>;

  /** Query current WebSocket connection state. */
  getWebSocketState(): Promise<WsStateInfo>;

  // --- Events (executor → background) ---

  /** Register callback for incoming remote signals from the gateway. */
  onRemoteSignal(callback: RemoteSignalCallback): void;

  /** Register callback for sign requests (executor needs Lair signing from background). */
  onSignRequest(callback: SignRequestCallback): void;

  /** Register callback for WebSocket state changes. */
  onWebSocketStateChange(callback: WsStateChangeCallback): void;
}
