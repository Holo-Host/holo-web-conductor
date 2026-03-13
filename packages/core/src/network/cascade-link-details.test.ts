/**
 * Tests for Cascade.fetchLinks() interaction with the link details cache.
 *
 * These tests verify that when the network is unavailable and the regular
 * link cache is empty, fetchLinks() falls back to deriving live links from
 * the link details cache (filtering out deleted links).
 *
 * Uses real Cascade and real NetworkCache instances -- only the storage
 * and network service are mocked.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Cascade } from './cascade';
import { NetworkCache } from './cache';
import type { NetworkLink, NetworkService, CachedLinkDetail } from './types';
import type { StorageProvider } from '../storage/storage-provider';

// Deterministic fake hashes (no crypto needed)
function fakeHash(prefix: number[], fill: number): Uint8Array {
  const h = new Uint8Array(39);
  h[0] = prefix[0];
  h[1] = prefix[1];
  h[2] = prefix[2];
  h.fill(fill, 3);
  return h;
}
const entryPrefix = [132, 33, 36];
const actionPrefix = [132, 41, 36];
const agentPrefix = [132, 32, 36];

const baseAddress = fakeHash(entryPrefix, 1);
const dnaHash = fakeHash(entryPrefix, 99);
const agentPubKey = fakeHash(agentPrefix, 42);

function makeNetworkLink(fill: number, linkType = 0): NetworkLink {
  return {
    create_link_hash: fakeHash(actionPrefix, fill),
    base: baseAddress,
    target: fakeHash(entryPrefix, fill + 100),
    zome_index: 0,
    link_type: linkType,
    tag: new Uint8Array([fill]),
    timestamp: 1000000 + fill,
    author: agentPubKey,
  };
}

/** Minimal storage mock -- returns no local links */
function emptyStorage(): StorageProvider {
  return {
    getLinks: () => [],
    getAction: () => null,
    getActionByEntryHash: () => null,
    getEntry: () => null,
    getDetails: () => null,
    getEntryDetails: () => null,
  } as unknown as StorageProvider;
}

/** Network service that is unavailable (simulates offline) */
const unavailableNetwork: NetworkService = {
  isAvailable: () => false,
  getLinkerUrl: () => null,
  getRecordSync: () => null,
  getLinksSync: () => [],
  getDetailsSync: () => null,
  countLinksSync: () => 0,
  getAgentActivitySync: () => null,
  mustGetAgentActivitySync: () => null,
};

describe('Cascade.fetchLinks - link details cache fallback', () => {
  let cache: NetworkCache;

  beforeEach(() => {
    cache = new NetworkCache();
  });

  it('derives live links from details cache when network is unavailable and link cache is empty', () => {
    // Pre-populate the link details cache with 3 links:
    //   linkA: live (no deletes)
    //   linkB: deleted (has deleteHashes)
    //   linkC: live (no deletes)
    const linkA = makeNetworkLink(1);
    const linkB = makeNetworkLink(2);
    const linkC = makeNetworkLink(3);
    const details: CachedLinkDetail[] = [
      { create: linkA, deleteHashes: [] },
      { create: linkB, deleteHashes: [fakeHash(actionPrefix, 200)] },
      { create: linkC, deleteHashes: [] },
    ];
    cache.cacheLinkDetailsSync(baseAddress, details);

    // No link cache populated, network unavailable
    const cascade = new Cascade(emptyStorage(), cache, unavailableNetwork);
    const result = cascade.fetchLinks(dnaHash, agentPubKey, baseAddress);

    // Should return only the 2 live links (A and C), not deleted B
    expect(result).toHaveLength(2);
    const hashes = result.map(l => l.create_link_hash);
    expect(hashes).toContainEqual(linkA.create_link_hash);
    expect(hashes).toContainEqual(linkC.create_link_hash);
    expect(hashes).not.toContainEqual(linkB.create_link_hash);
  });

  it('returns empty when all details-cached links are deleted', () => {
    const linkA = makeNetworkLink(1);
    const linkB = makeNetworkLink(2);
    const details: CachedLinkDetail[] = [
      { create: linkA, deleteHashes: [fakeHash(actionPrefix, 200)] },
      { create: linkB, deleteHashes: [fakeHash(actionPrefix, 201)] },
    ];
    cache.cacheLinkDetailsSync(baseAddress, details);

    const cascade = new Cascade(emptyStorage(), cache, unavailableNetwork);
    const result = cascade.fetchLinks(dnaHash, agentPubKey, baseAddress);

    expect(result).toHaveLength(0);
  });

  it('deduplicates links present in both link cache and details cache', () => {
    const linkA = makeNetworkLink(1);
    const linkB = makeNetworkLink(2);

    // Link cache has linkA
    cache.cacheLinksSync(baseAddress, [linkA]);

    // Details cache has linkA (live) + linkB (live)
    cache.cacheLinkDetailsSync(baseAddress, [
      { create: linkA, deleteHashes: [] },
      { create: linkB, deleteHashes: [] },
    ]);

    const cascade = new Cascade(emptyStorage(), cache, unavailableNetwork);
    const result = cascade.fetchLinks(dnaHash, agentPubKey, baseAddress);

    // Should have both A and B, with no duplicate of A
    expect(result).toHaveLength(2);
    const hashes = result.map(l => l.create_link_hash);
    expect(hashes).toContainEqual(linkA.create_link_hash);
    expect(hashes).toContainEqual(linkB.create_link_hash);
  });

  it('does not consult details cache when network fetch succeeds', () => {
    const linkFromNetwork = makeNetworkLink(1);
    const linkOnlyInDetails = makeNetworkLink(2);

    // Details cache has an extra link the network doesn't return
    cache.cacheLinkDetailsSync(baseAddress, [
      { create: linkFromNetwork, deleteHashes: [] },
      { create: linkOnlyInDetails, deleteHashes: [] },
    ]);

    // Network is available and returns only linkFromNetwork
    const onlineNetwork: NetworkService = {
      ...unavailableNetwork,
      isAvailable: () => true,
      getLinksSync: () => [linkFromNetwork],
    };

    const cascade = new Cascade(emptyStorage(), cache, onlineNetwork);
    const result = cascade.fetchLinks(dnaHash, agentPubKey, baseAddress);

    // Should ONLY have the network result, not the extra from details cache
    // (details fallback is only used when network is unavailable)
    expect(result).toHaveLength(1);
    expect(result[0].create_link_hash).toEqual(linkFromNetwork.create_link_hash);
  });

  it('respects linkType filter when reading from details cache', () => {
    const linkType0 = makeNetworkLink(1, 0);
    const linkType3 = makeNetworkLink(2, 3);

    // Cache details under linkType=3 key
    cache.cacheLinkDetailsSync(baseAddress, [
      { create: linkType3, deleteHashes: [] },
    ], 3);

    // Cache details under no-linkType key (should have type 0)
    cache.cacheLinkDetailsSync(baseAddress, [
      { create: linkType0, deleteHashes: [] },
    ]);

    const cascade = new Cascade(emptyStorage(), cache, unavailableNetwork);

    // Query with linkType=3 filter
    const result = cascade.fetchLinks(dnaHash, agentPubKey, baseAddress, { linkType: 3 });

    // Should only get the type-3 link
    expect(result).toHaveLength(1);
    expect(result[0].create_link_hash).toEqual(linkType3.create_link_hash);
  });
});
