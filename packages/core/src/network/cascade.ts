/**
 * Cascade - Data Retrieval with Local-First Strategy
 *
 * Implements the cascade pattern for fetching data:
 * 1. Local source chain (session cache - synchronous)
 * 2. Network cache (in-memory - synchronous)
 * 3. Network (via gateway - synchronous XHR in offscreen document)
 *
 * This mirrors Holochain's holochain_cascade crate behavior.
 */

import type {
  NetworkService,
  NetworkRecord,
  NetworkLink,
  NetworkEntry,
} from './types';
import type { NetworkCache } from './cache';
import type { SourceChainStorage } from '../storage';
import type {
  DnaHash,
  AnyDhtHash,
  SignedActionHashed,
  Entry,
} from '../types/holochain-types';

/**
 * Cascade options
 */
export interface CascadeOptions {
  /** Whether to use network if local data not found (default: true) */
  useNetwork?: boolean;
  /** Whether to cache network results (default: true) */
  cacheNetworkResults?: boolean;
}

const DEFAULT_OPTIONS: Required<CascadeOptions> = {
  useNetwork: true,
  cacheNetworkResults: true,
};

/**
 * Cascade - Local-first data retrieval
 *
 * Usage:
 * ```typescript
 * const cascade = new Cascade(storage, cache, networkService);
 *
 * // Fetch a record (tries local first, then network)
 * const record = cascade.fetchRecord(dnaHash, agentPubKey, hash);
 *
 * // Fetch links
 * const links = cascade.fetchLinks(dnaHash, baseAddress);
 * ```
 */
export class Cascade {
  private storage: SourceChainStorage;
  private cache: NetworkCache;
  private network: NetworkService | null;
  private options: Required<CascadeOptions>;

