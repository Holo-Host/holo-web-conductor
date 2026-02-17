/**
 * Cascade - Data Retrieval with Local-First Strategy
 *
 * Implements the cascade pattern for fetching data:
 * 1. Local source chain (session cache - synchronous)
 * 2. Network cache (in-memory - synchronous)
 * 3. Network (via linker - synchronous XHR in offscreen document)
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
import type { StorageProvider } from '../storage/storage-provider';
import type { Link as StoredLink } from '../storage/types';
import {
  isEntryHash,
  isActionHash,
  type DnaHash,
  type AnyDhtHash,
  type SignedActionHashed,
  type Entry,
} from '../types/holochain-types';
import { createLogger } from '@hwc/shared';

const log = createLogger('Cascade');

// NOTE: Circuit breaker was removed. Zero-arc nodes MUST always reach the
// network — they have no local data for other agents. A global breaker that
// silenced all network calls after a single slow response caused hashtag
// search (and any multi-hop path traversal) to return empty results.
// If slow-network protection is needed in the future, it should be scoped
// per-base-address or per-zome-call, not global.

/**
 * Cascade options
 */
export interface CascadeOptions {
  /** Whether to use network if local data not found (default: true) */
  useNetwork?: boolean;
  /** Whether to cache network results (default: true) */
  cacheNetworkResults?: boolean;
}

/**
 * Link type filter with separate zome_index and link_type
 */
export interface LinkTypeFilter {
  zomeIndex?: number;
  linkType?: number;
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
  private storage: StorageProvider;
  private cache: NetworkCache;
  private network: NetworkService | null;
  private options: Required<CascadeOptions>;

  constructor(
    storage: StorageProvider,
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
   * Fetch a record by hash using cascade pattern
   *
   * Order:
   * 1. Local session cache (synchronous if pre-loaded)
   * 2. Network cache
   * 3. Network (if enabled and available)
   *
   * Handles both action hashes and entry hashes:
   * - Action hash: fetches the specific action and its entry
   * - Entry hash: finds an action that created this entry
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

    // Determine hash type and dispatch to appropriate method
    if (isEntryHash(hash)) {
      log.debug(` Fetching record by ENTRY hash: ${this.hashToShortString(hash)}`);
      return this.fetchRecordByEntryHash(dnaHash, hash, opts);
    } else if (isActionHash(hash)) {
      log.debug(` Fetching record by ACTION hash: ${this.hashToShortString(hash)}`);
      return this.fetchRecordByActionHash(dnaHash, hash, opts);
    } else {
      // Unknown hash type - try action hash lookup as fallback
      log.debug(` Unknown hash type, trying action hash: ${this.hashToShortString(hash)}`);
      return this.fetchRecordByActionHash(dnaHash, hash, opts);
    }
  }

  /**
   * Fetch record by action hash (the original behavior)
   */
  private fetchRecordByActionHash(
    dnaHash: DnaHash,
    actionHash: AnyDhtHash,
    opts: Required<CascadeOptions>
  ): NetworkRecord | null {
    // 1. Try local storage (session cache is synchronous)
    const record = this.buildRecordFromActionHash(actionHash);
    if (record !== null) {
      log.debug(` Found by action hash in local storage`);
      return record;
    }

    // 2. Try network cache
    const cached = this.cache.getRecordSync(actionHash);
    if (cached !== null) {
      log.debug(` Found in network cache`);
      return cached;
    }

    // 3. Try network (if enabled)
    if (opts.useNetwork && this.network && this.network.isAvailable()) {
      log.debug(`🌐 Fetching from NETWORK (local lookup failed)`);
      try {
        const networkRecord = this.network.getRecordSync(dnaHash, actionHash);
        if (networkRecord !== null) {
          log.debug(`🌐 Found in NETWORK`);
          if (opts.cacheNetworkResults) {
            this.cache.cacheRecordSync(actionHash, networkRecord);
          }
          return networkRecord;
        }
      } catch (error) {
        console.warn(`[Cascade] Network fetch failed:`, error);
      }
    } else if (opts.useNetwork) {
      if (!this.network) {
        log.debug(` Network not configured - call configureNetwork() first`);
      } else if (!this.network.isAvailable()) {
        log.debug(` Network service not available (linker: ${this.network.getLinkerUrl()})`);
      }
    }

    log.debug(` Record not found by action hash`);
    return null;
  }

