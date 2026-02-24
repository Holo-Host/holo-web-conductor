/**
 * Tests for DHT chain recovery
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recoverChainFromDHT, type RecoveryProgress } from './chain-recovery';
import { MockNetworkService } from '../network/mock-service';
import type { NetworkRecord } from '../network/types';
import type { SignedActionHashed } from '../types/holochain-types';
import { HoloHashType, hashFrom32AndType } from '../hash';

/**
 * Cast wire-format signed action data to SignedActionHashed for test construction.
 * See store-recovered.test.ts for full rationale on the wire-format divergence.
 */
function wireSignedAction(data: Record<string, unknown>): SignedActionHashed {
  return data as unknown as SignedActionHashed;
}

// ============================================================================
// Test helpers
// ============================================================================

function mockCore32(seed: number): Uint8Array {
  const core = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    core[i] = (i * 17 + seed) % 256;
  }
  return core;
}

function mockActionHash(seed: number): Uint8Array {
  return hashFrom32AndType(mockCore32(seed), HoloHashType.Action);
}

function mockAgentPubKey(seed: number): Uint8Array {
  return hashFrom32AndType(mockCore32(seed), HoloHashType.Agent);
}

function mockDnaHash(seed: number): Uint8Array {
  return hashFrom32AndType(mockCore32(seed), HoloHashType.Dna);
}

/**
 * Build a minimal NetworkRecord for testing.
 * action_seq is embedded in the signed_action content.
 */
function makeNetworkRecord(actionSeq: number, hashSeed: number): NetworkRecord {
  const hash = mockActionHash(hashSeed);
  return {
    signed_action: wireSignedAction({
      hashed: {
        hash,
        content: {
          type: 'Create',
          action_seq: actionSeq,
          timestamp: BigInt(actionSeq) * BigInt(1_000_000),
          author: mockAgentPubKey(99),
        },
      },
      signature: new Uint8Array(64).fill(0xab),
    }),
    entry: 'NotApplicable',
  };
}

function makeNetworkRecordWithEntry(actionSeq: number, hashSeed: number): NetworkRecord {
  const hash = mockActionHash(hashSeed);
  const entryPayload = new Uint8Array([1, 2, 3, actionSeq]);
  return {
    signed_action: wireSignedAction({
      hashed: {
        hash,
        content: {
          type: 'Create',
          action_seq: actionSeq,
          timestamp: BigInt(actionSeq) * BigInt(1_000_000),
          author: mockAgentPubKey(99),
        },
      },
      signature: new Uint8Array(64).fill(0xab),
    }),
    entry: { Present: { entry_type: 'App', entry: entryPayload } },
  };
}

// ============================================================================
// Fixtures
// ============================================================================

const dnaHash = mockDnaHash(1);
const agentPubKey = mockAgentPubKey(2);

// ============================================================================
// Tests
// ============================================================================

