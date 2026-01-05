/**
 * Tests for DhtOp generation
 */

import { describe, it, expect } from "vitest";
import {
  HoloHashType,
  hashFrom32AndType,
  type Action,
  type ActionHash,
  type AgentPubKey,
  type Create,
  type CreateLink,
  type Delete,
  type DeleteLink,
  type Entry,
  type EntryHash,
  type Record,
  type Signature,
  type SignedActionHashed,
  type Update,
} from "@holochain/client";

import {
  ChainOpType,
  actionToOpTypes,
  isRecordEntryPresent,
  recordEntryNA,
  recordEntryPresent,
} from "./dht-op-types";

import {
  computeOpBasis,
  produceOpsFromRecord,
  produceOpLitesFromRecord,
} from "./produce-ops";

// ============================================================================
// Test Helpers using @holochain/client hash utilities
// ============================================================================

/**
 * Create a mock 32-byte core hash for testing
 */
function mockCore32(seed: number = 0): Uint8Array {
  const core = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    core[i] = (i * 17 + seed) % 256;
  }
  return core;
}

/**
 * Create a mock EntryHash (39 bytes with proper prefix and location)
 */
function mockEntryHash(seed: number = 0): EntryHash {
  return hashFrom32AndType(mockCore32(seed), HoloHashType.Entry) as EntryHash;
}

/**
 * Create a mock ActionHash (39 bytes with proper prefix and location)
 */
function mockActionHash(seed: number = 0): ActionHash {
  return hashFrom32AndType(mockCore32(seed), HoloHashType.Action) as ActionHash;
}

/**
 * Create a mock AgentPubKey (39 bytes with proper prefix and location)
 */
function mockAgentPubKey(seed: number = 0): AgentPubKey {
  return hashFrom32AndType(mockCore32(seed), HoloHashType.Agent) as AgentPubKey;
}

/**
 * Create a mock 64-byte signature
 */
function mockSignature(): Signature {
  const sig = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    sig[i] = i % 256;
  }
  return sig;
}

/**
 * Create a mock Create action
 */
function mockCreateAction(): Create {
  return {
    type: "Create",
    author: mockAgentPubKey(1),
    timestamp: Date.now() * 1000,
    action_seq: 4,
    prev_action: mockActionHash(2),
    entry_type: { App: { entry_index: 0, zome_index: 0, visibility: "Public" } },
    entry_hash: mockEntryHash(3),
    weight: { bucket_id: 0, units: 1, rate_bytes: 100 },
  };
}

/**
 * Create a mock Update action
 */
function mockUpdateAction(): Update {
  return {
    type: "Update",
    author: mockAgentPubKey(1),
    timestamp: Date.now() * 1000,
    action_seq: 5,
    prev_action: mockActionHash(2),
    original_action_address: mockActionHash(4),
    original_entry_address: mockEntryHash(5),
    entry_type: { App: { entry_index: 0, zome_index: 0, visibility: "Public" } },
    entry_hash: mockEntryHash(6),
    weight: { bucket_id: 0, units: 1, rate_bytes: 100 },
  };
}

/**
 * Create a mock Delete action
 */
function mockDeleteAction(): Delete {
  return {
    type: "Delete",
    author: mockAgentPubKey(1),
    timestamp: Date.now() * 1000,
    action_seq: 6,
    prev_action: mockActionHash(2),
    deletes_address: mockActionHash(7),
    deletes_entry_address: mockEntryHash(8),
    weight: { bucket_id: 0, units: 1, rate_bytes: 100 },
  };
}

/**
 * Create a mock CreateLink action
 */
function mockCreateLinkAction(): CreateLink {
  return {
    type: "CreateLink",
    author: mockAgentPubKey(1),
    timestamp: Date.now() * 1000,
    action_seq: 7,
    prev_action: mockActionHash(2),
    base_address: mockEntryHash(9),
    target_address: mockEntryHash(10),
    zome_index: 0,
    link_type: 0,
    tag: new Uint8Array([1, 2, 3]),
    weight: { bucket_id: 0, units: 1, rate_bytes: 100 },
  };
}

/**
 * Create a mock DeleteLink action
 */
function mockDeleteLinkAction(): DeleteLink {
  return {
    type: "DeleteLink",
    author: mockAgentPubKey(1),
    timestamp: Date.now() * 1000,
    action_seq: 8,
    prev_action: mockActionHash(2),
    base_address: mockEntryHash(11),
    link_add_address: mockActionHash(12),
    weight: { bucket_id: 0, units: 1, rate_bytes: 100 },
  };
}

/**
 * Create a mock entry
 */
