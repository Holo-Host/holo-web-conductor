/**
 * Network Cache
 *
 * In-memory cache for network data with strategy-appropriate lifetime policies:
 * - Records: LRU, no TTL (content-addressed, immutable)
 * - Links: LRU, no TTL (invalidated explicitly or via optimistic merge)
 * - Details: TTL-based (contains mutable metadata like updates/deletes)
 *
 * Records support dual-keying: a record cached by action hash is also
 * findable by entry hash (and vice versa) via an alias map.
 */

import type {
  NetworkRecord,
  NetworkLink,
  CacheEntry,
  NetworkCacheOptions,
  CachedLinkDetail,
} from './types';
import type { AnyDhtHash } from '../types/holochain-types';
import { encodeHashToBase64 } from '../types/holochain-types';

// ============================================================================
// LRU Record Cache (no TTL -- records are immutable/content-addressed)
// ============================================================================

class LRURecordCache {
  private map = new Map<string, NetworkRecord>();
  private aliasMap = new Map<string, string>(); // alias key -> canonical key
  private maxEntries: number;

  constructor(maxEntries: number) {
    this.maxEntries = maxEntries;
  }

  get(key: string): NetworkRecord | null {
    // Resolve alias
    const canonicalKey = this.aliasMap.get(key) ?? key;
    const value = this.map.get(canonicalKey);
    if (value === undefined) return null;

    // LRU touch: delete and re-insert to move to end
    this.map.delete(canonicalKey);
    this.map.set(canonicalKey, value);
    return value;
  }