  /**
   * Fetch record by entry hash - finds an action that created this entry
   */
  private fetchRecordByEntryHash(
    dnaHash: DnaHash,
    entryHash: AnyDhtHash,
    opts: Required<CascadeOptions>
  ): NetworkRecord | null {
    // 1. Try local storage - find action by entry hash
    const record = this.buildRecordFromEntryHash(entryHash);
    if (record !== null) {
      log.debug(` Found by entry hash in local storage`);
      return record;
    }

    // 2. Try network cache (keyed by entry hash)
    const cached = this.cache.getRecordSync(entryHash);
    if (cached !== null) {
      log.debug(` Found in network cache by entry hash`);
      return cached;
    }

    // 3. Try network (if enabled)
    if (opts.useNetwork && this.network && this.network.isAvailable()) {
      log.debug(`🌐 Fetching by entry hash from NETWORK`);
      try {
        const networkRecord = this.network.getRecordSync(dnaHash, entryHash);
        if (networkRecord !== null) {
          log.debug(`🌐 Found in NETWORK by entry hash`);
          if (opts.cacheNetworkResults) {
            this.cache.cacheRecordSync(entryHash, networkRecord);
          }
          return networkRecord;
        }
      } catch (error) {
        console.warn(`[Cascade] Network fetch by entry hash failed:`, error);
      }
    } else if (opts.useNetwork) {
      if (!this.network) {
        log.debug(` Network not configured - call configureNetwork() first`);
      } else if (!this.network.isAvailable()) {
        log.debug(` Network service not available (linker: ${this.network.getLinkerUrl()})`);
      }
    }

    log.debug(` Record not found by entry hash`);
    return null;
  }

  /**
   * Build a record from local storage by action hash (always synchronous)
   */
  private buildRecordFromActionHash(actionHash: AnyDhtHash): NetworkRecord | null {
    // Get action synchronously from storage
    const action = this.storage.getAction(actionHash);

    if (action === null) {
      return null;
    }

    // Get entry if applicable
    let entry: NetworkEntry = 'NotApplicable';
    if ('entryHash' in action && action.entryHash) {
      const storedEntry = this.storage.getEntry(action.entryHash);
      if (storedEntry) {
        // Convert StoredEntry to Entry format that WASM expects: { entry_type: "App", entry: content }
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
        hash: actionHash,
      },
      signature: action.signature || new Uint8Array(64),
    };

    return {
      signed_action: signedAction,
      entry,
    };
  }