function mockEntry(): Entry {
  return {
    App: new Uint8Array([1, 2, 3, 4, 5]),
  };
}

/**
 * Create a mock Record from an action
 */
function mockRecord(action: Action, entry?: Entry): Record {
  const actionHash = mockActionHash(100);
  const signature = mockSignature();

  return {
    signed_action: {
      hashed: {
        hash: actionHash,
        content: action,
      },
      signature,
    } as SignedActionHashed,
    entry: entry ? { Present: entry } : { NA: null },
  };
}

// ============================================================================
// Tests: actionToOpTypes
// ============================================================================

describe("actionToOpTypes", () => {
  it("returns correct ops for Create action", () => {
    const action = mockCreateAction();
    const opTypes = actionToOpTypes(action);

    expect(opTypes).toContain(ChainOpType.StoreRecord);
    expect(opTypes).toContain(ChainOpType.RegisterAgentActivity);
    expect(opTypes).toContain(ChainOpType.StoreEntry);
    expect(opTypes).toHaveLength(3);
  });

  it("returns correct ops for Update action", () => {
    const action = mockUpdateAction();
    const opTypes = actionToOpTypes(action);

    expect(opTypes).toContain(ChainOpType.StoreRecord);
    expect(opTypes).toContain(ChainOpType.RegisterAgentActivity);
    expect(opTypes).toContain(ChainOpType.StoreEntry);
    expect(opTypes).toContain(ChainOpType.RegisterUpdatedContent);
    expect(opTypes).toContain(ChainOpType.RegisterUpdatedRecord);
    expect(opTypes).toHaveLength(5);
  });

  it("returns correct ops for Delete action", () => {
    const action = mockDeleteAction();
    const opTypes = actionToOpTypes(action);

    expect(opTypes).toContain(ChainOpType.StoreRecord);
    expect(opTypes).toContain(ChainOpType.RegisterAgentActivity);
    expect(opTypes).toContain(ChainOpType.RegisterDeletedBy);
    expect(opTypes).toContain(ChainOpType.RegisterDeletedEntryAction);
    expect(opTypes).toHaveLength(4);
  });

  it("returns correct ops for CreateLink action", () => {
    const action = mockCreateLinkAction();
    const opTypes = actionToOpTypes(action);

    expect(opTypes).toContain(ChainOpType.StoreRecord);
    expect(opTypes).toContain(ChainOpType.RegisterAgentActivity);
    expect(opTypes).toContain(ChainOpType.RegisterAddLink);
    expect(opTypes).toHaveLength(3);
  });

  it("returns correct ops for DeleteLink action", () => {
    const action = mockDeleteLinkAction();
    const opTypes = actionToOpTypes(action);

    expect(opTypes).toContain(ChainOpType.StoreRecord);
    expect(opTypes).toContain(ChainOpType.RegisterAgentActivity);
    expect(opTypes).toContain(ChainOpType.RegisterRemoveLink);
    expect(opTypes).toHaveLength(3);
  });
});

// ============================================================================
// Tests: computeOpBasis
// ============================================================================

describe("computeOpBasis", () => {
  it("returns action hash for StoreRecord", () => {
    const action = mockCreateAction();
    const actionHash = mockActionHash(100);

    const basis = computeOpBasis(ChainOpType.StoreRecord, action, actionHash);

    expect(basis).toBe(actionHash);
  });

  it("returns entry hash for StoreEntry (Create)", () => {
    const action = mockCreateAction();
    const actionHash = mockActionHash(100);

    const basis = computeOpBasis(ChainOpType.StoreEntry, action, actionHash);

    expect(basis).toBe(action.entry_hash);
  });

  it("returns author for RegisterAgentActivity", () => {
    const action = mockCreateAction();
    const actionHash = mockActionHash(100);

    const basis = computeOpBasis(
      ChainOpType.RegisterAgentActivity,
      action,
      actionHash
    );

    expect(basis).toBe(action.author);
  });

  it("returns original entry address for RegisterUpdatedContent", () => {
    const action = mockUpdateAction();
    const actionHash = mockActionHash(100);

    const basis = computeOpBasis(
      ChainOpType.RegisterUpdatedContent,
      action,
      actionHash
    );

    expect(basis).toBe(action.original_entry_address);
  });

  it("returns original action address for RegisterUpdatedRecord", () => {
    const action = mockUpdateAction();
    const actionHash = mockActionHash(100);

    const basis = computeOpBasis(
      ChainOpType.RegisterUpdatedRecord,
      action,
      actionHash
    );

    expect(basis).toBe(action.original_action_address);
  });

  it("returns deletes_address for RegisterDeletedBy", () => {
    const action = mockDeleteAction();
    const actionHash = mockActionHash(100);

    const basis = computeOpBasis(
      ChainOpType.RegisterDeletedBy,
      action,
      actionHash
    );

    expect(basis).toBe(action.deletes_address);
  });

  it("returns deletes_entry_address for RegisterDeletedEntryAction", () => {
    const action = mockDeleteAction();
    const actionHash = mockActionHash(100);

    const basis = computeOpBasis(
      ChainOpType.RegisterDeletedEntryAction,
      action,
      actionHash
    );

    expect(basis).toBe(action.deletes_entry_address);
  });

  it("returns base_address for RegisterAddLink", () => {
    const action = mockCreateLinkAction();
    const actionHash = mockActionHash(100);

    const basis = computeOpBasis(
      ChainOpType.RegisterAddLink,
      action,
      actionHash
    );

    expect(basis).toBe(action.base_address);
  });

  it("returns base_address for RegisterRemoveLink", () => {
    const action = mockDeleteLinkAction();
    const actionHash = mockActionHash(100);

    const basis = computeOpBasis(
      ChainOpType.RegisterRemoveLink,
      action,
      actionHash
    );

    expect(basis).toBe(action.base_address);
  });

  it("throws for mismatched op type and action", () => {
    const action = mockCreateAction(); // Not an Update action
    const actionHash = mockActionHash(100);

    expect(() => {
      computeOpBasis(ChainOpType.RegisterUpdatedContent, action, actionHash);
    }).toThrow();
  });
});

