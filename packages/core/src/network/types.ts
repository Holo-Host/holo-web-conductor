/**
 * Network Service Types
 *
 * Defines interfaces for network data retrieval, used by the cascade pattern.
 * These types abstract the network layer so it can be mocked for testing
 * or implemented with sync XHR in the offscreen document.
 */

import type {
  ActionHash,
  EntryHash,
  DnaHash,
  AnyDhtHash,
  Record,
  Link,
  SignedActionHashed,
  Entry,
} from '../types/holochain-types';

/**
 * Network record - a record fetched from the network
 * This is the same as a local Record but may come from remote peers
 */
export interface NetworkRecord {
  signed_action: SignedActionHashed;
  entry: NetworkEntry;
}

/**
 * Entry variants for network records
 */
export type NetworkEntry =
  | { Present: Entry }
  | 'Hidden'
  | 'NotApplicable'
  | 'NotStored';

/**
 * Network link - a link fetched from the network
 */
export interface NetworkLink {
  /** The create_link action that created this link */
  create_link_hash: ActionHash;
  /** Base address */
  base: AnyDhtHash;
  /** Target address */
  target: AnyDhtHash;
  /** Link type index */
  zome_index: number;
  link_type: number;
  /** Optional tag data */
  tag: Uint8Array;
  /** Timestamp of creation */
  timestamp: number;
  /** Author of the link */
  author: Uint8Array;
}

/**
 * Options for network fetch operations
 */
export interface NetworkFetchOptions {
  /** Timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Whether to cache the result (default: true) */
  cache?: boolean;
}

/**
 * Network service interface
 *
 * Implementations:
 * - MockNetworkService: For unit testing
 * - SyncXHRNetworkService: For offscreen document with sync XHR
 * - AsyncNetworkService: For future async implementations (JSPI)
 */
export interface NetworkService {
  /**
   * Fetch a record by hash (synchronous version for WASM host functions)
   * Returns null if not found
   */
  getRecordSync(
    dnaHash: DnaHash,
    hash: AnyDhtHash,
    options?: NetworkFetchOptions
  ): NetworkRecord | null;

  /**
   * Fetch links by base address (synchronous version)
   * Returns empty array if none found
   */
  getLinksSync(
    dnaHash: DnaHash,
    baseAddress: AnyDhtHash,
    linkType?: number,
    options?: NetworkFetchOptions
  ): NetworkLink[];

  /**
   * Check if the network service is available
   */
  isAvailable(): boolean;

  /**
   * Get the gateway URL (for debugging/logging)
   */
  getGatewayUrl(): string | null;
}

/**
 * Async network service interface (for future use with JSPI)
 */
export interface AsyncNetworkService {
  /**
   * Fetch a record by hash (async version)
   */
  getRecord(
    dnaHash: DnaHash,
    hash: AnyDhtHash,
    options?: NetworkFetchOptions
  ): Promise<NetworkRecord | null>;

  /**
   * Fetch links by base address (async version)
   */
  getLinks(
    dnaHash: DnaHash,
    baseAddress: AnyDhtHash,
    linkType?: number,
    options?: NetworkFetchOptions
  ): Promise<NetworkLink[]>;

  /**
   * Check if the network service is available
   */
  isAvailable(): Promise<boolean>;
}

/**
 * Cache entry for network data
 */
export interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
  expiresAt: number;
}

/**
 * Network cache options
 */
export interface NetworkCacheOptions {
  /** Time-to-live in milliseconds (default: 5 minutes) */
  ttl?: number;
  /** Maximum number of entries (default: 1000) */
  maxEntries?: number;
}
