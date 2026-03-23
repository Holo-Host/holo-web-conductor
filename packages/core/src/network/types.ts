/**
 * Network Service Types
 *
 * Defines interfaces for network data retrieval, used by the cascade pattern.
 * These types abstract the network layer so it can be mocked for testing
 * or implemented with direct XHR in the ribosome worker.
 */

import type {
  ActionHash,
  EntryHash,
  DnaHash,
  AnyDhtHash,
  AgentPubKey,
  Record,
  Link,
  SignedActionHashed,
  Signature,
  Entry,
  Timestamp,
  LinkTag,
} from '../types/holochain-types';
import type { RateWeight } from '../types/holochain-serialization';

// ============================================================================
// Agent Activity types (matching Holochain wire protocol responses)
// ============================================================================

/**
 * Chain status for an agent's chain.
 * Matches holochain_zome_types::query::ChainStatus
 */
export type ChainStatus =
  | 'Empty'
  | { Valid: ChainHead }
  | { Forked: ChainFork }
  | { Invalid: ChainHead };

export interface ChainHead {
  action_seq: number;
  hash: ActionHash;
}

export interface ChainFork {
  fork_seq: number;
  first_action: ActionHash;
  second_action: ActionHash;
}

export interface HighestObserved {
  action_seq: number;
  hash: ActionHash[];
}

/**
 * Chain items in activity response.
 * Matches holochain_types::activity::ChainItems
 */
export type ChainItems =
  | { Full: any[] }
  | { Hashes: Array<[number, ActionHash]> }
  | 'NotRequested';

/**
 * Agent activity response from the network.
 * Matches holochain_types::activity::AgentActivityResponse
 */
export interface AgentActivityResponse {
  agent: AgentPubKey;
  valid_activity: ChainItems;
  rejected_activity: ChainItems;
  status: ChainStatus;
  highest_observed: HighestObserved | null;
  warrants: any[];
}

/**
 * RegisterAgentActivity from must_get_agent_activity.
 * Matches holochain_integrity_types::op::RegisterAgentActivity
 */
export interface RegisterAgentActivity {
  action: SignedActionHashed;
  cached_entry: Entry | null;
}

/**
 * Must-get agent activity response variants.
 * Matches holochain_types::chain::MustGetAgentActivityResponse
 */
export type MustGetAgentActivityResponse =
  | { Activity: { activity: RegisterAgentActivity[]; warrants: any[] } }
  | 'IncompleteChain'
  | { ChainTopNotFound: ActionHash }
  | 'EmptyRange';

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
  tag: LinkTag;
  /** Timestamp of creation (microseconds since epoch) */
  timestamp: Timestamp;
  /** Author of the link */
  author: AgentPubKey;
  /** Previous action hash (from WireCreateLink; absent for locally-stored links) */
  prev_action?: ActionHash;
  /** Signature of the CreateLink action (from WireCreateLink; absent for locally-stored links) */
  signature?: Signature;
  /** Action sequence number (from WireCreateLink; absent for locally-stored links) */
  action_seq?: number;
  /** Rate weight (from WireCreateLink; absent for locally-stored links) */
  weight?: RateWeight;
}

/**
 * Cached link detail - a CreateLink with its associated DeleteLink hashes.
 * LinkDetails are monotonically growing: creates and deletes only ever
 * accumulate, never shrink. This makes them safe to cache with LRU/no-TTL.
 */
export interface CachedLinkDetail {
  /** The CreateLink data */
  create: NetworkLink;
  /** DeleteLink action hashes (monotonically growing set) */
  deleteHashes: Uint8Array[];
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
   * @param zomeIndex - Optional zome index for filtering. Required when linkType is specified.
   */
  getLinksSync(
    dnaHash: DnaHash,
    baseAddress: AnyDhtHash,
    linkType?: number,
    zomeIndex?: number,
    options?: NetworkFetchOptions
  ): NetworkLink[];

  /**
   * Fetch record details by hash (synchronous version)
   * Returns null if not found
   */
  getDetailsSync(
    dnaHash: DnaHash,
    hash: AnyDhtHash,
    options?: NetworkFetchOptions
  ): any | null;

  /**
   * Count links by base address (synchronous version)
   * Returns 0 if none found
   */
  countLinksSync(
    dnaHash: DnaHash,
    baseAddress: AnyDhtHash,
    linkType?: number,
    zomeIndex?: number,
    options?: NetworkFetchOptions
  ): number;

  /**
   * Fetch agent activity by agent pubkey (synchronous version)
   * Returns null if not found or network unavailable
   */
  getAgentActivitySync(
    dnaHash: DnaHash,
    agentPubKey: AgentPubKey,
    activityRequest: 'status' | 'full',
    options?: NetworkFetchOptions
  ): AgentActivityResponse | null;

  /**
   * Fetch agent activity with must-get semantics (synchronous version)
   * Returns null if not found or network unavailable
   */
  mustGetAgentActivitySync(
    dnaHash: DnaHash,
    agent: AgentPubKey,
    chainTop: ActionHash,
    includeCachedEntries: boolean,
    options?: NetworkFetchOptions
  ): MustGetAgentActivityResponse | null;

  /**
   * Check if the network service is available
   */
  isAvailable(): boolean;

  /**
   * Get the linker URL (for debugging/logging)
   */
  getLinkerUrl(): string | null;
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
  /** Max record cache entries (default: 10000). Records are LRU, no TTL (immutable). */
  recordMaxEntries?: number;
  /** Max link cache entries (default: 5000). Links are LRU, no TTL. */
  linkMaxEntries?: number;
  /** Max link details cache entries (default: 5000). Link details are LRU, no TTL (monotonically growing). */
  linkDetailsMaxEntries?: number;
  /** Max details cache entries (default: 1000). Details use TTL. */
  detailsMaxEntries?: number;
  /** Details TTL in milliseconds (default: 2 minutes) */
  detailsTtl?: number;
  /** @deprecated Use linkMaxEntries. Legacy: mapped to linkMaxEntries. */
  maxEntries?: number;
  /** @deprecated Use detailsTtl. Legacy: mapped to detailsTtl. */
  ttl?: number;
}
