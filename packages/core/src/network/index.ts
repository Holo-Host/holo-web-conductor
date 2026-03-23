/**
 * Network Module
 *
 * Provides network data retrieval functionality for HWC.
 * Implements a cascade pattern: local storage → network cache → network.
 */

import type { NetworkService } from './types';

// Types
export type {
  NetworkService,
  AsyncNetworkService,
  NetworkRecord,
  NetworkLink,
  NetworkEntry,
  NetworkFetchOptions,
  CacheEntry,
  NetworkCacheOptions,
  AgentActivityResponse,
  MustGetAgentActivityResponse,
  RegisterAgentActivity,
  ChainStatus,
  ChainItems,
  HighestObserved,
} from './types';

// Cache
export { NetworkCache, getNetworkCache, resetNetworkCache } from './cache';

// Services
export { MockNetworkService } from './mock-service';
export {
  WebSocketNetworkService,
  getWebSocketService,
  initWebSocketService,
  type ClientMessage,
  type ServerMessage,
  type ConnectionState,
  type SignalCallback,
  type StateCallback,
  type WebSocketServiceOptions,
} from './websocket-service';

// Cascade
export { Cascade } from './cascade';
export type { CascadeOptions } from './cascade';

// GetStrategy mode: controls whether happ-provided GetStrategy is honored or forced to Network
export type GetStrategyMode = 'compatibility' | 'honor';
let getStrategyMode: GetStrategyMode = 'compatibility';

/**
 * Set the GetStrategy mode.
 * - 'compatibility' (default): forces all get/get_links to Network strategy,
 *   ignoring what the happ requests. Safe for happs not designed for zero-arc.
 * - 'honor': respects the happ's GetStrategy, enabling Local-first caching.
 */
export function setGetStrategyMode(mode: GetStrategyMode): void {
  getStrategyMode = mode;
  console.log('[Network] GetStrategy mode set:', mode);
}

export function getGetStrategyMode(): GetStrategyMode {
  return getStrategyMode;
}

export function resetGetStrategyMode(): void {
  getStrategyMode = 'compatibility';
}

// Global network service configuration
let globalNetworkService: NetworkService | null = null;

/**
 * Set the global network service for cascade lookups
 * Use this to inject MockNetworkService for testing
 */
export function setNetworkService(service: NetworkService | null): void {
  globalNetworkService = service;
  console.log('[Network] Global network service set:', service ? 'configured' : 'null');
}

/**
 * Get the current global network service
 */
export function getNetworkService(): NetworkService | null {
  return globalNetworkService;
}

/**
 * Reset network service to null (for testing)
 */
export function resetNetworkService(): void {
  globalNetworkService = null;
}
