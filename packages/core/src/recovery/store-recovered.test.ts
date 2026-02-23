/**
 * Tests for the storage write path of chain recovery.
 *
 * These test buildStorageAction, buildStorageEntry, and storeRecoveredRecords —
 * the mapping from RecoveredRecord (network shape) to StoredAction/StoredEntry
 * (storage shape). This is the critical untested gap: the ribosome worker's
 * RECOVER_CHAIN handler depends on this mapping being correct.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildStorageAction,
  buildStorageEntry,
  storeRecoveredRecords,
  type RecoveredRecord,
} from './chain-recovery';
import { HoloHashType, hashFrom32AndType } from '../hash';
import type { StorageProvider } from '../storage/storage-provider';

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

function mockEntryHash(seed: number): Uint8Array {
  return hashFrom32AndType(mockCore32(seed), HoloHashType.Entry);
}

function mockAgentPubKey(seed: number): Uint8Array {
  return hashFrom32AndType(mockCore32(seed), HoloHashType.Agent);
}

function mockDnaHash(seed: number): Uint8Array {
  return hashFrom32AndType(mockCore32(seed), HoloHashType.Dna);
}

const dnaHash = mockDnaHash(1);
const agentPubKey = mockAgentPubKey(2);

/**
 * Build a RecoveredRecord that mimics what recoverChainFromDHT returns
 * for a Create action with an entry.
 */
function makeCreateRecord(seq: number, opts?: {
  entryHash?: Uint8Array;
  entryData?: Uint8Array;
  prevAction?: Uint8Array;
  author?: Uint8Array;
  entryType?: any;
}): RecoveredRecord {
  const actionHash = mockActionHash(seq + 200);
  const entryHash = opts?.entryHash ?? mockEntryHash(seq + 300);
  const prevAction = opts?.prevAction ?? (seq > 0 ? mockActionHash(seq + 199) : null);
  const author = opts?.author ?? agentPubKey;
  const entryData = opts?.entryData ?? new Uint8Array([10, 20, 30, seq]);
  const entryType = opts?.entryType ?? { zome_id: 0, entry_index: 1 };

  return {
    actionHash,
    signedAction: {
      hashed: {
        hash: actionHash,
        content: {
          type: 'Create',
          action_seq: seq,
          timestamp: BigInt(seq) * BigInt(1_000_000),
          author,
          prev_action: prevAction,
          entry_hash: entryHash,
          entry_type: entryType,
        },
      },
      signature: new Uint8Array(64).fill(0xab),
    },
    entry: { entry_type: entryType, entry: entryData },
    actionSeq: seq,
    timestamp: BigInt(seq) * BigInt(1_000_000),
  };
}

/**
 * Build a RecoveredRecord for an Update action.
 */
function makeUpdateRecord(seq: number, opts: {
  originalActionHash: Uint8Array;
  originalEntryHash: Uint8Array;
}): RecoveredRecord {
  const actionHash = mockActionHash(seq + 200);
  const entryHash = mockEntryHash(seq + 300);
  const prevAction = mockActionHash(seq + 199);
  const entryData = new Uint8Array([40, 50, 60, seq]);

  return {
    actionHash,
    signedAction: {
      hashed: {
        hash: actionHash,
        content: {
          type: 'Update',
          action_seq: seq,
          timestamp: BigInt(seq) * BigInt(1_000_000),
          author: agentPubKey,
          prev_action: prevAction,
          entry_hash: entryHash,
          entry_type: { zome_id: 0, entry_index: 1 },
          original_action_address: opts.originalActionHash,
          original_entry_address: opts.originalEntryHash,
        },
      },
      signature: new Uint8Array(64).fill(0xcd),
    },
    entry: { entry_type: { zome_id: 0, entry_index: 1 }, entry: entryData },
    actionSeq: seq,
    timestamp: BigInt(seq) * BigInt(1_000_000),
  };
}

/**
 * Build a RecoveredRecord for a Delete action.
 */
function makeDeleteRecord(seq: number, opts: {
  deletesActionHash: Uint8Array;
  deletesEntryHash: Uint8Array;
}): RecoveredRecord {
  const actionHash = mockActionHash(seq + 200);
  const prevAction = mockActionHash(seq + 199);

  return {
    actionHash,
    signedAction: {
      hashed: {
        hash: actionHash,
        content: {
          type: 'Delete',
          action_seq: seq,
          timestamp: BigInt(seq) * BigInt(1_000_000),
          author: agentPubKey,
          prev_action: prevAction,
          deletes_address: opts.deletesActionHash,
          deletes_entry_address: opts.deletesEntryHash,
        },
      },
      signature: new Uint8Array(64).fill(0xef),
    },
    entry: null,
    actionSeq: seq,
    timestamp: BigInt(seq) * BigInt(1_000_000),
  };
}

