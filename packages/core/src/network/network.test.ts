/**
 * Network Module Tests
 *
 * Tests for MockNetworkService, NetworkCache, and Cascade classes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MockNetworkService } from './mock-service';
import { NetworkCache } from './cache';
import { Cascade } from './cascade';
import type { NetworkRecord, NetworkLink } from './types';
import type { Entry } from '../types/holochain-types';

// Helper to create test hashes
function createHash(value: number): Uint8Array {
  const hash = new Uint8Array(39);
  hash[0] = 132; // Holochain hash prefix
  hash[1] = 41;
  hash[2] = 36;
  hash[3] = value;
  return hash;
}

// Helper to create a minimal network record
function createNetworkRecord(actionSeq: number): NetworkRecord {
  const appEntry: Entry = { entry_type: 'App', entry: new Uint8Array([1, 2, 3]) };
  return {
    signed_action: {
      hashed: {
        content: {
          type: 'Create',
          action_seq: actionSeq,
          timestamp: Date.now() * 1000,
          author: createHash(2),
        } as any, // Network format uses different field names - Action type varies
        hash: createHash(actionSeq),
      },
      signature: new Uint8Array(64),
    },
    entry: { Present: appEntry },
  };
}

// Helper to create a network link
function createNetworkLink(linkType: number): NetworkLink {
  return {
    create_link_hash: createHash(100 + linkType),
    base: createHash(50),
    target: createHash(60),
    zome_index: 0,
    link_type: linkType,
    tag: new Uint8Array([1, 2, 3]),
    timestamp: Date.now() * 1000,
    author: createHash(2),
  };
}

describe('MockNetworkService', () => {
  let mockNetwork: MockNetworkService;

  beforeEach(() => {
    mockNetwork = new MockNetworkService();
  });

  it('should return null for unknown hash', () => {
    const result = mockNetwork.getRecordSync(createHash(1), createHash(99));
    expect(result).toBeNull();
  });

  it('should return added record', () => {
    const hash = createHash(10);
    const record = createNetworkRecord(10);
    mockNetwork.addRecord(hash, record);

    const result = mockNetwork.getRecordSync(createHash(1), hash);
    expect(result).toEqual(record);
  });

  it('should return empty array for unknown links', () => {
    const result = mockNetwork.getLinksSync(createHash(1), createHash(50));
    expect(result).toEqual([]);
  });

  it('should return added links', () => {
    const baseAddress = createHash(50);
    const links = [createNetworkLink(1), createNetworkLink(2)];
    mockNetwork.addLinks(baseAddress, links);

    const result = mockNetwork.getLinksSync(createHash(1), baseAddress);
    expect(result).toHaveLength(2);
  });

  it('should filter links by type', () => {
    const baseAddress = createHash(50);
    mockNetwork.addLinks(baseAddress, [createNetworkLink(1), createNetworkLink(2)]);

    const result = mockNetwork.getLinksSync(createHash(1), baseAddress, 1);
    expect(result).toHaveLength(1);
    expect(result[0].link_type).toBe(1);
  });

  it('should throw when unavailable', () => {
    mockNetwork.setAvailable(false);
    expect(() => mockNetwork.getRecordSync(createHash(1), createHash(10))).toThrow(
      'Network unavailable'
    );
  });

  it('should log calls for verification', () => {
    const hash = createHash(10);
    mockNetwork.getRecordSync(createHash(1), hash);

    const log = mockNetwork.getCallLog();
    expect(log).toHaveLength(1);
    expect(log[0].method).toBe('getRecordSync');
  });
});

describe('NetworkCache', () => {
  let cache: NetworkCache;

  beforeEach(() => {
    cache = new NetworkCache({ ttl: 1000, maxEntries: 10 });
  });

  it('should return null for uncached hash', () => {
    const result = cache.getRecordSync(createHash(10));
    expect(result).toBeNull();
  });

  it('should return cached record', () => {
    const hash = createHash(10);
    const record = createNetworkRecord(10);
    cache.cacheRecordSync(hash, record);

    const result = cache.getRecordSync(hash);
    expect(result).toEqual(record);
  });

  it('should never expire records (immutable, no TTL)', async () => {
    const cache2 = new NetworkCache({ ttl: 10 }); // legacy ttl only affects details
    const hash = createHash(10);
    const record = createNetworkRecord(10);
    cache2.cacheRecordSync(hash, record);

    // Wait well past any old TTL
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Records are content-addressed and immutable -- they never expire
    const result = cache2.getRecordSync(hash);
    expect(result).toEqual(record);
  });

  it('should cache and retrieve links', () => {
    const baseAddress = createHash(50);
    const links = [createNetworkLink(1)];
    cache.cacheLinksSync(baseAddress, links);

    const result = cache.getLinksSync(baseAddress);
    expect(result).toEqual(links);
  });

  it('should invalidate record', () => {
    const hash = createHash(10);
    cache.cacheRecordSync(hash, createNetworkRecord(10));
    cache.invalidateRecord(hash);

    const result = cache.getRecordSync(hash);
    expect(result).toBeNull();
  });

  it('should clear all cached data', () => {
    cache.cacheRecordSync(createHash(10), createNetworkRecord(10));
    cache.cacheLinksSync(createHash(50), [createNetworkLink(1)]);
    cache.clear();

    expect(cache.getRecordSync(createHash(10))).toBeNull();
    expect(cache.getLinksSync(createHash(50))).toBeNull();
  });

  it('should report stats', () => {
    cache.cacheRecordSync(createHash(10), createNetworkRecord(10));
    cache.cacheLinksSync(createHash(50), [createNetworkLink(1)]);

    const stats = cache.getStats();
    expect(stats.records).toBe(1);
    expect(stats.links).toBe(1);
  });
});

describe('Cascade', () => {
  let mockStorage: any;
  let cache: NetworkCache;
  let mockNetwork: MockNetworkService;
  let cascade: Cascade;

  beforeEach(() => {
    // Create a minimal mock storage
    mockStorage = {
      getAction: vi.fn().mockReturnValue(null),
      getEntry: vi.fn().mockReturnValue(null),
      getLinks: vi.fn().mockReturnValue([]),
      queryActionsFromCache: vi.fn().mockReturnValue([]),
    };

    cache = new NetworkCache();
    mockNetwork = new MockNetworkService();
    cascade = new Cascade(mockStorage, cache, mockNetwork);
  });

  describe('fetchRecord', () => {
    it('should return record from local storage', () => {
      const hash = createHash(10);
      const action = {
        actionType: 'Create',
        actionSeq: 10,
        entryHash: createHash(20),
      };
      const entry = { entryContent: new Uint8Array([1, 2, 3]) };

      mockStorage.getAction.mockReturnValue(action);
      mockStorage.getEntry.mockReturnValue(entry);

      const result = cascade.fetchRecord(createHash(1), hash);

      expect(result).not.toBeNull();
      expect(mockNetwork.getCallLog()).toHaveLength(0); // Didn't call network
    });

    it('should return record from network cache', () => {
      const hash = createHash(10);
      const record = createNetworkRecord(10);
      cache.cacheRecordSync(hash, record);

      const result = cascade.fetchRecord(createHash(1), hash);

      expect(result).toEqual(record);
      expect(mockNetwork.getCallLog()).toHaveLength(0);
    });

    it('should fetch from network on local miss', () => {
      const hash = createHash(10);
      const record = createNetworkRecord(10);
      mockNetwork.addRecord(hash, record);

      const result = cascade.fetchRecord(createHash(1), hash);

      expect(result).toEqual(record);
      expect(mockNetwork.getCallLog()).toHaveLength(1);
    });

    it('should cache network results', () => {
      const hash = createHash(10);
      const record = createNetworkRecord(10);
      mockNetwork.addRecord(hash, record);

      cascade.fetchRecord(createHash(1), hash);

      // Should be cached now
      expect(cache.getRecordSync(hash)).toEqual(record);
    });

    it('should skip network when disabled', () => {
      const cascadeNoNetwork = new Cascade(mockStorage, cache, mockNetwork, {
        useNetwork: false,
      });

      const result = cascadeNoNetwork.fetchRecord(createHash(1), createHash(10));

      expect(result).toBeNull();
      expect(mockNetwork.getCallLog()).toHaveLength(0);
    });

    it('should handle network failures gracefully', () => {
      mockNetwork.setAvailable(false);

      const result = cascade.fetchRecord(createHash(1), createHash(10));

      expect(result).toBeNull(); // Doesn't throw
    });
  });

  describe('fetchLinks', () => {
    it('should return links from local storage', () => {
      const baseAddress = createHash(50);
      const localLinks = [
        {
          createLinkHash: createHash(100),
          baseAddress,
          targetAddress: createHash(60),
          timestamp: BigInt(Date.now() * 1000),
          zomeIndex: 0,
          linkType: 1,
          tag: new Uint8Array([1]),
          author: createHash(2),
          deleted: false,
        },
      ];

      mockStorage.getLinks.mockReturnValue(localLinks);

      const result = cascade.fetchLinks(
        createHash(1),
        createHash(2),
        baseAddress
      );

      expect(result).toHaveLength(1);
      // Cascade always queries network for links (non-deterministic data),
      // so we only verify local results are included, not that network was skipped
    });

    it('should use cached links as fallback when network unavailable', () => {
      // Create cascade with no network service to simulate network unavailable
      const noNetCascade = new Cascade(mockStorage as any, cache, null);
      const baseAddress = createHash(50);
      const cachedLinks = [createNetworkLink(1)];
      cache.cacheLinksSync(baseAddress, cachedLinks);

      const result = noNetCascade.fetchLinks(
        createHash(1),
        createHash(2),
        baseAddress
      );

      expect(result).toHaveLength(1);
    });

    it('should NOT merge stale cache when network returns results', () => {
      const baseAddress = createHash(50);
      // Cache has a link that no longer exists on network
      const cachedLinks = [createNetworkLink(1)];
      cache.cacheLinksSync(baseAddress, cachedLinks);

      // Network returns empty (the link was deleted by another agent)
      // mockNetwork has no links added for this base

      const result = cascade.fetchLinks(
        createHash(1),
        createHash(2),
        baseAddress
      );

      // Network is authoritative -- stale cache should not appear
      expect(result).toHaveLength(0);
    });

    it('should fetch from network when local is empty', () => {
      const baseAddress = createHash(50);
      const networkLinks = [createNetworkLink(1)];
      mockNetwork.addLinks(baseAddress, networkLinks);

      const result = cascade.fetchLinks(
        createHash(1),
        createHash(2),
        baseAddress
      );

      expect(result).toHaveLength(1);
      expect(mockNetwork.getCallLog()).toHaveLength(1);
    });
  });

  describe('invalidation', () => {
    it('should invalidate cached record', () => {
      const hash = createHash(10);
      cache.cacheRecordSync(hash, createNetworkRecord(10));

      cascade.invalidate(hash);

      expect(cache.getRecordSync(hash)).toBeNull();
    });

    it('should invalidate cached links', () => {
      const baseAddress = createHash(50);
      cache.cacheLinksSync(baseAddress, [createNetworkLink(1)]);

      cascade.invalidateLinks(baseAddress);

      expect(cache.getLinksSync(baseAddress)).toBeNull();
    });
  });

  describe('network availability', () => {
    it('should report network available', () => {
      expect(cascade.isNetworkAvailable()).toBe(true);
    });

    it('should report network unavailable', () => {
      mockNetwork.setAvailable(false);
      expect(cascade.isNetworkAvailable()).toBe(false);
    });

    it('should report unavailable when no network service', () => {
      const cascadeNoNetwork = new Cascade(mockStorage, cache, null);
      expect(cascadeNoNetwork.isNetworkAvailable()).toBe(false);
    });
  });

  describe('cache behavior - network first, then cache', () => {
    it('should fetch from network first time, cache second time (records)', () => {
      const hash = createHash(42); // Known hash
      const dnaHash = createHash(1);
      const record = createNetworkRecord(42);

      // Add record to mock network
      mockNetwork.addRecord(hash, record);

      // First fetch - should hit network
      const result1 = cascade.fetchRecord(dnaHash, hash);
      expect(result1).toEqual(record);

      // Check network was called once
      const log1 = mockNetwork.getCallLog();
      expect(log1).toHaveLength(1);
      expect(log1[0].method).toBe('getRecordSync');

      // Second fetch - should hit cache, NOT network
      const result2 = cascade.fetchRecord(dnaHash, hash);
      expect(result2).toEqual(record);

      // Network call count should still be 1 (cache was used)
      const log2 = mockNetwork.getCallLog();
      expect(log2).toHaveLength(1); // Still 1, not 2
    });

    it('should fetch from network first time, cache second time (links)', () => {
      const baseAddress = createHash(50);
      const dnaHash = createHash(1);
      const agentPubKey = createHash(2);
      const links = [createNetworkLink(1), createNetworkLink(2)];

      // Add links to mock network
      mockNetwork.addLinks(baseAddress, links);

      // First fetch - should hit network
      const result1 = cascade.fetchLinks(dnaHash, agentPubKey, baseAddress);
      expect(result1).toHaveLength(2);

      // Check network was called
      const log1 = mockNetwork.getCallLog();
      expect(log1).toHaveLength(1);
      expect(log1[0].method).toBe('getLinksSync');

      // Second fetch - results should be cached and still available
      // Note: Cascade always queries network for links (non-deterministic data),
      // so we verify results are correct rather than asserting network was skipped
      const result2 = cascade.fetchLinks(dnaHash, agentPubKey, baseAddress);
      expect(result2).toHaveLength(2);
    });

    it('should fetch details from network first time, cache second time', () => {
      const hash = createHash(42);
      const dnaHash = createHash(1);
      const agentPubKey = createHash(2);
      const details = {
        type: 'Entry',
        content: { entry: { entry_type: 'App', entry: new Uint8Array([1]) }, actions: [], deletes: [], updates: [] },
      };

      // Add details to mock network
      mockNetwork.addDetails(hash, details);

      // First fetch - should hit network
      const result1 = cascade.fetchDetails(dnaHash, agentPubKey, hash);
      expect(result1).not.toBeNull();
      expect(result1.source).toBe('network');
      expect(mockNetwork.getCallLog().filter(c => c.method === 'getDetailsSync')).toHaveLength(1);

      // Second fetch - should hit details cache (TTL-based)
      const result2 = cascade.fetchDetails(dnaHash, agentPubKey, hash);
      expect(result2).not.toBeNull();
      // Network should NOT have been called again
      expect(mockNetwork.getCallLog().filter(c => c.method === 'getDetailsSync')).toHaveLength(1);
    });

    it('should skip details network call with Local strategy', () => {
      const hash = createHash(42);
      const dnaHash = createHash(1);
      const agentPubKey = createHash(2);
      const details = { type: 'Record', content: {} };
      mockNetwork.addDetails(hash, details);

      // With Local strategy, should not hit network
      const result = cascade.fetchDetails(dnaHash, agentPubKey, hash, undefined, 'Local');
      expect(result).toBeNull(); // nothing in local storage or cache
      expect(mockNetwork.getCallLog().filter(c => c.method === 'getDetailsSync')).toHaveLength(0);
    });

    it('should use well-known hash for testing network→cache flow', () => {
      // This test uses a specific "well-known" hash that can be referenced
      // in browser testing to verify the network→cache flow

      // Create a well-known hash with recognizable bytes
      const wellKnownHash = new Uint8Array(39);
      wellKnownHash.set([132, 41, 36], 0); // Holochain hash prefix
      wellKnownHash.set([0xDE, 0xAD, 0xBE, 0xEF], 3); // Recognizable pattern

      const dnaHash = createHash(1);
      const record = createNetworkRecord(99);

      // Add to network
      mockNetwork.addRecord(wellKnownHash, record);

      // First fetch - network
      cascade.fetchRecord(dnaHash, wellKnownHash);
      expect(mockNetwork.getCallLog()).toHaveLength(1);

      // Verify it's now in cache
      expect(cache.getRecordSync(wellKnownHash)).not.toBeNull();

      // Second fetch - cache (no new network call)
      cascade.fetchRecord(dnaHash, wellKnownHash);
      expect(mockNetwork.getCallLog()).toHaveLength(1);
    });
  });
});
