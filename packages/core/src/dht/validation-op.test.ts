/**
 * Tests for validation Op construction
 *
 * Tests that pendingRecordToOps, recordToOps, and buildOpFromRecord
 * correctly create the Op types for each action type.
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

import { ChainOpType } from "./dht-op-types";
import {
  buildOpFromRecord,
  recordToOps,
  pendingRecordToOps,
  getOpVariant,
  type Op,
} from "./validation-op";
import type { PendingRecord } from "../ribosome/call-context";
import type { StoredEntry } from "../storage/types";

// ============================================================================
// Test Helpers
// ============================================================================

function mockCore32(seed: number = 0): Uint8Array {
  const core = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    core[i] = (i * 17 + seed) % 256;
  }
  return core;
}

function mockEntryHash(seed: number = 0): EntryHash {
  return hashFrom32AndType(mockCore32(seed), HoloHashType.Entry) as EntryHash;
}

function mockActionHash(seed: number = 0): ActionHash {
  return hashFrom32AndType(
    mockCore32(seed),
    HoloHashType.Action
  ) as ActionHash;
}

function mockAgentPubKey(seed: number = 0): AgentPubKey {
  return hashFrom32AndType(
    mockCore32(seed),
    HoloHashType.Agent
  ) as AgentPubKey;
}

function mockSignature(): Signature {
  const sig = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    sig[i] = i % 256;
  }
  return sig;
}

function mockCreateAction(): Create {
  return {
    type: "Create",
    author: mockAgentPubKey(1),
    timestamp: Date.now() * 1000,
    action_seq: 4,
    prev_action: mockActionHash(2),
    entry_type: {
      App: { entry_index: 0, zome_index: 0, visibility: "Public" },
    },
    entry_hash: mockEntryHash(3),
    weight: { bucket_id: 0, units: 1, rate_bytes: 100 },
  };
}

function mockUpdateAction(): Update {
  return {
    type: "Update",
    author: mockAgentPubKey(1),
    timestamp: Date.now() * 1000,
    action_seq: 5,
    prev_action: mockActionHash(2),
    original_action_address: mockActionHash(4),
    original_entry_address: mockEntryHash(5),
    entry_type: {
      App: { entry_index: 0, zome_index: 0, visibility: "Public" },
    },
    entry_hash: mockEntryHash(6),
    weight: { bucket_id: 0, units: 1, rate_bytes: 100 },
  };
}

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

function mockEntry(): Entry {
  return {
    entry_type: "App",
    entry: new Uint8Array([1, 2, 3, 4, 5]),
  } as Entry;
}

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
    entry: entry ? { Present: entry } : ("NA" as any),
  };
}

// ============================================================================
// Tests: buildOpFromRecord
// ============================================================================

describe("buildOpFromRecord", () => {
  it("builds StoreRecord op for Create action", () => {
    const action = mockCreateAction();
    const entry = mockEntry();
    const record = mockRecord(action, entry);

    const op = buildOpFromRecord(record, ChainOpType.StoreRecord);
    expect(op).not.toBeNull();
    expect("StoreRecord" in op!).toBe(true);
    if ("StoreRecord" in op!) {
      expect(op.StoreRecord.record).toBe(record);
    }
  });

  it("builds StoreEntry op for Create action", () => {
    const action = mockCreateAction();
    const entry = mockEntry();
    const record = mockRecord(action, entry);

    const op = buildOpFromRecord(record, ChainOpType.StoreEntry);
    expect(op).not.toBeNull();
    expect("StoreEntry" in op!).toBe(true);
    if ("StoreEntry" in op!) {
      // Entry creation action should be externally tagged
      const eca = op.StoreEntry.action.hashed.content;
      expect("Create" in eca).toBe(true);
      // The inner struct should NOT have a "type" field
      if ("Create" in eca) {
        expect((eca.Create as any).type).toBeUndefined();
        expect(eca.Create.author).toEqual(action.author);
      }
      expect(op.StoreEntry.entry).toBe(entry);
    }
  });

  it("builds RegisterAgentActivity op for Create action", () => {
    const action = mockCreateAction();
    const record = mockRecord(action);

    const op = buildOpFromRecord(record, ChainOpType.RegisterAgentActivity);
    expect(op).not.toBeNull();
    expect("RegisterAgentActivity" in op!).toBe(true);
    if ("RegisterAgentActivity" in op!) {
      expect(op.RegisterAgentActivity.action).toBe(record.signed_action);
      expect(op.RegisterAgentActivity.cached_entry).toBeNull();
    }
  });

  it("builds RegisterUpdate op from RegisterUpdatedContent", () => {
    const action = mockUpdateAction();
    const entry = mockEntry();
    const record = mockRecord(action, entry);

    const op = buildOpFromRecord(record, ChainOpType.RegisterUpdatedContent);
    expect(op).not.toBeNull();
    expect("RegisterUpdate" in op!).toBe(true);
    if ("RegisterUpdate" in op!) {
      const update = op.RegisterUpdate.update.hashed.content;
      expect((update as any).type).toBeUndefined();
      expect((update as any).original_action_address).toEqual(
        action.original_action_address
      );
      expect(op.RegisterUpdate.new_entry).toBe(entry);
    }
  });

  it("builds RegisterUpdate op from RegisterUpdatedRecord", () => {
    const action = mockUpdateAction();
    const record = mockRecord(action);

    const op = buildOpFromRecord(record, ChainOpType.RegisterUpdatedRecord);
    expect(op).not.toBeNull();
    expect("RegisterUpdate" in op!).toBe(true);
  });

  it("builds RegisterDelete op from RegisterDeletedBy", () => {
    const action = mockDeleteAction();
    const record = mockRecord(action);

    const op = buildOpFromRecord(record, ChainOpType.RegisterDeletedBy);
    expect(op).not.toBeNull();
    expect("RegisterDelete" in op!).toBe(true);
    if ("RegisterDelete" in op!) {
      const del = op.RegisterDelete.delete.hashed.content;
      expect((del as any).type).toBeUndefined();
      expect((del as any).deletes_address).toEqual(action.deletes_address);
    }
  });

  it("builds RegisterDelete op from RegisterDeletedEntryAction", () => {
    const action = mockDeleteAction();
    const record = mockRecord(action);

    const op = buildOpFromRecord(
      record,
      ChainOpType.RegisterDeletedEntryAction
    );
    expect(op).not.toBeNull();
    expect("RegisterDelete" in op!).toBe(true);
  });

  it("builds RegisterCreateLink op", () => {
    const action = mockCreateLinkAction();
    const record = mockRecord(action);

    const op = buildOpFromRecord(record, ChainOpType.RegisterAddLink);
    expect(op).not.toBeNull();
    expect("RegisterCreateLink" in op!).toBe(true);
    if ("RegisterCreateLink" in op!) {
      const cl = op.RegisterCreateLink.create_link.hashed.content;
      expect((cl as any).type).toBeUndefined();
      expect((cl as any).base_address).toEqual(action.base_address);
      expect((cl as any).target_address).toEqual(action.target_address);
    }
  });

  it("builds RegisterDeleteLink op with resolver", () => {
    const action = mockDeleteLinkAction();
    const record = mockRecord(action);

    const originalCreateLink = mockCreateLinkAction();
    const { type: _type, ...createLinkWithoutType } = originalCreateLink;
    const resolver = () => createLinkWithoutType;

    const op = buildOpFromRecord(
      record,
      ChainOpType.RegisterRemoveLink,
      resolver
    );
    expect(op).not.toBeNull();
    expect("RegisterDeleteLink" in op!).toBe(true);
    if ("RegisterDeleteLink" in op!) {
      const dl = op.RegisterDeleteLink.delete_link.hashed.content;
      expect((dl as any).type).toBeUndefined();
      expect(op.RegisterDeleteLink.create_link).toEqual(
        createLinkWithoutType
      );
    }
  });

  it("returns null for RegisterRemoveLink without resolver", () => {
    const action = mockDeleteLinkAction();
    const record = mockRecord(action);

    const op = buildOpFromRecord(record, ChainOpType.RegisterRemoveLink);
    expect(op).toBeNull();
  });

  it("returns null for StoreEntry when action is not an entry action", () => {
    const action = mockDeleteAction();
    const record = mockRecord(action);

    const op = buildOpFromRecord(record, ChainOpType.StoreEntry);
    expect(op).toBeNull();
  });

  it("returns null for RegisterUpdatedContent when action is not Update", () => {
    const action = mockCreateAction();
    const record = mockRecord(action);

    const op = buildOpFromRecord(record, ChainOpType.RegisterUpdatedContent);
    expect(op).toBeNull();
  });
});

// ============================================================================
// Tests: recordToOps
// ============================================================================

describe("recordToOps", () => {
  it("creates StoreRecord + StoreEntry + RegisterAgentActivity for Create", () => {
    const action = mockCreateAction();
    const entry = mockEntry();
    const record = mockRecord(action, entry);

    const ops = recordToOps(record);
    const variants = ops.map(getOpVariant);

    expect(variants).toContain("StoreRecord");
    expect(variants).toContain("StoreEntry");
    expect(variants).toContain("RegisterAgentActivity");
    expect(ops).toHaveLength(3);
  });

  it("creates 5 ops for Update (StoreRecord + StoreEntry + RegisterAgentActivity + 2x RegisterUpdate)", () => {
    const action = mockUpdateAction();
    const entry = mockEntry();
    const record = mockRecord(action, entry);

    const ops = recordToOps(record);
    const variants = ops.map(getOpVariant);

    expect(variants).toContain("StoreRecord");
    expect(variants).toContain("StoreEntry");
    expect(variants).toContain("RegisterAgentActivity");
    // Both RegisterUpdatedContent and RegisterUpdatedRecord map to RegisterUpdate
    expect(variants.filter((v) => v === "RegisterUpdate")).toHaveLength(2);
    expect(ops).toHaveLength(5);
  });

  it("creates RegisterDelete ops for Delete", () => {
    const action = mockDeleteAction();
    const record = mockRecord(action);

    const ops = recordToOps(record);
    const variants = ops.map(getOpVariant);

    expect(variants).toContain("StoreRecord");
    expect(variants).toContain("RegisterAgentActivity");
    // Both RegisterDeletedBy and RegisterDeletedEntryAction map to RegisterDelete
    expect(variants.filter((v) => v === "RegisterDelete")).toHaveLength(2);
    expect(ops).toHaveLength(4);
  });

  it("creates RegisterCreateLink for CreateLink", () => {
    const action = mockCreateLinkAction();
    const record = mockRecord(action);

    const ops = recordToOps(record);
    const variants = ops.map(getOpVariant);

    expect(variants).toContain("StoreRecord");
    expect(variants).toContain("RegisterAgentActivity");
    expect(variants).toContain("RegisterCreateLink");
    expect(ops).toHaveLength(3);
  });

  it("creates RegisterDeleteLink for DeleteLink with resolver", () => {
    const action = mockDeleteLinkAction();
    const record = mockRecord(action);

    const originalCreateLink = mockCreateLinkAction();
    const { type: _type, ...createLinkWithoutType } = originalCreateLink;
    const resolver = () => createLinkWithoutType;

    const ops = recordToOps(record, resolver);
    const variants = ops.map(getOpVariant);

    expect(variants).toContain("StoreRecord");
    expect(variants).toContain("RegisterAgentActivity");
    expect(variants).toContain("RegisterDeleteLink");
    expect(ops).toHaveLength(3);
  });

  it("skips RegisterDeleteLink without resolver", () => {
    const action = mockDeleteLinkAction();
    const record = mockRecord(action);

    const ops = recordToOps(record);
    const variants = ops.map(getOpVariant);

    expect(variants).toContain("StoreRecord");
    expect(variants).toContain("RegisterAgentActivity");
    expect(variants).not.toContain("RegisterDeleteLink");
    // Only StoreRecord + RegisterAgentActivity
    expect(ops).toHaveLength(2);
  });
});

// ============================================================================
// Tests: pendingRecordToOps
// ============================================================================

describe("pendingRecordToOps", () => {
  it("converts PendingRecord with Create to ops", () => {
    const pendingRecord: PendingRecord = {
      action: {
        actionHash: mockActionHash(50),
        actionType: "Create",
        actionSeq: 3,
        author: mockAgentPubKey(1),
        timestamp: BigInt(Date.now()) * 1000n,
        prevActionHash: mockActionHash(2),
        signature: mockSignature(),
        entryHash: mockEntryHash(3),
        entryType: { zome_id: 0, entry_index: 0 },
      },
      entry: {
        entryHash: mockEntryHash(3),
        entryContent: new Uint8Array([10, 20, 30]),
        entryType: { zome_id: 0, entry_index: 0 },
      },
    };

    const ops = pendingRecordToOps(pendingRecord);
    const variants = ops.map(getOpVariant);

    expect(variants).toContain("StoreRecord");
    expect(variants).toContain("StoreEntry");
    expect(variants).toContain("RegisterAgentActivity");
    expect(ops).toHaveLength(3);
  });

  it("converts PendingRecord with Update to ops", () => {
    const pendingRecord: PendingRecord = {
      action: {
        actionHash: mockActionHash(51),
        actionType: "Update",
        actionSeq: 4,
        author: mockAgentPubKey(1),
        timestamp: BigInt(Date.now()) * 1000n,
        prevActionHash: mockActionHash(2),
        signature: mockSignature(),
        entryHash: mockEntryHash(6),
        entryType: { zome_id: 0, entry_index: 0 },
        originalActionHash: mockActionHash(50),
        originalEntryHash: mockEntryHash(3),
      },
      entry: {
        entryHash: mockEntryHash(6),
        entryContent: new Uint8Array([40, 50, 60]),
        entryType: { zome_id: 0, entry_index: 0 },
      },
    };

    const ops = pendingRecordToOps(pendingRecord);
    const variants = ops.map(getOpVariant);

    expect(variants).toContain("StoreRecord");
    expect(variants).toContain("StoreEntry");
    expect(variants).toContain("RegisterAgentActivity");
    expect(variants.filter((v) => v === "RegisterUpdate")).toHaveLength(2);
    expect(ops).toHaveLength(5);
  });

  it("converts PendingRecord with CreateLink to ops", () => {
    const pendingRecord: PendingRecord = {
      action: {
        actionHash: mockActionHash(52),
        actionType: "CreateLink",
        actionSeq: 5,
        author: mockAgentPubKey(1),
        timestamp: BigInt(Date.now()) * 1000n,
        prevActionHash: mockActionHash(2),
        signature: mockSignature(),
        baseAddress: mockEntryHash(9),
        targetAddress: mockEntryHash(10),
        zomeIndex: 0,
        linkType: 0,
        tag: new Uint8Array([1, 2, 3]),
      },
    };

    const ops = pendingRecordToOps(pendingRecord);
    const variants = ops.map(getOpVariant);

    expect(variants).toContain("StoreRecord");
    expect(variants).toContain("RegisterAgentActivity");
    expect(variants).toContain("RegisterCreateLink");
    expect(ops).toHaveLength(3);
  });
});

// ============================================================================
// Tests: getOpVariant
// ============================================================================

describe("getOpVariant", () => {
  it("returns correct variant name for each Op type", () => {
    const action = mockCreateAction();
    const entry = mockEntry();
    const record = mockRecord(action, entry);

    const storeRecord = buildOpFromRecord(record, ChainOpType.StoreRecord)!;
    expect(getOpVariant(storeRecord)).toBe("StoreRecord");

    const storeEntry = buildOpFromRecord(record, ChainOpType.StoreEntry)!;
    expect(getOpVariant(storeEntry)).toBe("StoreEntry");

    const regActivity = buildOpFromRecord(
      record,
      ChainOpType.RegisterAgentActivity
    )!;
    expect(getOpVariant(regActivity)).toBe("RegisterAgentActivity");
  });

  it("returns Unknown for unrecognized Op", () => {
    expect(getOpVariant({} as Op)).toBe("Unknown");
  });
});

// ============================================================================
// Tests: Op serialization structure
// ============================================================================

describe("Op structure verification", () => {
  it("StoreEntry action wraps Create in externally-tagged EntryCreationAction", () => {
    const action = mockCreateAction();
    const entry = mockEntry();
    const record = mockRecord(action, entry);

    const op = buildOpFromRecord(record, ChainOpType.StoreEntry)!;
    expect("StoreEntry" in op).toBe(true);

    if ("StoreEntry" in op) {
      const eca = op.StoreEntry.action.hashed.content;
      // Should be { Create: { ...fields } } not { type: "Create", ... }
      expect("Create" in eca).toBe(true);
      expect("Update" in eca).toBe(false);
    }
  });

  it("StoreEntry action wraps Update in externally-tagged EntryCreationAction", () => {
    const action = mockUpdateAction();
    const entry = mockEntry();
    const record = mockRecord(action, entry);

    const op = buildOpFromRecord(record, ChainOpType.StoreEntry)!;
    expect("StoreEntry" in op).toBe(true);

    if ("StoreEntry" in op) {
      const eca = op.StoreEntry.action.hashed.content;
      expect("Update" in eca).toBe(true);
      expect("Create" in eca).toBe(false);
    }
  });

  it("RegisterUpdate inner content has no type field", () => {
    const action = mockUpdateAction();
    const entry = mockEntry();
    const record = mockRecord(action, entry);

    const op = buildOpFromRecord(record, ChainOpType.RegisterUpdatedContent)!;
    if ("RegisterUpdate" in op) {
      const inner = op.RegisterUpdate.update.hashed.content;
      expect((inner as any).type).toBeUndefined();
      expect((inner as any).author).toBeDefined();
      expect((inner as any).original_action_address).toBeDefined();
    }
  });

  it("RegisterDelete inner content has no type field", () => {
    const action = mockDeleteAction();
    const record = mockRecord(action);

    const op = buildOpFromRecord(record, ChainOpType.RegisterDeletedBy)!;
    if ("RegisterDelete" in op) {
      const inner = op.RegisterDelete.delete.hashed.content;
      expect((inner as any).type).toBeUndefined();
      expect((inner as any).deletes_address).toBeDefined();
    }
  });

  it("RegisterCreateLink inner content has no type field", () => {
    const action = mockCreateLinkAction();
    const record = mockRecord(action);

    const op = buildOpFromRecord(record, ChainOpType.RegisterAddLink)!;
    if ("RegisterCreateLink" in op) {
      const inner = op.RegisterCreateLink.create_link.hashed.content;
      expect((inner as any).type).toBeUndefined();
      expect((inner as any).base_address).toBeDefined();
    }
  });

  it("all Op variants include signature and action hash", () => {
    const action = mockCreateAction();
    const entry = mockEntry();
    const record = mockRecord(action, entry);
    const signature = record.signed_action.signature;
    const actionHash = record.signed_action.hashed.hash;

    const ops = recordToOps(record);
    for (const op of ops) {
      if ("StoreRecord" in op) {
        expect(op.StoreRecord.record.signed_action.signature).toEqual(
          signature
        );
      } else if ("StoreEntry" in op) {
        expect(op.StoreEntry.action.signature).toEqual(signature);
        expect(op.StoreEntry.action.hashed.hash).toEqual(actionHash);
      } else if ("RegisterAgentActivity" in op) {
        expect(op.RegisterAgentActivity.action.signature).toEqual(signature);
      }
    }
  });
});