/**
 * Build a RecoveredRecord for a CreateLink action.
 */
function makeCreateLinkRecord(seq: number, opts: {
  baseAddress: Uint8Array;
  targetAddress: Uint8Array;
  linkType?: number;
  tag?: Uint8Array;
}): RecoveredRecord {
  const actionHash = mockActionHash(seq + 200);
  const prevAction = mockActionHash(seq + 199);

  return {
    actionHash,
    signedAction: {
      hashed: {
        hash: actionHash,
        content: {
          type: 'CreateLink',
          action_seq: seq,
          timestamp: BigInt(seq) * BigInt(1_000_000),
          author: agentPubKey,
          prev_action: prevAction,
          base_address: opts.baseAddress,
          target_address: opts.targetAddress,
          zome_index: 0,
          link_type: opts.linkType ?? 3,
          tag: opts.tag ?? new Uint8Array([0x01, 0x02]),
        },
      },
      signature: new Uint8Array(64).fill(0xdd),
    },
    entry: null,
    actionSeq: seq,
    timestamp: BigInt(seq) * BigInt(1_000_000),
  };
}

/**
 * Build a RecoveredRecord for a Dna genesis action.
 */
function makeDnaRecord(): RecoveredRecord {
  const actionHash = mockActionHash(250);
  return {
    actionHash,
    signedAction: {
      hashed: {
        hash: actionHash,
        content: {
          type: 'Dna',
          action_seq: 0,
          timestamp: BigInt(1_000_000),
          author: agentPubKey,
          hash: dnaHash,
        },
      },
      signature: new Uint8Array(64).fill(0x11),
    },
    entry: null,
    actionSeq: 0,
    timestamp: BigInt(1_000_000),
  };
}

/**
 * Build a RecoveredRecord with no action content (malformed).
 */
function makeBrokenRecord(seq: number): RecoveredRecord {
  return {
    actionHash: mockActionHash(seq + 200),
    signedAction: { hashed: { hash: mockActionHash(seq + 200), content: null } },
    entry: null,
    actionSeq: seq,
    timestamp: BigInt(0),
  };
}

/**
 * Create a mock StorageProvider with vi.fn() for all methods we care about.
 */
function createMockStorage() {
  const actions: any[] = [];
  const entries: any[] = [];
  let chainHead: any = null;

  return {
    putAction: vi.fn((action: any) => { actions.push(action); }),
    putEntry: vi.fn((entry: any) => { entries.push(entry); }),
    updateChainHead: vi.fn((_dna, _agent, seq, hash, ts) => {
      chainHead = { actionSeq: seq, actionHash: hash, timestamp: ts };
    }),
    // Expose captured data for assertions
    getStoredActions: () => actions,
    getStoredEntries: () => entries,
    getChainHead: () => chainHead,
  };
}

// ============================================================================
// buildStorageAction tests
// ============================================================================