  constructor(
    storage: SourceChainStorage,
    cache: NetworkCache,
    network: NetworkService | null,
    options?: CascadeOptions
  ) {
    this.storage = storage;
    this.cache = cache;
    this.network = network;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Convert a stored record to network record format
   * Note: Uses 'any' for flexible type handling between local and network formats
   */
  private storedToNetworkRecord(stored: any): NetworkRecord {
    // StoredRecord has: action (our internal Action type), entry (StoredEntry)
    // Build a minimal SignedActionHashed structure
    const signedAction: SignedActionHashed = {
      hashed: {
        content: stored.action as any,
        hash: stored.actionHash,
      },
      signature: stored.action?.signature || new Uint8Array(64),
    };

    let entry: NetworkEntry = 'NotApplicable';
    if (stored.entry) {
      // StoredEntry has entryContent (Uint8Array), entryType
      // Convert to Entry format that WASM expects: { entry_type: "App", entry: content }
      const entryType = stored.entry.entryType;
      let entryValue: Entry;
      if (entryType === 'Agent') {
        entryValue = { entry_type: 'Agent', entry: stored.entry.entryContent };
      } else {
        // AppEntryType or other - treat as App entry
        entryValue = { entry_type: 'App', entry: stored.entry.entryContent };
      }
      entry = { Present: entryValue };
    }

    return {
      signed_action: signedAction,
      entry,
    };
  }

  /**
   * Fetch a record by hash using cascade pattern
   *
   * Order:
   * 1. Local session cache (synchronous if pre-loaded)
   * 2. Network cache
   * 3. Network (if enabled and available)
   *
   * @param dnaHash - DNA hash for network requests
   * @param hash - Action or entry hash to fetch
   * @param options - Cascade options
   * @returns NetworkRecord if found, null otherwise
   */
  fetchRecord(
    dnaHash: DnaHash,
    hash: AnyDhtHash,
    options?: CascadeOptions
  ): NetworkRecord | null {
    const opts = { ...this.options, ...options };

    console.log(`[Cascade] Fetching record: ${this.hashToShortString(hash)}`);

    // 1. Try local storage (session cache is synchronous)
    const record = this.buildRecordFromLocal(hash);
    if (record !== null) {
      console.log(`[Cascade] Found in local storage`);
      return record;
    }

    // 2. Try network cache
    const cached = this.cache.getRecordSync(hash);
    if (cached !== null) {
      console.log(`[Cascade] Found in network cache`);
      return cached;
    }

    // 3. Try network (if enabled)
    if (opts.useNetwork && this.network && this.network.isAvailable()) {
      console.log(`🌐 [Cascade] Fetching from NETWORK (local lookup failed)`);
      try {
        const networkRecord = this.network.getRecordSync(dnaHash, hash);
        if (networkRecord !== null) {
          console.log(`🌐 [Cascade] Found in NETWORK - this is why it's slow!`);
          if (opts.cacheNetworkResults) {
            this.cache.cacheRecordSync(hash, networkRecord);
          }
          return networkRecord;
        }
      } catch (error) {
        console.warn(`[Cascade] Network fetch failed:`, error);
        // Continue - network failure shouldn't break the cascade
      }
    }

    console.log(`[Cascade] Record not found`);
    return null;
  }

  /**
   * Build a record from local storage (synchronous from session cache)
   */
  private buildRecordFromLocal(hash: AnyDhtHash): NetworkRecord | null {
    // Try to get action synchronously from session cache
    const actionResult = this.storage.getAction(hash);

    if (actionResult === null || actionResult instanceof Promise) {
      return null;
    }


    const action = actionResult as any;

    // Get entry if applicable
    let entry: NetworkEntry = 'NotApplicable';
    if ('entryHash' in action && action.entryHash) {
      const entryResult = this.storage.getEntry(action.entryHash);
      if (entryResult && !(entryResult instanceof Promise)) {
        // Convert StoredEntry to Entry format that WASM expects: { entry_type: "App", entry: content }
        const storedEntry = entryResult;
        const entryType = storedEntry.entryType;
        let entryValue: Entry;
        if (entryType === 'Agent') {
          entryValue = { entry_type: 'Agent', entry: storedEntry.entryContent };
        } else {
          entryValue = { entry_type: 'App', entry: storedEntry.entryContent };
        }
        entry = { Present: entryValue };
      }
    }

    // Build a minimal signed action structure
    // Note: In the session cache, we store decoded actions, not full SignedActionHashed
    const signedAction: SignedActionHashed = {
      hashed: {
        content: action as any,
        hash: hash,
      },
      signature: action.signature || new Uint8Array(64),
    };

    return {
      signed_action: signedAction,
      entry,
    };
  }

  /**
   * Fetch links by base address using cascade pattern
   *
   * Order:
   * 1. Local storage (links created in this session)
   * 2. Network cache
   * 3. Network (if enabled and available)
   *
   * Note: This requires agentPubKey for the storage API.
   *
   * @param dnaHash - DNA hash for network requests
   * @param agentPubKey - Agent public key for storage lookup
   * @param baseAddress - Base address to fetch links for
   * @param linkType - Optional link type filter
   * @param options - Cascade options
   * @returns Array of links (may be empty)
   */
  fetchLinks(
    dnaHash: DnaHash,
    agentPubKey: Uint8Array,
    baseAddress: AnyDhtHash,
    linkType?: number,
    options?: CascadeOptions
  ): NetworkLink[] {
    const opts = { ...this.options, ...options };

    console.log(`[Cascade] Fetching links for: ${this.hashToShortString(baseAddress)}`);

    // Collect links from all sources
    const allLinks: NetworkLink[] = [];

    // 1. Try local storage (synchronous from session cache)
    const localResult = this.storage.getLinks(baseAddress, dnaHash, agentPubKey, linkType);

    // Check if result is synchronous (from session cache)
    if (!(localResult instanceof Promise)) {
      const localLinks = localResult;
      if (localLinks.length > 0) {
        console.log(`[Cascade] Found ${localLinks.length} links in local storage`);
        // Convert to NetworkLink format
        allLinks.push(...localLinks.map(l => this.storedLinkToNetworkLink(l)));
      }
    }

    // 2. Try network cache
    const cached = this.cache.getLinksSync(baseAddress, linkType);
    if (cached !== null && cached.length > 0) {
      console.log(`[Cascade] Found ${cached.length} links in network cache`);
      // Merge with local, avoiding duplicates
      for (const link of cached) {
        if (!allLinks.some(l => this.linksEqual(l, link))) {
          allLinks.push(link);
        }
      }
    }

    // 3. Try network (if enabled and local is empty or we want to ensure freshness)
    if (opts.useNetwork && this.network && this.network.isAvailable()) {
      // Only fetch from network if we have no local links
      // (In a full implementation, we might always fetch to ensure consistency)
      if (allLinks.length === 0) {
        console.log(`[Cascade] Fetching links from network`);
        try {
          const networkLinks = this.network.getLinksSync(dnaHash, baseAddress, linkType);
          if (networkLinks.length > 0) {
            console.log(`[Cascade] Found ${networkLinks.length} links in network`);
            if (opts.cacheNetworkResults) {
              this.cache.cacheLinksSync(baseAddress, networkLinks, linkType);
            }
            allLinks.push(...networkLinks);
          }
        } catch (error) {
          console.warn(`[Cascade] Network link fetch failed:`, error);
        }
      }
    }

    console.log(`[Cascade] Returning ${allLinks.length} total links`);
    return allLinks;
  }

  /**
   * Convert a stored link to network link format
   */
  private storedLinkToNetworkLink(stored: any): NetworkLink {
    return {
      create_link_hash: stored.createLinkHash || stored.create_link_hash,
      base: stored.base || stored.baseAddress,
      target: stored.target || stored.targetAddress,
      zome_index: stored.zome_index || stored.zomeIndex || 0,
      link_type: stored.link_type || stored.linkType || 0,
      tag: stored.tag || new Uint8Array(0),
      timestamp: stored.timestamp || Date.now() * 1000,
      author: stored.author || new Uint8Array(39),
    };
  }

  /**
   * Check if two links are equal (same create_link_hash)
   */
  private linksEqual(a: NetworkLink, b: NetworkLink): boolean {
    if (a.create_link_hash.length !== b.create_link_hash.length) {
      return false;
    }
    return a.create_link_hash.every((byte, i) => byte === b.create_link_hash[i]);
  }

  /**
   * Convert hash to short string for logging
   */
  private hashToShortString(hash: Uint8Array): string {
    const b64 = btoa(String.fromCharCode(...hash.slice(0, 8)));
    return b64.substring(0, 8) + '...';
  }

  /**
   * Invalidate cached data for a hash
   */
  invalidate(hash: AnyDhtHash): void {
    this.cache.invalidateRecord(hash);
  }

  /**
   * Invalidate cached links for a base address
   */
  invalidateLinks(baseAddress: AnyDhtHash, linkType?: number): void {
    this.cache.invalidateLinks(baseAddress, linkType);
  }

  /**
   * Check if network is available
   */
  isNetworkAvailable(): boolean {
    return this.network !== null && this.network.isAvailable();
  }
}