  /**
   * Build a record from local storage by entry hash (always synchronous)
   * Finds an action that created/updated this entry and builds a record from it.
   */
  private buildRecordFromEntryHash(entryHash: AnyDhtHash): NetworkRecord | null {
    // Find action that references this entry hash
    const action = this.storage.getActionByEntryHash(entryHash);

    if (action === null) {
      return null;
    }

    // Get the entry
    const storedEntry = this.storage.getEntry(entryHash);
    if (!storedEntry) {
      return null;
    }

    // Convert StoredEntry to Entry format
    const entryType = storedEntry.entryType;
    let entryValue: Entry;
    if (entryType === 'Agent') {
      entryValue = { entry_type: 'Agent', entry: storedEntry.entryContent };
    } else {
      entryValue = { entry_type: 'App', entry: storedEntry.entryContent };
    }
    const entry: NetworkEntry = { Present: entryValue };

    // Build a minimal signed action structure
    const signedAction: SignedActionHashed = {
      hashed: {
        content: action as any,
        hash: action.actionHash,
      },
      signature: (action as any).signature || new Uint8Array(64),
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
   * @param filter - Optional link type filter with zomeIndex and linkType
   * @param options - Cascade options
   * @returns Array of links (may be empty)
   */
  fetchLinks(
    dnaHash: DnaHash,
    agentPubKey: Uint8Array,
    baseAddress: AnyDhtHash,
    filter?: LinkTypeFilter,
    options?: CascadeOptions
  ): NetworkLink[] {
    const opts = { ...this.options, ...options };

    log.debug(` Fetching links for base: ${this.hashToBase64(baseAddress)}`);

    // Extract zomeIndex and linkType from filter
    const zomeIndex = filter?.zomeIndex;
    const linkType = filter?.linkType;

    log.debug(` linkType filter: zomeIndex=${zomeIndex}, linkType=${linkType}`);

    // Collect links from all sources
    const allLinks: NetworkLink[] = [];

    // 1. Try local storage (always synchronous)
    log.debug(` Querying local storage with base=${this.hashToBase64(baseAddress)}, linkType=${linkType}`);
    const localLinks = this.storage.getLinks(baseAddress, dnaHash, agentPubKey, linkType);
    log.debug(` Local storage returned ${localLinks.length} links`);

    if (localLinks.length > 0) {
      log.debug(` Found ${localLinks.length} links in local storage`);
      // Convert to NetworkLink format
      allLinks.push(...localLinks.map(l => this.storedLinkToNetworkLink(l)));
    }

    // 2. Try network cache
    const cached = this.cache.getLinksSync(baseAddress, linkType);
    if (cached !== null && cached.length > 0) {
      log.debug(` Found ${cached.length} links in network cache`);
      // Merge with local, avoiding duplicates
      for (const link of cached) {
        if (!allLinks.some(l => this.linksEqual(l, link))) {
          allLinks.push(link);
        }
      }
    }

    // 3. Try network (if enabled) - ALWAYS fetch to get other agents' links
    // Links are non-deterministic: we can't know we have them all without querying.
    if (opts.useNetwork && this.network && this.network.isAvailable()) {
      log.info(`🌐 Fetching links from NETWORK for base ${this.hashToBase64(baseAddress)}, zomeIndex=${zomeIndex}, linkType=${linkType}`);
      try {
        const networkLinks = this.network.getLinksSync(dnaHash, baseAddress, linkType, zomeIndex);
        log.info(`🌐 Network returned ${networkLinks.length} links`);

        if (networkLinks.length > 0) {
          if (opts.cacheNetworkResults) {
            this.cache.cacheLinksSync(baseAddress, networkLinks, linkType);
          }
          // Merge with local, avoiding duplicates
          for (const link of networkLinks) {
            if (!allLinks.some(l => this.linksEqual(l, link))) {
              allLinks.push(link);
            }
          }
        }
      } catch (error) {
        log.error(`🌐 Network fetch error: ${error}`);
      }
    } else if (opts.useNetwork) {
      if (!this.network) {
        log.debug(` Network not configured for links - call configureNetwork() first`);
      } else if (!this.network.isAvailable()) {
        log.debug(` Network service not available for links (linker: ${this.network.getLinkerUrl()})`);
      }
    }

    log.debug(` Returning ${allLinks.length} total links`);
    return allLinks;
  }

  /**
   * Convert a stored link to network link format
   */
  private storedLinkToNetworkLink(stored: StoredLink): NetworkLink {
    // Debug: log target details for AgentPubKey investigation
    const targetPrefix = Array.from(stored.targetAddress.slice(0, 3));
    log.debug(` Converting local link to NetworkLink:`, {
      target_prefix: targetPrefix,
      target_length: stored.targetAddress.length,
      is_entry_prefix: targetPrefix[0] === 132 && targetPrefix[1] === 33 && targetPrefix[2] === 36,
      is_agent_prefix: targetPrefix[0] === 132 && targetPrefix[1] === 32 && targetPrefix[2] === 36,
    });

    return {
      create_link_hash: stored.createLinkHash,
      base: stored.baseAddress,
      target: stored.targetAddress,
      zome_index: stored.zomeIndex,
      link_type: stored.linkType,
      tag: stored.tag,
      timestamp: typeof stored.timestamp === 'bigint' ? Number(stored.timestamp) : stored.timestamp as number,
      author: stored.author,
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
   * Convert hash to base64url string for logging (matches Holochain format like uhCEk...)
   */
  private hashToBase64(hash: Uint8Array): string {
    const base64 = btoa(String.fromCharCode(...hash));
    return 'u' + base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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

  /**
   * Fetch details by hash using cascade pattern
   *
   * Order:
   * 1. Local storage
   * 2. Network cache (TODO: add if needed)
   * 3. Network (if enabled and available)
   *
   * @param dnaHash - DNA hash for network requests
   * @param agentPubKey - Agent public key for storage lookup
   * @param hash - Action or entry hash to fetch details for
   * @param options - Cascade options
   * @returns Details if found, null otherwise
   */
  fetchDetails(
    dnaHash: DnaHash,
    agentPubKey: Uint8Array,
    hash: AnyDhtHash,
    options?: CascadeOptions
  ): any | null {
    const opts = { ...this.options, ...options };

    // Detect hash type from prefix bytes
    if (isEntryHash(hash)) {
      log.debug(` Fetching details by ENTRY hash: ${this.hashToShortString(hash)}`);
      return this.fetchDetailsByEntryHash(dnaHash, agentPubKey, hash, opts);
    } else if (isActionHash(hash)) {
      log.debug(` Fetching details by ACTION hash: ${this.hashToShortString(hash)}`);
      return this.fetchDetailsByActionHash(dnaHash, agentPubKey, hash, opts);
    } else {
      // Unknown hash type - try action hash lookup as fallback
      log.debug(` Unknown hash type for details, trying action hash: ${this.hashToShortString(hash)}`);
      return this.fetchDetailsByActionHash(dnaHash, agentPubKey, hash, opts);
    }
  }

  /**
   * Fetch details by entry hash - returns Details::Entry
   */
  private fetchDetailsByEntryHash(
    dnaHash: DnaHash,
    agentPubKey: Uint8Array,
    entryHash: AnyDhtHash,
    opts: Required<CascadeOptions>
  ): any | null {
    // 1. Try local storage
    const localDetails = this.storage.getEntryDetails(entryHash, dnaHash, agentPubKey);
    if (localDetails) {
      log.debug(` Found entry details in local storage`);
      return { source: 'local', details: localDetails };
    }

    // 2. Try network (if enabled)
    if (opts.useNetwork && this.network?.isAvailable()) {
      log.debug(`🌐 Fetching entry details from NETWORK`);
      try {
        const networkDetails = this.network.getDetailsSync(dnaHash, entryHash);
        if (networkDetails) {
          log.debug(`🌐 Found entry details in NETWORK`);
          return { source: 'network', details: this.normalizeByteArrays(networkDetails) };
        }
      } catch (error) {
        console.warn(`[Cascade] Network details fetch failed:`, error);
      }
    }

    log.debug(` Entry details not found`);
    return null;
  }

  /**
   * Fetch details by action hash - returns Details::Record
   */
  private fetchDetailsByActionHash(
    dnaHash: DnaHash,
    agentPubKey: Uint8Array,
    actionHash: AnyDhtHash,
    opts: Required<CascadeOptions>
  ): any | null {
    log.debug(` fetchDetailsByActionHash:`, {
      actionHash: this.hashToBase64(actionHash),
      useNetwork: opts.useNetwork,
      networkAvailable: this.network?.isAvailable(),
    });

    // 1. Try local storage - get action and then details
    const action = this.storage.getAction(actionHash);

    if (action && 'entryHash' in action) {
      const localDetails = this.storage.getDetails(action.entryHash, dnaHash, agentPubKey);
      if (localDetails) {
        log.debug(` Found record details in local storage`);
        return { source: 'local', details: localDetails, action };
      }
    }

    // 2. Try network (if enabled)
    if (opts.useNetwork && this.network?.isAvailable()) {
      log.debug(`🌐 Fetching record details from NETWORK`);
      try {
        const networkDetails = this.network.getDetailsSync(dnaHash, actionHash);
        if (networkDetails) {
          log.debug(`🌐 Found record details in NETWORK`);
          return { source: 'network', details: this.normalizeByteArrays(networkDetails) };
        }
      } catch (error) {
        console.warn(`[Cascade] Network details fetch failed:`, error);
      }
    }

    log.debug(` Record details not found`);
    return null;
  }

  /**
   * Recursively normalize byte arrays from JSON format to Uint8Array
   */
  private normalizeByteArrays(data: any): any {
    if (data === null || data === undefined) return data;
    if (data instanceof Uint8Array) return data;

    // Check if this looks like a byte array (array of numbers 0-255)
    if (Array.isArray(data)) {
      // Check if it's a flat array of numbers (likely bytes)
      if (data.length > 0 && data.every(v => typeof v === 'number' && v >= 0 && v <= 255)) {
        return new Uint8Array(data);
      }
      // Otherwise recurse into array elements
      return data.map(item => this.normalizeByteArrays(item));
    }

    // Recurse into objects
    if (typeof data === 'object') {
      const result: any = {};
      for (const [key, value] of Object.entries(data)) {
        result[key] = this.normalizeByteArrays(value);
      }
      return result;
    }

    return data;
  }
}