  set(key: string, value: NetworkRecord): void {
    // If already exists, delete first (to update position)
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    this.map.set(key, value);

    // Evict oldest if over capacity
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) {
        this.evictKey(oldest);
      }
    }
  }

  setAlias(aliasKey: string, canonicalKey: string): void {
    if (aliasKey !== canonicalKey) {
      this.aliasMap.set(aliasKey, canonicalKey);
    }
  }

  delete(key: string): void {
    const canonicalKey = this.aliasMap.get(key) ?? key;
    this.evictKey(canonicalKey);
  }

  private evictKey(canonicalKey: string): void {
    this.map.delete(canonicalKey);
    // Clean up aliases pointing to this key
    for (const [alias, target] of this.aliasMap.entries()) {
      if (target === canonicalKey) {
        this.aliasMap.delete(alias);
      }
    }
  }

  clear(): void {
    this.map.clear();
    this.aliasMap.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

// ============================================================================
// TTL Cache (for details -- contains mutable metadata)
// ============================================================================

class TTLCache<T> {
  private map = new Map<string, CacheEntry<T>>();
  private maxEntries: number;
  private ttl: number;

  constructor(maxEntries: number, ttl: number) {
    this.maxEntries = maxEntries;
    this.ttl = ttl;
  }

  get(key: string): T | null {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return null;
    }
    return entry.data;
  }

  set(key: string, data: T): void {
    const now = Date.now();
    // Delete first to update insertion order
    this.map.delete(key);
    this.map.set(key, {
      data,
      fetchedAt: now,
      expiresAt: now + this.ttl,
    });

    // Evict if over capacity
    if (this.map.size > this.maxEntries) {
      this.evict();
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  private evict(): void {
    const now = Date.now();
    // Remove expired first
    for (const [key, entry] of this.map.entries()) {
      if (now > entry.expiresAt) {
        this.map.delete(key);
      }
    }
    // Trim oldest if still over
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) {
        this.map.delete(oldest);
      }
    }
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

// ============================================================================
// LRU Link Cache (no TTL -- invalidated explicitly or via optimistic merge)
// ============================================================================

class LRULinkCache {
  private map = new Map<string, NetworkLink[]>();
  private maxEntries: number;

  constructor(maxEntries: number) {
    this.maxEntries = maxEntries;
  }

  get(key: string): NetworkLink[] | null {
    const value = this.map.get(key);
    if (value === undefined) return null;
    // LRU touch
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: NetworkLink[]): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) {
        this.map.delete(oldest);
      }
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  deleteByPrefix(baseKey: string): void {
    for (const key of this.map.keys()) {
      if (key === baseKey || key.startsWith(baseKey + ':')) {
        this.map.delete(key);
      }
    }
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  entries(): IterableIterator<[string, NetworkLink[]]> {
    return this.map.entries();
  }
}

// ============================================================================
// LRU Link Details Cache (no TTL -- monotonically growing, safe to cache forever)
// ============================================================================

class LRULinkDetailsCache {
  private map = new Map<string, CachedLinkDetail[]>();
  private maxEntries: number;

  constructor(maxEntries: number) {
    this.maxEntries = maxEntries;
  }

  get(key: string): CachedLinkDetail[] | null {
    const value = this.map.get(key);
    if (value === undefined) return null;
    // LRU touch
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: string, value: CachedLinkDetail[]): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) {
        this.map.delete(oldest);
      }
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  deleteByPrefix(baseKey: string): void {
    for (const key of this.map.keys()) {
      if (key === baseKey || key.startsWith(baseKey + ':')) {
        this.map.delete(key);
      }
    }
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  entries(): IterableIterator<[string, CachedLinkDetail[]]> {
    return this.map.entries();
  }
}

// ============================================================================
// Default cache options
// ============================================================================

const DEFAULT_RECORD_MAX = 10_000;
const DEFAULT_LINK_MAX = 5_000;
const DEFAULT_LINK_DETAILS_MAX = 5_000;
const DEFAULT_DETAILS_MAX = 1_000;
const DEFAULT_DETAILS_TTL = 2 * 60 * 1000; // 2 minutes

// ============================================================================
// NetworkCache
// ============================================================================

/**
 * In-memory network cache with strategy-appropriate lifetimes
 */
export class NetworkCache {
  private records: LRURecordCache;
  private links: LRULinkCache;
  private linkDetails: LRULinkDetailsCache;
  private details: TTLCache<any>;
  private _recordMax: number;
  private _linkMax: number;
  private _linkDetailsMax: number;

  constructor(options?: NetworkCacheOptions) {
    // Support legacy options: map old ttl/maxEntries to new fields
    const recordMax = options?.recordMaxEntries ?? DEFAULT_RECORD_MAX;
    const linkMax = options?.linkMaxEntries ??
      (options?.maxEntries ?? DEFAULT_LINK_MAX);
    const linkDetailsMax = options?.linkDetailsMaxEntries ?? DEFAULT_LINK_DETAILS_MAX;
    const detailsMax = options?.detailsMaxEntries ?? DEFAULT_DETAILS_MAX;
    const detailsTtl = options?.detailsTtl ??
      (options?.ttl ?? DEFAULT_DETAILS_TTL);

    this._recordMax = recordMax;
    this._linkMax = linkMax;
    this._linkDetailsMax = linkDetailsMax;
    this.records = new LRURecordCache(recordMax);
    this.links = new LRULinkCache(linkMax);
    this.linkDetails = new LRULinkDetailsCache(linkDetailsMax);
    this.details = new TTLCache<any>(detailsMax, detailsTtl);
  }

  // --- Records (LRU, no TTL, dual-keyed) ---

  getRecordSync(hash: AnyDhtHash): NetworkRecord | null {
    const key = encodeHashToBase64(hash);
    return this.records.get(key);
  }

  cacheRecordSync(hash: AnyDhtHash, record: NetworkRecord): void {
    const key = encodeHashToBase64(hash);
    this.records.set(key, record);

    // Dual-keying: create alias from the "other" hash
    const actionHash = record.signed_action?.hashed?.hash;
    const content = record.signed_action?.hashed?.content as any;
    const entryHash = content?.entry_hash ?? content?.entryHash;

    if (actionHash instanceof Uint8Array && actionHash.length > 0 &&
        entryHash instanceof Uint8Array && entryHash.length > 0) {
      const actionKey = encodeHashToBase64(actionHash);
      const entryKey = encodeHashToBase64(entryHash);
      if (key === actionKey && entryKey !== actionKey) {
        this.records.setAlias(entryKey, actionKey);
      } else if (key === entryKey && actionKey !== entryKey) {
        this.records.setAlias(actionKey, entryKey);
      }
    }
  }

  invalidateRecord(hash: AnyDhtHash): void {
    const key = encodeHashToBase64(hash);
    this.records.delete(key);
  }

  // --- Links (LRU, no TTL) ---

  getLinksSync(baseAddress: AnyDhtHash, linkType?: number): NetworkLink[] | null {
    const key = linkType !== undefined
      ? `${encodeHashToBase64(baseAddress)}:${linkType}`
      : encodeHashToBase64(baseAddress);
    return this.links.get(key);
  }

  cacheLinksSync(
    baseAddress: AnyDhtHash,
    links: NetworkLink[],
    linkType?: number
  ): void {
    const key = linkType !== undefined
      ? `${encodeHashToBase64(baseAddress)}:${linkType}`
      : encodeHashToBase64(baseAddress);
    this.links.set(key, links);
  }

  invalidateLinks(baseAddress: AnyDhtHash, linkType?: number): void {
    if (linkType !== undefined) {
      const key = `${encodeHashToBase64(baseAddress)}:${linkType}`;
      this.links.delete(key);
    } else {
      const baseKey = encodeHashToBase64(baseAddress);
      this.links.deleteByPrefix(baseKey);
    }
  }

  /**
   * Optimistic merge: add a single link into all matching cached link sets
   * for the given base address. Called from create_link host function.
   */
  mergeLinkIntoCache(baseAddress: AnyDhtHash, link: NetworkLink): void {
    const baseKey = encodeHashToBase64(baseAddress);
    for (const [key, links] of this.links.entries()) {
      if (key === baseKey || key === `${baseKey}:${link.link_type}`) {
        const exists = links.some(l =>
          l.create_link_hash.length === link.create_link_hash.length &&
          l.create_link_hash.every((b: number, i: number) => b === link.create_link_hash[i])
        );
        if (!exists) {
          links.push(link);
        }
      }
    }
  }

  /**
   * Optimistic remove: remove a link from all cached link sets
   * for the given base address. Called from delete_link host function.
   */
  removeLinkFromCache(baseAddress: AnyDhtHash, createLinkHash: Uint8Array): void {
    const baseKey = encodeHashToBase64(baseAddress);
    for (const [key, links] of this.links.entries()) {
      if (key === baseKey || key.startsWith(baseKey + ':')) {
        const idx = links.findIndex(l =>
          l.create_link_hash.length === createLinkHash.length &&
          l.create_link_hash.every((b: number, i: number) => b === createLinkHash[i])
        );
        if (idx !== -1) {
          links.splice(idx, 1);
        }
      }
    }
  }

  // --- Link Details (LRU, no TTL -- monotonically growing) ---

  getLinkDetailsSync(baseAddress: AnyDhtHash, linkType?: number): CachedLinkDetail[] | null {
    const key = linkType !== undefined
      ? `${encodeHashToBase64(baseAddress)}:${linkType}`
      : encodeHashToBase64(baseAddress);
    return this.linkDetails.get(key);
  }

  cacheLinkDetailsSync(
    baseAddress: AnyDhtHash,
    details: CachedLinkDetail[],
    linkType?: number
  ): void {
    const key = linkType !== undefined
      ? `${encodeHashToBase64(baseAddress)}:${linkType}`
      : encodeHashToBase64(baseAddress);
    this.linkDetails.set(key, details);
  }

  invalidateLinkDetails(baseAddress: AnyDhtHash, linkType?: number): void {
    if (linkType !== undefined) {
      const key = `${encodeHashToBase64(baseAddress)}:${linkType}`;
      this.linkDetails.delete(key);
    } else {
      const baseKey = encodeHashToBase64(baseAddress);
      this.linkDetails.deleteByPrefix(baseKey);
    }
  }

  /**
   * Optimistic merge: add a single link detail into all matching cached detail sets
   * for the given base address. Called from create_link host function.
   * If a detail with the same create_link_hash already exists, it is not duplicated.
   */
  mergeLinkDetailIntoCache(baseAddress: AnyDhtHash, link: NetworkLink): void {
    const baseKey = encodeHashToBase64(baseAddress);
    for (const [key, details] of this.linkDetails.entries()) {
      if (key === baseKey || key === `${baseKey}:${link.link_type}`) {
        const exists = details.some(d =>
          d.create.create_link_hash.length === link.create_link_hash.length &&
          d.create.create_link_hash.every((b: number, i: number) => b === link.create_link_hash[i])
        );
        if (!exists) {
          details.push({ create: link, deleteHashes: [] });
        }
      }
    }
  }

  /**
   * Optimistic delete: append a deleteHash to the matching create in the link details cache.
   * Called from delete_link host function. No-op if the create is not found.
   */
  addDeleteToLinkDetailsCache(
    baseAddress: AnyDhtHash,
    createLinkHash: Uint8Array,
    deleteHash: Uint8Array
  ): void {
    const baseKey = encodeHashToBase64(baseAddress);
    for (const [key, details] of this.linkDetails.entries()) {
      if (key === baseKey || key.startsWith(baseKey + ':')) {
        for (const detail of details) {
          const matches =
            detail.create.create_link_hash.length === createLinkHash.length &&
            detail.create.create_link_hash.every((b: number, i: number) => b === createLinkHash[i]);
          if (matches) {
            const alreadyPresent = detail.deleteHashes.some(
              dh => dh.length === deleteHash.length && dh.every((b: number, i: number) => b === deleteHash[i])
            );
            if (!alreadyPresent) {
              detail.deleteHashes.push(deleteHash);
            }
          }
        }
      }
    }
  }

  // --- Details (TTL-based) ---

  getDetailsSync(hash: AnyDhtHash): any | null {
    const key = encodeHashToBase64(hash);
    return this.details.get(key);
  }

  cacheDetailsSync(hash: AnyDhtHash, details: any): void {
    const key = encodeHashToBase64(hash);
    this.details.set(key, details);
  }

  invalidateDetails(hash: AnyDhtHash): void {
    const key = encodeHashToBase64(hash);
    this.details.delete(key);
  }

  // --- General ---

  clear(): void {
    this.records.clear();
    this.links.clear();
    this.linkDetails.clear();
    this.details.clear();
  }

  getStats(): {
    records: number;
    links: number;
    linkDetails: number;
    details: number;
    recordMaxEntries: number;
    linkMaxEntries: number;
    linkDetailsMaxEntries: number;
  } {
    return {
      records: this.records.size,
      links: this.links.size,
      linkDetails: this.linkDetails.size,
      details: this.details.size,
      recordMaxEntries: this._recordMax,
      linkMaxEntries: this._linkMax,
      linkDetailsMaxEntries: this._linkDetailsMax,
    };
  }
}

// ============================================================================
// Singleton
// ============================================================================

let defaultCache: NetworkCache | null = null;

export function getNetworkCache(): NetworkCache {
  if (!defaultCache) {
    defaultCache = new NetworkCache();
  }
  return defaultCache;
}

export function resetNetworkCache(): void {
  defaultCache = null;
}
