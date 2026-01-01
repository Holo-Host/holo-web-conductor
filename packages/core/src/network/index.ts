/**
 * Network Module
 *
 * Provides network data retrieval functionality for fishy.
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
} from './types';

// Cache
export { NetworkCache, getNetworkCache, resetNetworkCache } from './cache';

// Services
export { MockNetworkService } from './mock-service';
export { SyncXHRNetworkService } from './sync-xhr-service';
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

// Global network service configuration
let globalNetworkService: NetworkService | null = null;

/**
 * Set the global network service for cascade lookups
 * Use this to inject MockNetworkService for testing or SyncXHRNetworkService for production
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
