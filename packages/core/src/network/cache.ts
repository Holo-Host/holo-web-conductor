/**
 * Network Cache
 *
 * In-memory cache for network data with optional TTL expiration.
 * This cache stores data fetched from the network to avoid redundant requests.
 *
 * Note: This is a simple in-memory cache. For persistent caching across
 * extension restarts, we could extend this to use IndexedDB.
 */

import type {
  NetworkRecord,
  NetworkLink,
  CacheEntry,
  NetworkCacheOptions,
} from './types';
import type { AnyDhtHash } from '../types/holochain-types';

/**
 * Convert Uint8Array to base64 for use as cache key
 */
function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Default cache options
 */
const DEFAULT_OPTIONS: Required<NetworkCacheOptions> = {
  ttl: 5 * 60 * 1000, // 5 minutes
  maxEntries: 1000,
};

/**
 * In-memory network cache
 */
export class NetworkCache {
  private records = new Map<string, CacheEntry<NetworkRecord>>();
  private links = new Map<string, CacheEntry<NetworkLink[]>>();
  private options: Required<NetworkCacheOptions>;

  constructor(options?: NetworkCacheOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Check if a cache entry is expired
   */
  private isExpired(entry: CacheEntry<any>): boolean {
    return Date.now() > entry.expiresAt;
  }

  /**
   * Evict expired entries and trim to max size
   */
  private evict(): void {
    const now = Date.now();

    // Remove expired entries
    for (const [key, entry] of this.records.entries()) {
      if (now > entry.expiresAt) {
        this.records.delete(key);
      }
    }

    for (const [key, entry] of this.links.entries()) {
      if (now > entry.expiresAt) {
        this.links.delete(key);
      }
    }

    // Trim to max size (LRU-ish: just remove oldest entries)
    const totalEntries = this.records.size + this.links.size;
    if (totalEntries > this.options.maxEntries) {
      const toRemove = totalEntries - this.options.maxEntries;

      // Remove oldest record entries first
      let removed = 0;
      for (const key of this.records.keys()) {
        if (removed >= toRemove) break;
        this.records.delete(key);
        removed++;
      }

      // Then links if needed
      for (const key of this.links.keys()) {
        if (removed >= toRemove) break;
        this.links.delete(key);
        removed++;
      }
    }
  }

  /**
   * Get a cached record (synchronous)
   */
  getRecordSync(hash: AnyDhtHash): NetworkRecord | null {
    const key = toBase64(hash);
    const entry = this.records.get(key);

    if (!entry) {
      return null;
    }

    if (this.isExpired(entry)) {
      this.records.delete(key);
      return null;
    }

    return entry.data;
  }

  /**
   * Cache a record (synchronous)
   */
  cacheRecordSync(hash: AnyDhtHash, record: NetworkRecord): void {
    const key = toBase64(hash);
    const now = Date.now();

    this.records.set(key, {
      data: record,
      fetchedAt: now,
      expiresAt: now + this.options.ttl,
    });

    // Periodically evict
    if (this.records.size + this.links.size > this.options.maxEntries * 1.1) {
      this.evict();
    }
  }

  /**
   * Get cached links for a base address (synchronous)
   */
  getLinksSync(baseAddress: AnyDhtHash, linkType?: number): NetworkLink[] | null {
    // Include link type in key for type-specific caching
    const key = linkType !== undefined
      ? `${toBase64(baseAddress)}:${linkType}`
      : toBase64(baseAddress);

    const entry = this.links.get(key);

    if (!entry) {
      return null;
    }

    if (this.isExpired(entry)) {
      this.links.delete(key);
      return null;
    }

    return entry.data;
  }

  /**
   * Cache links for a base address (synchronous)
   */
  cacheLinksSync(
    baseAddress: AnyDhtHash,
    links: NetworkLink[],
    linkType?: number
  ): void {
    const key = linkType !== undefined
      ? `${toBase64(baseAddress)}:${linkType}`
      : toBase64(baseAddress);

    const now = Date.now();

    this.links.set(key, {
      data: links,
      fetchedAt: now,
      expiresAt: now + this.options.ttl,
    });

    // Periodically evict
    if (this.records.size + this.links.size > this.options.maxEntries * 1.1) {
      this.evict();
    }
  }

  /**
   * Invalidate a cached record
   */
  invalidateRecord(hash: AnyDhtHash): void {
    const key = toBase64(hash);
    this.records.delete(key);
  }

  /**
   * Invalidate cached links for a base address
   */
  invalidateLinks(baseAddress: AnyDhtHash, linkType?: number): void {
    if (linkType !== undefined) {
      const key = `${toBase64(baseAddress)}:${linkType}`;
      this.links.delete(key);
    } else {
      // Invalidate all link types for this base
      const baseKey = toBase64(baseAddress);
      for (const key of this.links.keys()) {
        if (key === baseKey || key.startsWith(baseKey + ':')) {
          this.links.delete(key);
        }
      }
    }
  }

  /**
   * Clear the entire cache
   */
  clear(): void {
    this.records.clear();
    this.links.clear();
  }

  /**
   * Get cache statistics
   */
  getStats(): { records: number; links: number; maxEntries: number } {
    return {
      records: this.records.size,
      links: this.links.size,
      maxEntries: this.options.maxEntries,
    };
  }
}

/**
 * Singleton instance for the default network cache
 */
let defaultCache: NetworkCache | null = null;

/**
 * Get the default network cache instance
 */
export function getNetworkCache(): NetworkCache {
  if (!defaultCache) {
    defaultCache = new NetworkCache();
  }
  return defaultCache;
}

/**
 * Reset the default network cache (for testing)
 */
export function resetNetworkCache(): void {
  defaultCache = null;
}
