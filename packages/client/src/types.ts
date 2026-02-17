/**
 * Type definitions for the Web Conductor client library.
 */

import type { ConnectionState } from './connection/types';

/**
 * The window.holochain API provided by the Web Conductor extension.
 */
export interface HolochainAPI {
  /** Always true for Web Conductor extension */
  isWebConductor: boolean;
  /** Extension version */
  version: string;
  /** Current agent's public key (if connected) */
  myPubKey: Uint8Array | null;
  /** Current installed app ID (if connected) */
  installedAppId: string | null;

  // Core API
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  callZome(params: CallZomeParams): Promise<unknown>;
  appInfo(installedAppId?: string): Promise<WebConductorAppInfo | null>;
  installApp(request: InstallAppRequest): Promise<void>;

  // Signal handling
  on(event: 'signal', callback: (signal: unknown) => void): () => void;

  // Network configuration
  configureNetwork(config: { linkerUrl: string }): Promise<void>;

  // Connection status (real-time health monitoring)
  getConnectionStatus(): Promise<{
    httpHealthy: boolean;
    wsHealthy: boolean;
    linkerUrl: string | null;
    lastChecked: number;
    lastError?: string;
  }>;
  onConnectionChange(callback: (status: {
    httpHealthy: boolean;
    wsHealthy: boolean;
    linkerUrl: string | null;
    lastChecked: number;
    lastError?: string;
  }) => void): () => void;
  reconnectWebSocket?(): Promise<void>;
}

/**
 * Parameters for calling a zome function.
 */
export interface CallZomeParams {
  cell_id: [Uint8Array, Uint8Array];
  zome_name: string;
  fn_name: string;
  payload?: unknown;
  provenance?: Uint8Array;
  cap_secret?: Uint8Array;
}

/**
 * Request to install a hApp.
 */
export interface InstallAppRequest {
  bundle: Uint8Array | number[];
  installedAppId?: string;
}

/**
 * App info returned by Web Conductor extension.
 */
export interface WebConductorAppInfo {
  contextId: string;
  agentPubKey: Uint8Array | number[];
  cells: Array<[Uint8Array | number[], Uint8Array | number[]]>;
  /** DNA properties keyed by DNA name (raw objects from manifest) */
  dnaProperties?: Record<string, Record<string, unknown>>;
}

declare global {
  interface Window {
    holochain?: HolochainAPI;
  }
}
