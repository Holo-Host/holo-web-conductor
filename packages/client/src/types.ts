/**
 * Type definitions for the Fishy client library.
 */

import type { ConnectionState } from './connection/types';

/**
 * The window.holochain API provided by Fishy extension.
 */
export interface FishyHolochainAPI {
  /** Always true for Fishy extension */
  isFishy: boolean;
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
  appInfo(installedAppId?: string): Promise<FishyAppInfo | null>;
  installApp(request: InstallAppRequest): Promise<void>;

  // Signal handling
  on(event: 'signal', callback: (signal: unknown) => void): () => void;

  // Network configuration
  configureNetwork(config: { gatewayUrl: string }): Promise<void>;

  // Connection status (real-time health monitoring)
  getConnectionStatus(): Promise<{
    httpHealthy: boolean;
    wsHealthy: boolean;
    gatewayUrl: string | null;
    lastChecked: number;
    lastError?: string;
  }>;
  onConnectionChange(callback: (status: {
    httpHealthy: boolean;
    wsHealthy: boolean;
    gatewayUrl: string | null;
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
 * App info returned by Fishy extension.
 */
export interface FishyAppInfo {
  contextId: string;
  agentPubKey: Uint8Array | number[];
  cells: Array<[Uint8Array | number[], Uint8Array | number[]]>;
}

declare global {
  interface Window {
    holochain?: FishyHolochainAPI;
  }
}