describe('recoverChainFromDHT', () => {
  let mockNetwork: MockNetworkService;
  let progressCalls: RecoveryProgress[];
  let onProgress: (p: RecoveryProgress) => void;

  beforeEach(() => {
    mockNetwork = new MockNetworkService();
    progressCalls = [];
    onProgress = (p: RecoveryProgress) => { progressCalls.push({ ...p, errors: [...p.errors] }); };
  });

  // ── 1. Empty activity (null) ────────────────────────────────────────────────

  describe('empty activity (null response)', () => {
    it('throws "Agent not found on DHT" when getAgentActivitySync returns null', () => {
      // MockNetworkService.getAgentActivitySync returns null by default
      expect(() =>
        recoverChainFromDHT(dnaHash, agentPubKey, mockNetwork, onProgress)
      ).toThrow('Agent not found on DHT');
    });

    it('reports discovering status before throwing', () => {
      try {
        recoverChainFromDHT(dnaHash, agentPubKey, mockNetwork, onProgress);
      } catch {
        // expected
      }
      expect(progressCalls.length).toBeGreaterThanOrEqual(1);
      expect(progressCalls[0].status).toBe('discovering');
    });
  });

  // ── 2. Hashes variant ────────────────────────────────────────────────────────

  describe('Hashes variant', () => {
    it('fetches a record for each hash entry and returns them', () => {
      const hash0 = mockActionHash(10);
      const hash1 = mockActionHash(11);

      const record0 = makeNetworkRecord(0, 10);
      const record1 = makeNetworkRecord(1, 11);

      mockNetwork.addRecord(hash0, record0);
      mockNetwork.addRecord(hash1, record1);

      // Override getAgentActivitySync to return Hashes variant
      vi.spyOn(mockNetwork, 'getAgentActivitySync').mockReturnValue({
        agent: agentPubKey,
        valid_activity: { Hashes: [[0, hash0], [1, hash1]] },
        rejected_activity: 'NotRequested',
        status: 'Empty',
        highest_observed: null,
        warrants: [],
      });

      const { records, errors } = recoverChainFromDHT(dnaHash, agentPubKey, mockNetwork, onProgress);

      expect(errors).toHaveLength(0);
      expect(records).toHaveLength(2);
      expect(records[0].actionSeq).toBe(0);
      expect(records[1].actionSeq).toBe(1);
    });

    it('calls getRecordSync for each hash in the Hashes variant', () => {
      const hash0 = mockActionHash(10);
      const hash1 = mockActionHash(11);

      mockNetwork.addRecord(hash0, makeNetworkRecord(0, 10));
      mockNetwork.addRecord(hash1, makeNetworkRecord(1, 11));

      vi.spyOn(mockNetwork, 'getAgentActivitySync').mockReturnValue({
        agent: agentPubKey,
        valid_activity: { Hashes: [[0, hash0], [1, hash1]] },
        rejected_activity: 'NotRequested',
        status: 'Empty',
        highest_observed: null,
        warrants: [],
      });

      recoverChainFromDHT(dnaHash, agentPubKey, mockNetwork, onProgress);

      const recordCalls = mockNetwork
        .getCallLog()
        .filter((c) => c.method === 'getRecordSync');
      expect(recordCalls).toHaveLength(2);
    });

    it('correctly populates entry when NetworkEntry is Present', () => {
      const hash0 = mockActionHash(20);
      const record0 = makeNetworkRecordWithEntry(0, 20);
      mockNetwork.addRecord(hash0, record0);

      vi.spyOn(mockNetwork, 'getAgentActivitySync').mockReturnValue({
        agent: agentPubKey,
        valid_activity: { Hashes: [[0, hash0]] },
        rejected_activity: 'NotRequested',
        status: 'Empty',
        highest_observed: null,
        warrants: [],
      });

      const { records } = recoverChainFromDHT(dnaHash, agentPubKey, mockNetwork, onProgress);

      expect(records).toHaveLength(1);
      expect(records[0].entry).not.toBeNull();
      expect(records[0].entry!.entry_type).toBe('App');
    });

    it('entry is null when NetworkEntry is NotApplicable', () => {
      const hash0 = mockActionHash(30);
      const record0 = makeNetworkRecord(0, 30); // entry = 'NotApplicable'
      mockNetwork.addRecord(hash0, record0);

      vi.spyOn(mockNetwork, 'getAgentActivitySync').mockReturnValue({
        agent: agentPubKey,
        valid_activity: { Hashes: [[0, hash0]] },
        rejected_activity: 'NotRequested',
        status: 'Empty',
        highest_observed: null,
        warrants: [],
      });

      const { records } = recoverChainFromDHT(dnaHash, agentPubKey, mockNetwork, onProgress);
      expect(records[0].entry).toBeNull();
    });
  });

  // ── 3. Full variant ──────────────────────────────────────────────────────────

  describe('Full variant', () => {
    it('uses embedded records directly without calling getRecordSync', () => {
      const record0 = makeNetworkRecord(0, 40);
      const record1 = makeNetworkRecord(1, 41);

      vi.spyOn(mockNetwork, 'getAgentActivitySync').mockReturnValue({
        agent: agentPubKey,
        valid_activity: { Full: [record0, record1] },
        rejected_activity: 'NotRequested',
        status: 'Empty',
        highest_observed: null,
        warrants: [],
      });

      const { records, errors } = recoverChainFromDHT(dnaHash, agentPubKey, mockNetwork, onProgress);

      expect(errors).toHaveLength(0);
      expect(records).toHaveLength(2);

      const recordSyncCalls = mockNetwork
        .getCallLog()
        .filter((c) => c.method === 'getRecordSync');
      expect(recordSyncCalls).toHaveLength(0);
    });

    it('returns records sorted by action_seq', () => {
      const record0 = makeNetworkRecord(0, 50);
      const record1 = makeNetworkRecord(1, 51);

      // Pass them in reverse order
      vi.spyOn(mockNetwork, 'getAgentActivitySync').mockReturnValue({
        agent: agentPubKey,
        valid_activity: { Full: [record1, record0] },
        rejected_activity: 'NotRequested',
        status: 'Empty',
        highest_observed: null,
        warrants: [],
      });

      const { records } = recoverChainFromDHT(dnaHash, agentPubKey, mockNetwork, onProgress);

      expect(records[0].actionSeq).toBe(0);
      expect(records[1].actionSeq).toBe(1);
    });
  });

  // ── 4. Missing record (getRecordSync returns null) ────────────────────────────

  describe('missing record', () => {
    it('records an error and continues when getRecordSync returns null', () => {
      const hash0 = mockActionHash(60);
      const hash1 = mockActionHash(61);

      // Only register record for hash1; hash0 will return null
      mockNetwork.addRecord(hash1, makeNetworkRecord(1, 61));

      vi.spyOn(mockNetwork, 'getAgentActivitySync').mockReturnValue({
        agent: agentPubKey,
        valid_activity: { Hashes: [[0, hash0], [1, hash1]] },
        rejected_activity: 'NotRequested',
        status: 'Empty',
        highest_observed: null,
        warrants: [],
      });

      const { records, errors } = recoverChainFromDHT(dnaHash, agentPubKey, mockNetwork, onProgress);

      // Should still return the one record that was found
      expect(records).toHaveLength(1);
      expect(records[0].actionSeq).toBe(1);

      // And report the missing record as an error
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/seq=0/);
    });

    it('records an error when getRecordSync throws', () => {
      const hash0 = mockActionHash(70);
      const hash1 = mockActionHash(71);

      mockNetwork.addRecord(hash1, makeNetworkRecord(1, 71));

      vi.spyOn(mockNetwork, 'getAgentActivitySync').mockReturnValue({
        agent: agentPubKey,
        valid_activity: { Hashes: [[0, hash0], [1, hash1]] },
        rejected_activity: 'NotRequested',
        status: 'Empty',
        highest_observed: null,
        warrants: [],
      });

      // Make getRecordSync throw for hash0 (the unavailable one)
      const originalGetRecordSync = mockNetwork.getRecordSync.bind(mockNetwork);
      vi.spyOn(mockNetwork, 'getRecordSync').mockImplementation((dna, hash, opts) => {
        if (hash === hash0) throw new Error('Network timeout');
        return originalGetRecordSync(dna, hash, opts);
      });

      const { records, errors } = recoverChainFromDHT(dnaHash, agentPubKey, mockNetwork, onProgress);

      expect(records).toHaveLength(1);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(/Network timeout/);
    });
  });

  // ── 5. Progress reporting ────────────────────────────────────────────────────

  describe('progress reporting', () => {
    it('calls onProgress with discovering status first', () => {
      vi.spyOn(mockNetwork, 'getAgentActivitySync').mockReturnValue({
        agent: agentPubKey,
        valid_activity: { Hashes: [] },
        rejected_activity: 'NotRequested',
        status: 'Empty',
        highest_observed: null,
        warrants: [],
      });

      recoverChainFromDHT(dnaHash, agentPubKey, mockNetwork, onProgress);

      expect(progressCalls[0].status).toBe('discovering');
    });

    it('calls onProgress with fetching status during record retrieval', () => {
      const hash0 = mockActionHash(80);
      const hash1 = mockActionHash(81);
      mockNetwork.addRecord(hash0, makeNetworkRecord(0, 80));
      mockNetwork.addRecord(hash1, makeNetworkRecord(1, 81));

      vi.spyOn(mockNetwork, 'getAgentActivitySync').mockReturnValue({
        agent: agentPubKey,
        valid_activity: { Hashes: [[0, hash0], [1, hash1]] },
        rejected_activity: 'NotRequested',
        status: 'Empty',
        highest_observed: null,
        warrants: [],
      });

      recoverChainFromDHT(dnaHash, agentPubKey, mockNetwork, onProgress);

      const fetchingCalls = progressCalls.filter((p) => p.status === 'fetching');
      expect(fetchingCalls.length).toBeGreaterThan(0);

      // The totalActions should be set correctly
      expect(fetchingCalls[0].totalActions).toBe(2);
    });

    it('calls onProgress with complete status at the end', () => {
      const hash0 = mockActionHash(90);
      mockNetwork.addRecord(hash0, makeNetworkRecord(0, 90));

      vi.spyOn(mockNetwork, 'getAgentActivitySync').mockReturnValue({
        agent: agentPubKey,
        valid_activity: { Hashes: [[0, hash0]] },
        rejected_activity: 'NotRequested',
        status: 'Empty',
        highest_observed: null,
        warrants: [],
      });

      recoverChainFromDHT(dnaHash, agentPubKey, mockNetwork, onProgress);

      const lastProgress = progressCalls[progressCalls.length - 1];
      expect(lastProgress.status).toBe('complete');
    });

    it('reports correct recoveredActions count', () => {
      const hash0 = mockActionHash(100);
      const hash1 = mockActionHash(101);
      mockNetwork.addRecord(hash0, makeNetworkRecord(0, 100));
      mockNetwork.addRecord(hash1, makeNetworkRecord(1, 101));

      vi.spyOn(mockNetwork, 'getAgentActivitySync').mockReturnValue({
        agent: agentPubKey,
        valid_activity: { Hashes: [[0, hash0], [1, hash1]] },
        rejected_activity: 'NotRequested',
        status: 'Empty',
        highest_observed: null,
        warrants: [],
      });

      recoverChainFromDHT(dnaHash, agentPubKey, mockNetwork, onProgress);

      const lastProgress = progressCalls[progressCalls.length - 1];
      expect(lastProgress.recoveredActions).toBe(2);
      expect(lastProgress.failedActions).toBe(0);
    });

    it('reports failedActions count for missing records', () => {
      const hash0 = mockActionHash(110);
      const hash1 = mockActionHash(111);
      // Only hash1 found; hash0 is missing
      mockNetwork.addRecord(hash1, makeNetworkRecord(1, 111));

      vi.spyOn(mockNetwork, 'getAgentActivitySync').mockReturnValue({
        agent: agentPubKey,
        valid_activity: { Hashes: [[0, hash0], [1, hash1]] },
        rejected_activity: 'NotRequested',
        status: 'Empty',
        highest_observed: null,
        warrants: [],
      });

      recoverChainFromDHT(dnaHash, agentPubKey, mockNetwork, onProgress);

      const lastProgress = progressCalls[progressCalls.length - 1];
      expect(lastProgress.recoveredActions).toBe(1);
      expect(lastProgress.failedActions).toBe(1);
      expect(lastProgress.errors).toHaveLength(1);
    });
  });

  // ── 6. Sort order ────────────────────────────────────────────────────────────

  describe('sort order', () => {
    it('sorts Hashes variant entries by action_seq ascending before fetching', () => {
      // Provide hashes out of order (seq 2, 0, 1)
      const hash0 = mockActionHash(120);
      const hash1 = mockActionHash(121);
      const hash2 = mockActionHash(122);

      mockNetwork.addRecord(hash0, makeNetworkRecord(0, 120));
      mockNetwork.addRecord(hash1, makeNetworkRecord(1, 121));
      mockNetwork.addRecord(hash2, makeNetworkRecord(2, 122));

      vi.spyOn(mockNetwork, 'getAgentActivitySync').mockReturnValue({
        agent: agentPubKey,
        valid_activity: { Hashes: [[2, hash2], [0, hash0], [1, hash1]] },
        rejected_activity: 'NotRequested',
        status: 'Empty',
        highest_observed: null,
        warrants: [],
      });

      const { records } = recoverChainFromDHT(dnaHash, agentPubKey, mockNetwork, onProgress);

      expect(records).toHaveLength(3);
      expect(records[0].actionSeq).toBe(0);
      expect(records[1].actionSeq).toBe(1);
      expect(records[2].actionSeq).toBe(2);
    });

    it('sorts Full variant records by action_seq ascending', () => {
      // NetworkRecords in reverse order
      const record2 = makeNetworkRecord(2, 130);
      const record0 = makeNetworkRecord(0, 131);
      const record1 = makeNetworkRecord(1, 132);

      vi.spyOn(mockNetwork, 'getAgentActivitySync').mockReturnValue({
        agent: agentPubKey,
        valid_activity: { Full: [record2, record0, record1] },
        rejected_activity: 'NotRequested',
        status: 'Empty',
        highest_observed: null,
        warrants: [],
      });

      const { records } = recoverChainFromDHT(dnaHash, agentPubKey, mockNetwork, onProgress);

      expect(records).toHaveLength(3);
      expect(records[0].actionSeq).toBe(0);
      expect(records[1].actionSeq).toBe(1);
      expect(records[2].actionSeq).toBe(2);
    });
  });

  // ── 7. NotRequested variant ──────────────────────────────────────────────────

  describe('NotRequested variant', () => {
    it('returns empty records and no errors when valid_activity is NotRequested', () => {
      vi.spyOn(mockNetwork, 'getAgentActivitySync').mockReturnValue({
        agent: agentPubKey,
        valid_activity: 'NotRequested',
        rejected_activity: 'NotRequested',
        status: 'Empty',
        highest_observed: null,
        warrants: [],
      });

      const { records, errors } = recoverChainFromDHT(dnaHash, agentPubKey, mockNetwork, onProgress);

      expect(records).toHaveLength(0);
      expect(errors).toHaveLength(0);

      const lastProgress = progressCalls[progressCalls.length - 1];
      expect(lastProgress.status).toBe('complete');
    });
  });

  // ── 8. Timestamp extraction ──────────────────────────────────────────────────

  describe('timestamp extraction', () => {
    it('extracts bigint timestamp from signedAction content', () => {
      const hash0 = mockActionHash(140);
      const expectedTimestamp = BigInt(1_234_567_890_000_000);
      const record: NetworkRecord = {
        signed_action: wireSignedAction({
          hashed: {
            hash: hash0,
            content: {
              type: 'Create',
              action_seq: 0,
              timestamp: expectedTimestamp,
              author: mockAgentPubKey(99),
            },
          },
          signature: new Uint8Array(64),
        }),
        entry: 'NotApplicable',
      };
      mockNetwork.addRecord(hash0, record);

      vi.spyOn(mockNetwork, 'getAgentActivitySync').mockReturnValue({
        agent: agentPubKey,
        valid_activity: { Hashes: [[0, hash0]] },
        rejected_activity: 'NotRequested',
        status: 'Empty',
        highest_observed: null,
        warrants: [],
      });

      const { records } = recoverChainFromDHT(dnaHash, agentPubKey, mockNetwork, onProgress);

      expect(records[0].timestamp).toBe(expectedTimestamp);
    });

    it('converts numeric timestamp to bigint', () => {
      const hash0 = mockActionHash(150);
      const record: NetworkRecord = {
        signed_action: wireSignedAction({
          hashed: {
            hash: hash0,
            content: {
              type: 'Create',
              action_seq: 0,
              timestamp: 999_999, // numeric, as it may come from JSON
              author: mockAgentPubKey(99),
            },
          },
          signature: new Uint8Array(64),
        }),
        entry: 'NotApplicable',
      };
      mockNetwork.addRecord(hash0, record);

      vi.spyOn(mockNetwork, 'getAgentActivitySync').mockReturnValue({
        agent: agentPubKey,
        valid_activity: { Hashes: [[0, hash0]] },
        rejected_activity: 'NotRequested',
        status: 'Empty',
        highest_observed: null,
        warrants: [],
      });

      const { records } = recoverChainFromDHT(dnaHash, agentPubKey, mockNetwork, onProgress);

      expect(typeof records[0].timestamp).toBe('bigint');
      expect(records[0].timestamp).toBe(BigInt(999_999));
    });
  });
});