// ============================================================================
// Tests: produceOpsFromRecord
// ============================================================================

describe("produceOpsFromRecord", () => {
  it("produces 3 ops for Create action with entry", () => {
    const action = mockCreateAction();
    const entry = mockEntry();
    const record = mockRecord(action, entry);

    const ops = produceOpsFromRecord(record);

    expect(ops).toHaveLength(3);
    expect(ops.map((op) => op.type)).toContain(ChainOpType.StoreRecord);
    expect(ops.map((op) => op.type)).toContain(ChainOpType.RegisterAgentActivity);
    expect(ops.map((op) => op.type)).toContain(ChainOpType.StoreEntry);
  });

  it("produces 2 ops for Create action without entry (private)", () => {
    const action = mockCreateAction();
    const record = mockRecord(action); // No entry

    const ops = produceOpsFromRecord(record);

    // StoreEntry is skipped when entry is not present (private)
    expect(ops).toHaveLength(2);
    expect(ops.map((op) => op.type)).toContain(ChainOpType.StoreRecord);
    expect(ops.map((op) => op.type)).toContain(ChainOpType.RegisterAgentActivity);
    expect(ops.map((op) => op.type)).not.toContain(ChainOpType.StoreEntry);
  });

  it("produces 5 ops for Update action with entry", () => {
    const action = mockUpdateAction();
    const entry = mockEntry();
    const record = mockRecord(action, entry);

    const ops = produceOpsFromRecord(record);

    expect(ops).toHaveLength(5);
    expect(ops.map((op) => op.type)).toContain(ChainOpType.StoreRecord);
    expect(ops.map((op) => op.type)).toContain(ChainOpType.RegisterAgentActivity);
    expect(ops.map((op) => op.type)).toContain(ChainOpType.StoreEntry);
    expect(ops.map((op) => op.type)).toContain(ChainOpType.RegisterUpdatedContent);
    expect(ops.map((op) => op.type)).toContain(ChainOpType.RegisterUpdatedRecord);
  });

  it("produces 4 ops for Delete action", () => {
    const action = mockDeleteAction();
    const record = mockRecord(action);

    const ops = produceOpsFromRecord(record);

    expect(ops).toHaveLength(4);
    expect(ops.map((op) => op.type)).toContain(ChainOpType.StoreRecord);
    expect(ops.map((op) => op.type)).toContain(ChainOpType.RegisterAgentActivity);
    expect(ops.map((op) => op.type)).toContain(ChainOpType.RegisterDeletedBy);
    expect(ops.map((op) => op.type)).toContain(ChainOpType.RegisterDeletedEntryAction);
  });

  it("produces 3 ops for CreateLink action", () => {
    const action = mockCreateLinkAction();
    const record = mockRecord(action);

    const ops = produceOpsFromRecord(record);

    expect(ops).toHaveLength(3);
    expect(ops.map((op) => op.type)).toContain(ChainOpType.StoreRecord);
    expect(ops.map((op) => op.type)).toContain(ChainOpType.RegisterAgentActivity);
    expect(ops.map((op) => op.type)).toContain(ChainOpType.RegisterAddLink);
  });

  it("produces 3 ops for DeleteLink action", () => {
    const action = mockDeleteLinkAction();
    const record = mockRecord(action);

    const ops = produceOpsFromRecord(record);

    expect(ops).toHaveLength(3);
    expect(ops.map((op) => op.type)).toContain(ChainOpType.StoreRecord);
    expect(ops.map((op) => op.type)).toContain(ChainOpType.RegisterAgentActivity);
    expect(ops.map((op) => op.type)).toContain(ChainOpType.RegisterRemoveLink);
  });

  it("includes correct signature in all ops", () => {
    const action = mockCreateAction();
    const entry = mockEntry();
    const record = mockRecord(action, entry);

    const ops = produceOpsFromRecord(record);

    for (const op of ops) {
      expect(op.signature).toBeDefined();
      expect(op.signature.length).toBe(64);
    }
  });
});