describe('buildStorageAction', () => {
  it('maps a Create record to a StoredAction with correct fields', () => {
    const record = makeCreateRecord(5);
    const action = buildStorageAction(record, agentPubKey);

    expect(action.actionType).toBe('Create');
    expect(action.actionSeq).toBe(5);
    expect(action.actionHash).toBe(record.actionHash);
    expect(action.timestamp).toBe(BigInt(5_000_000));
    expect(action.signature).toEqual(new Uint8Array(64).fill(0xab));
    expect(action.author).toEqual(agentPubKey);
    expect(action.prevActionHash).toBeInstanceOf(Uint8Array);
    expect(action.prevActionHash).not.toBeNull();
  });

  it('maps entryHash and entryType for entry-creating actions', () => {
    const entryHash = mockEntryHash(99);
    const entryType = { zome_id: 2, entry_index: 5 };
    const record = makeCreateRecord(3, { entryHash, entryType });
    const action = buildStorageAction(record, agentPubKey);

    expect((action as any).entryHash).toEqual(entryHash);
    expect((action as any).entryType).toEqual(entryType);
  });

  it('maps Update action with original hashes', () => {
    const origAction = mockActionHash(100);
    const origEntry = mockEntryHash(100);
    const record = makeUpdateRecord(4, {
      originalActionHash: origAction,
      originalEntryHash: origEntry,
    });
    const action = buildStorageAction(record, agentPubKey);

    expect(action.actionType).toBe('Update');
    expect((action as any).originalActionHash).toEqual(origAction);
    expect((action as any).originalEntryHash).toEqual(origEntry);
  });

  it('maps Delete action with deletes hashes', () => {
    const deletesAction = mockActionHash(101);
    const deletesEntry = mockEntryHash(101);
    const record = makeDeleteRecord(6, {
      deletesActionHash: deletesAction,
      deletesEntryHash: deletesEntry,
    });
    const action = buildStorageAction(record, agentPubKey);

    expect(action.actionType).toBe('Delete');
    expect((action as any).deletesActionHash).toEqual(deletesAction);
    expect((action as any).deletesEntryHash).toEqual(deletesEntry);
  });

  it('maps CreateLink action with base, target, linkType, and tag', () => {
    const base = mockEntryHash(50);
    const target = mockEntryHash(51);
    const tag = new Uint8Array([0xca, 0xfe]);
    const record = makeCreateLinkRecord(7, {
      baseAddress: base,
      targetAddress: target,
      linkType: 5,
      tag,
    });
    const action = buildStorageAction(record, agentPubKey);

    expect(action.actionType).toBe('CreateLink');
    expect((action as any).baseAddress).toEqual(base);
    expect((action as any).targetAddress).toEqual(target);
    expect((action as any).linkType).toBe(5);
    expect((action as any).tag).toEqual(tag);
  });

  it('maps Dna genesis action with dnaHash', () => {
    const record = makeDnaRecord();
    const action = buildStorageAction(record, agentPubKey);

    expect(action.actionType).toBe('Dna');
    expect((action as any).dnaHash).toEqual(dnaHash);
    expect(action.prevActionHash).toBeNull();
  });

  it('throws when signedAction content is null', () => {
    const record = makeBrokenRecord(99);
    expect(() => buildStorageAction(record, agentPubKey)).toThrow(
      'Missing action content for seq=99'
    );
  });

  it('uses fallback agent when content.author is missing', () => {
    const fallback = mockAgentPubKey(77);
    const record = makeCreateRecord(1);
    // Remove author from content
    record.signedAction.hashed.content.author = undefined;
    const action = buildStorageAction(record, fallback);

    expect(action.author).toEqual(fallback);
  });

  it('converts Array author to Uint8Array (JSON round-trip)', () => {
    const record = makeCreateRecord(1);
    // Simulate JSON round-trip turning Uint8Array into plain Array
    record.signedAction.hashed.content.author = Array.from(agentPubKey) as any;
    const action = buildStorageAction(record, agentPubKey);

    expect(action.author).toBeInstanceOf(Uint8Array);
    expect(action.author).toEqual(agentPubKey);
  });

  it('converts Array signature to Uint8Array', () => {
    const record = makeCreateRecord(1);
    record.signedAction.signature = Array.from(new Uint8Array(64).fill(0xab)) as any;
    const action = buildStorageAction(record, agentPubKey);

    expect(action.signature).toBeInstanceOf(Uint8Array);
    expect(action.signature.length).toBe(64);
  });

  it('produces a 64-byte zero signature when signature is missing', () => {
    const record = makeCreateRecord(1);
    record.signedAction.signature = undefined;
    const action = buildStorageAction(record, agentPubKey);

    expect(action.signature).toEqual(new Uint8Array(64));
  });

  it('converts wire-format entry_type { App: { ... } } to storage format { zome_id, entry_index }', () => {
    const record = makeCreateRecord(1);
    // Simulate wire format from linker
    (record.signedAction.hashed.content as any).entry_type = {
      App: { entry_index: 3, zome_index: 1, visibility: 'Public' },
    };
    const action = buildStorageAction(record, agentPubKey);

    expect((action as any).entryType).toEqual({ zome_id: 1, entry_index: 3 });
  });

  it('converts wire-format "AgentPubKey" entry_type to null', () => {
    const record = makeCreateRecord(1);
    (record.signedAction.hashed.content as any).entry_type = 'AgentPubKey';
    const action = buildStorageAction(record, agentPubKey);

    expect((action as any).entryType).toBeNull();
  });
});

// ============================================================================
// buildStorageEntry tests
// ============================================================================

