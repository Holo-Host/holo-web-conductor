/**
 * Cache Tests
 *
 * Tests for NetworkCache: LRU records, link caching, details TTL,
 * dual-keying, optimistic merge, and GetStrategy integration.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NetworkCache } from './cache';
import type { NetworkRecord, NetworkLink } from './types';
import type { Entry } from '../types/holochain-types';

// --- Test helpers ---

function createActionHash(value: number): Uint8Array {
  const hash = new Uint8Array(39);
  hash[0] = 132; hash[1] = 41; hash[2] = 36; // action hash prefix
  hash[3] = value;
  return hash;
}

function createEntryHash(value: number): Uint8Array {
  const hash = new Uint8Array(39);
  hash[0] = 132; hash[1] = 33; hash[2] = 36; // entry hash prefix
  hash[3] = value;
  return hash;
}

function createRecord(actionValue: number, entryValue?: number): NetworkRecord {
  const actionHash = createActionHash(actionValue);
  const content: any = {
    type: 'Create',
    action_seq: actionValue,
    timestamp: Date.now() * 1000,
    author: createActionHash(2),
  };
  if (entryValue !== undefined) {
    content.entry_hash = createEntryHash(entryValue);
  }

  const appEntry: Entry = { entry_type: 'App', entry: new Uint8Array([1, 2, 3]) };
  return {
    signed_action: {
      hashed: { content, hash: actionHash },
      signature: new Uint8Array(64),
    },
    entry: entryValue !== undefined ? { Present: appEntry } : 'NotApplicable',
  };
}

function createLink(linkType: number, baseValue: number = 50): NetworkLink {
  return {
    create_link_hash: createActionHash(100 + linkType),
    base: createActionHash(baseValue),
    target: createActionHash(60),
    zome_index: 0,
    link_type: linkType,
    tag: new Uint8Array([1, 2, 3]),
    timestamp: Date.now() * 1000,
    author: createActionHash(2),
  };
}

// --- Tests ---

describe('NetworkCache - Record LRU', () => {
  let cache: NetworkCache;

  beforeEach(() => {
    cache = new NetworkCache({ recordMaxEntries: 3 });
  });

  it('should cache and retrieve a record by hash', () => {
    const hash = createActionHash(1);
    const record = createRecord(1);
    cache.cacheRecordSync(hash, record);
    expect(cache.getRecordSync(hash)).toBe(record);
  });

  it('should return null for uncached hash', () => {
    expect(cache.getRecordSync(createActionHash(99))).toBeNull();
  });

  it('should never expire records (no TTL)', () => {
    const hash = createActionHash(1);
    const record = createRecord(1);
    cache.cacheRecordSync(hash, record);

    // Advance time far beyond any reasonable TTL
    vi.useFakeTimers();
    vi.advanceTimersByTime(60 * 60 * 1000); // 1 hour

    expect(cache.getRecordSync(hash)).toBe(record);
    vi.useRealTimers();
  });

  it('should evict least recently used when at capacity', () => {
    const r1 = createRecord(1);
    const r2 = createRecord(2);
    const r3 = createRecord(3);
    const r4 = createRecord(4);

    cache.cacheRecordSync(createActionHash(1), r1);
    cache.cacheRecordSync(createActionHash(2), r2);
    cache.cacheRecordSync(createActionHash(3), r3);

    // Access r1 to make it recently used
    cache.getRecordSync(createActionHash(1));

    // Insert r4 -- should evict r2 (least recently used)
    cache.cacheRecordSync(createActionHash(4), r4);

    expect(cache.getRecordSync(createActionHash(1))).toBe(r1); // still here (was accessed)
    expect(cache.getRecordSync(createActionHash(2))).toBeNull(); // evicted
    expect(cache.getRecordSync(createActionHash(3))).toBe(r3);
    expect(cache.getRecordSync(createActionHash(4))).toBe(r4);
  });

  it('should report correct stats', () => {
    cache.cacheRecordSync(createActionHash(1), createRecord(1));
    cache.cacheRecordSync(createActionHash(2), createRecord(2));
    const stats = cache.getStats();
    expect(stats.records).toBe(2);
    expect(stats.recordMaxEntries).toBe(3);
  });
});

describe('NetworkCache - Record Dual-Keying', () => {
  let cache: NetworkCache;

  beforeEach(() => {
    cache = new NetworkCache();
  });

  it('should create alias when caching by action hash with entry_hash in content', () => {
    const actionHash = createActionHash(10);
    const entryHash = createEntryHash(20);
    const record = createRecord(10, 20);

    cache.cacheRecordSync(actionHash, record);

    // Should be findable by entry hash via alias
    expect(cache.getRecordSync(entryHash)).toBe(record);
  });

  it('should create alias when caching by entry hash with action hash in record', () => {
    const entryHash = createEntryHash(20);
    const record = createRecord(10, 20);

    cache.cacheRecordSync(entryHash, record);

    // Should be findable by action hash via alias
    const actionHash = createActionHash(10);
    expect(cache.getRecordSync(actionHash)).toBe(record);
  });

  it('should not create alias for records without entry hash', () => {
    const actionHash = createActionHash(10);
    const record = createRecord(10); // no entryValue
    cache.cacheRecordSync(actionHash, record);

    // Some random entry hash should not resolve
    expect(cache.getRecordSync(createEntryHash(99))).toBeNull();
  });
});

describe('NetworkCache - Links (LRU, no TTL)', () => {
  let cache: NetworkCache;

  beforeEach(() => {
    cache = new NetworkCache({ linkMaxEntries: 3 });
  });

  it('should cache and retrieve links by base address', () => {
    const base = createActionHash(50);
    const links = [createLink(1), createLink(2)];
    cache.cacheLinksSync(base, links);
    expect(cache.getLinksSync(base)).toBe(links);
  });

  it('should cache links with linkType key separately', () => {
    const base = createActionHash(50);
    const links1 = [createLink(1)];
    const links2 = [createLink(2)];

    cache.cacheLinksSync(base, links1, 1);
    cache.cacheLinksSync(base, links2, 2);

    expect(cache.getLinksSync(base, 1)).toBe(links1);
    expect(cache.getLinksSync(base, 2)).toBe(links2);
    expect(cache.getLinksSync(base)).toBeNull(); // no untyped cache entry
  });

  it('should never expire links (no TTL)', () => {
    const base = createActionHash(50);
    const links = [createLink(1)];
    cache.cacheLinksSync(base, links);

    vi.useFakeTimers();
    vi.advanceTimersByTime(60 * 60 * 1000); // 1 hour
    expect(cache.getLinksSync(base)).toBe(links);
    vi.useRealTimers();
  });

  it('should invalidate links by base address', () => {
    const base = createActionHash(50);
    cache.cacheLinksSync(base, [createLink(1)], 1);
    cache.cacheLinksSync(base, [createLink(2)], 2);

    cache.invalidateLinks(base); // invalidate all for this base
    expect(cache.getLinksSync(base, 1)).toBeNull();
    expect(cache.getLinksSync(base, 2)).toBeNull();
  });

  it('should invalidate links by specific linkType', () => {
    const base = createActionHash(50);
    cache.cacheLinksSync(base, [createLink(1)], 1);
    cache.cacheLinksSync(base, [createLink(2)], 2);

    cache.invalidateLinks(base, 1);
    expect(cache.getLinksSync(base, 1)).toBeNull();
    expect(cache.getLinksSync(base, 2)).not.toBeNull();
  });
});

describe('NetworkCache - Optimistic Link Merge', () => {
  let cache: NetworkCache;

  beforeEach(() => {
    cache = new NetworkCache();
  });

  it('should merge new link into existing cached set', () => {
    const base = createActionHash(50);
    const existing = [createLink(1, 50)];
    cache.cacheLinksSync(base, existing);

    const newLink = createLink(2, 50);
    cache.mergeLinkIntoCache(base, newLink);

    const result = cache.getLinksSync(base);
    expect(result).toHaveLength(2);
    expect(result![1]).toBe(newLink);
  });

  it('should merge into typed cache entries too', () => {
    const base = createActionHash(50);
    cache.cacheLinksSync(base, [createLink(3, 50)], 3);

    const newLink = createLink(3, 50);
    newLink.create_link_hash = createActionHash(200); // different hash
    cache.mergeLinkIntoCache(base, newLink);

    expect(cache.getLinksSync(base, 3)).toHaveLength(2);
  });

  it('should not duplicate on merge if same create_link_hash', () => {
    const base = createActionHash(50);
    const link = createLink(1, 50);
    cache.cacheLinksSync(base, [link]);

    cache.mergeLinkIntoCache(base, link);
    expect(cache.getLinksSync(base)).toHaveLength(1);
  });

  it('should remove link from cache on delete', () => {
    const base = createActionHash(50);
    const link1 = createLink(1, 50);
    const link2 = createLink(2, 50);
    cache.cacheLinksSync(base, [link1, link2]);

    cache.removeLinkFromCache(base, link1.create_link_hash);

    const result = cache.getLinksSync(base);
    expect(result).toHaveLength(1);
    expect(result![0]).toBe(link2);
  });

  it('should remove link from typed cache entries', () => {
    const base = createActionHash(50);
    const link = createLink(5, 50);
    cache.cacheLinksSync(base, [link], 5);

    cache.removeLinkFromCache(base, link.create_link_hash);
    expect(cache.getLinksSync(base, 5)).toHaveLength(0);
  });
});

describe('NetworkCache - Details (TTL)', () => {
  let cache: NetworkCache;

  beforeEach(() => {
    cache = new NetworkCache({ detailsTtl: 1000, detailsMaxEntries: 3 });
  });

  it('should cache and retrieve details', () => {
    const hash = createActionHash(1);
    const details = { source: 'network', details: { some: 'data' } };
    cache.cacheDetailsSync(hash, details);
    expect(cache.getDetailsSync(hash)).toBe(details);
  });

  it('should expire details after TTL', () => {
    const hash = createActionHash(1);
    cache.cacheDetailsSync(hash, { data: 'test' });

    vi.useFakeTimers();
    vi.advanceTimersByTime(1500); // past 1000ms TTL
    expect(cache.getDetailsSync(hash)).toBeNull();
    vi.useRealTimers();
  });

  it('should invalidate details', () => {
    const hash = createActionHash(1);
    cache.cacheDetailsSync(hash, { data: 'test' });
    cache.invalidateDetails(hash);
    expect(cache.getDetailsSync(hash)).toBeNull();
  });

  it('should report details count in stats', () => {
    cache.cacheDetailsSync(createActionHash(1), { a: 1 });
    cache.cacheDetailsSync(createActionHash(2), { b: 2 });
    expect(cache.getStats().details).toBe(2);
  });
});

describe('NetworkCache - Separate Pools', () => {
  it('should not let record capacity affect links', () => {
    const cache = new NetworkCache({ recordMaxEntries: 2, linkMaxEntries: 100 });

    // Fill records to capacity
    cache.cacheRecordSync(createActionHash(1), createRecord(1));
    cache.cacheRecordSync(createActionHash(2), createRecord(2));
    cache.cacheRecordSync(createActionHash(3), createRecord(3)); // evicts #1

    // Links should be unaffected
    const base = createActionHash(50);
    cache.cacheLinksSync(base, [createLink(1)]);
    expect(cache.getLinksSync(base)).not.toBeNull();
    expect(cache.getStats().links).toBe(1);
  });

  it('clear() should clear all pools', () => {
    const cache = new NetworkCache();
    cache.cacheRecordSync(createActionHash(1), createRecord(1));
    cache.cacheLinksSync(createActionHash(50), [createLink(1)]);
    cache.cacheDetailsSync(createActionHash(1), { data: 'test' });

    cache.clear();
    expect(cache.getStats().records).toBe(0);
    expect(cache.getStats().links).toBe(0);
    expect(cache.getStats().details).toBe(0);
  });
});

describe('NetworkCache - Legacy Options', () => {
  it('should map legacy maxEntries to linkMaxEntries', () => {
    const cache = new NetworkCache({ maxEntries: 2 });
    const base1 = createActionHash(50);
    const base2 = createActionHash(51);
    const base3 = createActionHash(52);

    cache.cacheLinksSync(base1, [createLink(1)]);
    cache.cacheLinksSync(base2, [createLink(2)]);
    cache.cacheLinksSync(base3, [createLink(3)]); // evicts base1

    expect(cache.getLinksSync(base1)).toBeNull();
    expect(cache.getLinksSync(base2)).not.toBeNull();
  });

  it('should map legacy ttl to detailsTtl', () => {
    const cache = new NetworkCache({ ttl: 500 });
    cache.cacheDetailsSync(createActionHash(1), { data: 'test' });

    vi.useFakeTimers();
    vi.advanceTimersByTime(600);
    expect(cache.getDetailsSync(createActionHash(1))).toBeNull();
    vi.useRealTimers();
  });
});

describe('NetworkCache - Link Deletion Clears Cache', () => {
  let cache: NetworkCache;

  beforeEach(() => {
    cache = new NetworkCache();
  });

  it('should remove deleted link from untyped cache entry', () => {
    const base = createActionHash(50);
    const link1 = createLink(1, 50);
    const link2 = createLink(2, 50);
    cache.cacheLinksSync(base, [link1, link2]);

    cache.removeLinkFromCache(base, link1.create_link_hash);

    const result = cache.getLinksSync(base);
    expect(result).toHaveLength(1);
    expect(result![0].link_type).toBe(2);
  });

  it('should remove deleted link from typed cache entry', () => {
    const base = createActionHash(50);
    const link = createLink(3, 50);
    cache.cacheLinksSync(base, [link], 3);

    cache.removeLinkFromCache(base, link.create_link_hash);

    expect(cache.getLinksSync(base, 3)).toHaveLength(0);
  });

  it('should remove link from both typed and untyped cache entries', () => {
    const base = createActionHash(50);
    const link = createLink(4, 50);

    // Cache the same link in both typed and untyped entries
    cache.cacheLinksSync(base, [link]);
    cache.cacheLinksSync(base, [link], 4);

    cache.removeLinkFromCache(base, link.create_link_hash);

    expect(cache.getLinksSync(base)).toHaveLength(0);
    expect(cache.getLinksSync(base, 4)).toHaveLength(0);
  });

  it('should not affect other base addresses when removing link', () => {
    const base1 = createActionHash(50);
    const base2 = createActionHash(51);
    const link1 = createLink(1, 50);
    const link2 = createLink(1, 51);

    cache.cacheLinksSync(base1, [link1]);
    cache.cacheLinksSync(base2, [link2]);

    cache.removeLinkFromCache(base1, link1.create_link_hash);

    expect(cache.getLinksSync(base1)).toHaveLength(0);
    expect(cache.getLinksSync(base2)).toHaveLength(1);
  });

  it('should handle removing non-existent link gracefully', () => {
    const base = createActionHash(50);
    const link = createLink(1, 50);
    cache.cacheLinksSync(base, [link]);

    // Try to remove a link that doesn't exist
    cache.removeLinkFromCache(base, createActionHash(255));

    expect(cache.getLinksSync(base)).toHaveLength(1);
  });
});

describe('NetworkCache - Details Invalidation on Record Invalidate', () => {
  let cache: NetworkCache;

  beforeEach(() => {
    cache = new NetworkCache();
  });

  it('should cache and retrieve details by hash', () => {
    const hash = createActionHash(1);
    const details = { source: 'network', details: { record: { entry: 'test' }, deletes: [], updates: [] } };
    cache.cacheDetailsSync(hash, details);
    expect(cache.getDetailsSync(hash)).toBe(details);
  });

  it('should invalidate details when invalidateDetails is called', () => {
    const hash = createActionHash(1);
    cache.cacheDetailsSync(hash, { data: 'test' });
    cache.invalidateDetails(hash);
    expect(cache.getDetailsSync(hash)).toBeNull();
  });

  it('should not affect records when invalidating details', () => {
    const hash = createActionHash(1);
    const record = createRecord(1);
    cache.cacheRecordSync(hash, record);
    cache.cacheDetailsSync(hash, { data: 'test' });

    cache.invalidateDetails(hash);

    expect(cache.getDetailsSync(hash)).toBeNull();
    expect(cache.getRecordSync(hash)).toBe(record);
  });
});