// ============================================================================
// Tests: produceOpLitesFromRecord
// ============================================================================

describe("produceOpLitesFromRecord", () => {
  it("produces op lites with correct hashes for Create", () => {
    const action = mockCreateAction();
    const entry = mockEntry();
    const record = mockRecord(action, entry);

    const opLites = produceOpLitesFromRecord(record);

    expect(opLites).toHaveLength(3);

    // Check StoreRecord
    const storeRecord = opLites.find(
      (op) => op.type === ChainOpType.StoreRecord
    );
    expect(storeRecord).toBeDefined();
    expect(storeRecord?.actionHash).toBeDefined();
    expect(storeRecord?.basis).toBeDefined();

    // Check StoreEntry
    const storeEntry = opLites.find(
      (op) => op.type === ChainOpType.StoreEntry
    );
    expect(storeEntry).toBeDefined();
    if (storeEntry?.type === ChainOpType.StoreEntry) {
      expect(storeEntry.entryHash).toBeDefined();
    }
  });

  it("produces op lites with correct basis hashes", () => {
    const action = mockCreateAction();
    const entry = mockEntry();
    const record = mockRecord(action, entry);

    const opLites = produceOpLitesFromRecord(record);

    // RegisterAgentActivity basis should be author
    const agentActivity = opLites.find(
      (op) => op.type === ChainOpType.RegisterAgentActivity
    );
    expect(agentActivity?.basis).toEqual(action.author);

    // StoreEntry basis should be entry hash
    const storeEntry = opLites.find(
      (op) => op.type === ChainOpType.StoreEntry
    );
    expect(storeEntry?.basis).toEqual(action.entry_hash);
  });
});

// ============================================================================
// Tests: RecordEntry helpers
// ============================================================================

describe("RecordEntry helpers", () => {
  it("recordEntryPresent creates Present variant", () => {
    const entry = mockEntry();
    const recordEntry = recordEntryPresent(entry);

    expect(isRecordEntryPresent(recordEntry)).toBe(true);
    if (isRecordEntryPresent(recordEntry)) {
      expect(recordEntry.Present).toBe(entry);
    }
  });

  it("recordEntryNA creates NA variant", () => {
    const recordEntry = recordEntryNA();

    expect(isRecordEntryPresent(recordEntry)).toBe(false);
    expect("NA" in recordEntry).toBe(true);
  });
});

// ============================================================================
// Tests: Hash type verification
// ============================================================================

describe("mock hash helpers", () => {
  it("mockEntryHash creates valid 39-byte hash with entry prefix", () => {
    const hash = mockEntryHash();
    expect(hash.length).toBe(39);
    // Entry prefix: [0x84, 0x21, 0x24]
    expect(hash[0]).toBe(0x84);
    expect(hash[1]).toBe(0x21);
    expect(hash[2]).toBe(0x24);
  });

  it("mockActionHash creates valid 39-byte hash with action prefix", () => {
    const hash = mockActionHash();
    expect(hash.length).toBe(39);
    // Action prefix: [0x84, 0x29, 0x24]
    expect(hash[0]).toBe(0x84);
    expect(hash[1]).toBe(0x29);
    expect(hash[2]).toBe(0x24);
  });

  it("mockAgentPubKey creates valid 39-byte hash with agent prefix", () => {
    const hash = mockAgentPubKey();
    expect(hash.length).toBe(39);
    // Agent prefix: [0x84, 0x20, 0x24]
    expect(hash[0]).toBe(0x84);
    expect(hash[1]).toBe(0x20);
    expect(hash[2]).toBe(0x24);
  });

  it("different seeds produce different hashes", () => {
    const hash1 = mockEntryHash(1);
    const hash2 = mockEntryHash(2);
    expect(hash1).not.toEqual(hash2);
  });
});