describe('buildStorageEntry', () => {
  it('extracts entry content from { entry_type, entry } shape', () => {
    const entryHash = mockEntryHash(10);
    const entryData = new Uint8Array([1, 2, 3, 4]);
    const record = makeCreateRecord(1, { entryHash, entryData });

    const result = buildStorageEntry(record, entryHash);

    expect(result).not.toBeNull();
    expect(result!.entryHash).toEqual(entryHash);
    expect(result!.entryContent).toEqual(entryData);
    expect(result!.entryType).toEqual({ zome_id: 0, entry_index: 1 });
  });

  it('returns null when record.entry is null', () => {
    const record = makeCreateRecord(1);
    record.entry = null;
    const result = buildStorageEntry(record, mockEntryHash(10));
    expect(result).toBeNull();
  });

  it('returns null when entryHash is undefined', () => {
    const record = makeCreateRecord(1);
    const result = buildStorageEntry(record, undefined);
    expect(result).toBeNull();
  });

  it('handles entry that is a raw Uint8Array (no .entry wrapper)', () => {
    const entryHash = mockEntryHash(10);
    const rawEntry = new Uint8Array([99, 88, 77]);
    const record = makeCreateRecord(1, { entryHash });
    // Some entries may come as raw bytes without the { entry, entry_type } wrapper
    record.entry = rawEntry;

    const result = buildStorageEntry(record, entryHash);

    expect(result).not.toBeNull();
    expect(result!.entryContent).toEqual(rawEntry);
  });

  it('converts Array entry content to Uint8Array', () => {
    const entryHash = mockEntryHash(10);
    const record = makeCreateRecord(1, { entryHash });
    // Simulate JSON round-trip
    record.entry = { entry_type: { zome_id: 0, entry_index: 1 }, entry: [1, 2, 3, 4] };

    const result = buildStorageEntry(record, entryHash);

    expect(result).not.toBeNull();
    expect(result!.entryContent).toBeInstanceOf(Uint8Array);
    expect(result!.entryContent).toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it('converts wire-format entry_type { App: { entry_index, zome_index, visibility } } to storage format', () => {
    const entryHash = mockEntryHash(10);
    const record = makeCreateRecord(1, { entryHash });
    // Simulate wire format from linker/DHT
    record.entry = {
      entry_type: 'App',
      entry: new Uint8Array([5, 6, 7]),
    };
    (record.signedAction.hashed.content as any).entry_type = {
      App: { entry_index: 2, zome_index: 0, visibility: 'Public' },
    };

    const result = buildStorageEntry(record, entryHash);

    expect(result).not.toBeNull();
    expect(result!.entryType).toEqual({ zome_id: 0, entry_index: 2 });
  });

  it('converts wire-format "AgentPubKey" entry_type to Agent string', () => {
    const entryHash = mockEntryHash(10);
    const record = makeCreateRecord(1, { entryHash });
    record.entry = {
      entry_type: 'Agent',
      entry: new Uint8Array([8, 9]),
    };
    (record.signedAction.hashed.content as any).entry_type = 'AgentPubKey';

    const result = buildStorageEntry(record, entryHash);

    expect(result).not.toBeNull();
    expect(result!.entryType).toBe('Agent');
  });
});

// ============================================================================
// storeRecoveredRecords tests
// ============================================================================

describe('storeRecoveredRecords', () => {
  let storage: ReturnType<typeof createMockStorage>;

  beforeEach(() => {
    storage = createMockStorage();
  });

  it('stores a single Create record: putAction + putEntry + updateChainHead', () => {
    const record = makeCreateRecord(1);

    const result = storeRecoveredRecords([record], storage as any, dnaHash, agentPubKey);

    expect(result.recoveredCount).toBe(1);
    expect(result.failedCount).toBe(0);
    expect(result.errors).toHaveLength(0);

    expect(storage.putAction).toHaveBeenCalledTimes(1);
    expect(storage.putEntry).toHaveBeenCalledTimes(1);
    expect(storage.updateChainHead).toHaveBeenCalledTimes(1);
  });

  it('does not call putEntry for a record without entry data', () => {
    const record = makeDeleteRecord(3, {
      deletesActionHash: mockActionHash(50),
      deletesEntryHash: mockEntryHash(50),
    });

    storeRecoveredRecords([record], storage as any, dnaHash, agentPubKey);

    expect(storage.putAction).toHaveBeenCalledTimes(1);
    expect(storage.putEntry).not.toHaveBeenCalled();
    expect(storage.updateChainHead).toHaveBeenCalledTimes(1);
  });

  it('stores multiple records in sequence, updating chain head for each', () => {
    const records = [makeCreateRecord(0), makeCreateRecord(1), makeCreateRecord(2)];

    const result = storeRecoveredRecords(records, storage as any, dnaHash, agentPubKey);

    expect(result.recoveredCount).toBe(3);
    expect(storage.putAction).toHaveBeenCalledTimes(3);
    expect(storage.putEntry).toHaveBeenCalledTimes(3);
    expect(storage.updateChainHead).toHaveBeenCalledTimes(3);

    // Last updateChainHead should be for seq 2
    const lastCall = storage.updateChainHead.mock.calls[2];
    expect(lastCall[2]).toBe(2); // actionSeq
  });

  it('continues past a broken record and reports the failure', () => {
    const records = [
      makeCreateRecord(0),
      makeBrokenRecord(1), // will throw
      makeCreateRecord(2),
    ];

    const result = storeRecoveredRecords(records, storage as any, dnaHash, agentPubKey);

    expect(result.recoveredCount).toBe(2);
    expect(result.failedCount).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/seq=1/);
    expect(result.errors[0]).toMatch(/Missing action content/);
  });

  it('reports error when putAction throws', () => {
    storage.putAction.mockImplementationOnce(() => {
      throw new Error('SQLite write failed');
    });

    const result = storeRecoveredRecords(
      [makeCreateRecord(0)],
      storage as any,
      dnaHash,
      agentPubKey
    );

    expect(result.recoveredCount).toBe(0);
    expect(result.failedCount).toBe(1);
    expect(result.errors[0]).toMatch(/SQLite write failed/);
  });

  it('passes dnaHash and agentPubKey to storage methods', () => {
    const record = makeCreateRecord(1);

    storeRecoveredRecords([record], storage as any, dnaHash, agentPubKey);

    // putAction receives (action, dnaHash, agentPubKey)
    expect(storage.putAction.mock.calls[0][1]).toEqual(dnaHash);
    expect(storage.putAction.mock.calls[0][2]).toEqual(agentPubKey);

    // putEntry receives (entry, dnaHash, agentPubKey)
    expect(storage.putEntry.mock.calls[0][1]).toEqual(dnaHash);
    expect(storage.putEntry.mock.calls[0][2]).toEqual(agentPubKey);

    // updateChainHead receives (dnaHash, agentPubKey, seq, hash, timestamp)
    expect(storage.updateChainHead.mock.calls[0][0]).toEqual(dnaHash);
    expect(storage.updateChainHead.mock.calls[0][1]).toEqual(agentPubKey);
  });

  it('passes correct actionSeq and timestamp to updateChainHead', () => {
    const record = makeCreateRecord(7);

    storeRecoveredRecords([record], storage as any, dnaHash, agentPubKey);

    const [, , seq, hash, ts] = storage.updateChainHead.mock.calls[0];
    expect(seq).toBe(7);
    expect(hash).toBe(record.actionHash);
    expect(ts).toBe(BigInt(7_000_000));
  });

  it('correctly stores an Update record with original hashes', () => {
    const origAction = mockActionHash(100);
    const origEntry = mockEntryHash(100);
    const record = makeUpdateRecord(5, {
      originalActionHash: origAction,
      originalEntryHash: origEntry,
    });

    storeRecoveredRecords([record], storage as any, dnaHash, agentPubKey);

    const storedAction = storage.getStoredActions()[0];
    expect(storedAction.actionType).toBe('Update');
    expect(storedAction.originalActionHash).toEqual(origAction);
    expect(storedAction.originalEntryHash).toEqual(origEntry);
  });

  it('correctly stores a CreateLink record with link fields', () => {
    const base = mockEntryHash(60);
    const target = mockEntryHash(61);
    const tag = new Uint8Array([0xde, 0xad]);
    const record = makeCreateLinkRecord(8, {
      baseAddress: base,
      targetAddress: target,
      linkType: 7,
      tag,
    });

    storeRecoveredRecords([record], storage as any, dnaHash, agentPubKey);

    const storedAction = storage.getStoredActions()[0];
    expect(storedAction.actionType).toBe('CreateLink');
    expect(storedAction.baseAddress).toEqual(base);
    expect(storedAction.targetAddress).toEqual(target);
    expect(storedAction.linkType).toBe(7);
    expect(storedAction.tag).toEqual(tag);

    // CreateLink has no entry
    expect(storage.putEntry).not.toHaveBeenCalled();
  });

  it('correctly stores a Dna genesis record', () => {
    const record = makeDnaRecord();

    storeRecoveredRecords([record], storage as any, dnaHash, agentPubKey);

    const storedAction = storage.getStoredActions()[0];
    expect(storedAction.actionType).toBe('Dna');
    expect(storedAction.dnaHash).toEqual(dnaHash);
    expect(storedAction.prevActionHash).toBeNull();
  });

  it('returns zero counts for empty input', () => {
    const result = storeRecoveredRecords([], storage as any, dnaHash, agentPubKey);

    expect(result.recoveredCount).toBe(0);
    expect(result.failedCount).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(storage.putAction).not.toHaveBeenCalled();
  });
});
