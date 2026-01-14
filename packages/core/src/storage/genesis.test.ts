/**
 * Genesis Tests
 *
 * Tests for genesis record creation and publishing pipeline.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { initializeGenesis, type GenesisResult } from "./genesis";
import { buildRecords, storedActionToClientAction } from "../dht/record-converter";
import { produceOpsFromRecord } from "../dht/produce-ops";
import { ActionType, HASH_TYPE_PREFIX, HoloHashType, dhtLocationFrom32 } from "@holochain/client";
import type { StoredAction } from "./types";

// Mock storage
const createMockStorage = () => {
  let chainHead: any = null;
  const actions: any[] = [];
  const entries: any[] = [];

  return {
    getChainHead: vi.fn(() => chainHead),
    putAction: vi.fn((action: any) => {
      actions.push(action);
    }),
    putEntry: vi.fn((entry: any) => {
      entries.push(entry);
    }),
    updateChainHead: vi.fn((dnaHash, agentPubKey, seq, hash, timestamp) => {
      chainHead = { actionSeq: seq, actionHash: hash, timestamp };
    }),
    getStoredActions: () => actions,
    getStoredEntries: () => entries,
    setChainHead: (head: any) => {
      chainHead = head;
    },
  };
};

// Mock signing
vi.mock("../signing", () => ({
  signAction: vi.fn((pubKey: Uint8Array, data: Uint8Array) => {
    // Return 64-byte mock signature
    return new Uint8Array(64).fill(0xAB);
  }),
}));

// Test fixtures - create valid HoloHashes with correct prefixes and DHT locations
const createTestHash = (type: HoloHashType, fillByte: number): Uint8Array => {
  const core32 = new Uint8Array(32).fill(fillByte);
  const prefix = HASH_TYPE_PREFIX[type];
  const location = dhtLocationFrom32(core32);
  const hash = new Uint8Array(39);
  hash.set(prefix, 0);
  hash.set(core32, 3);
  hash.set(location, 35);
  return hash;
};

const testDnaHash = createTestHash(HoloHashType.Dna, 0x01);
const testAgentPubKey = createTestHash(HoloHashType.Agent, 0x02);

describe("genesis", () => {
  describe("initializeGenesis", () => {
    it("should return pendingRecords when chain is empty", async () => {
      const storage = createMockStorage();

      const result = await initializeGenesis(
        storage as any,
        testDnaHash,
        testAgentPubKey
      );

      expect(result.initialized).toBe(true);
      expect(result.pendingRecords).toHaveLength(4);

      // Verify action types
      const actionTypes = result.pendingRecords.map(r => r.action.actionType);
      expect(actionTypes).toEqual([
        "Dna",
        "AgentValidationPkg",
        "Create",
        "InitZomesComplete",
      ]);
    });

    it("should not initialize when chain already exists", async () => {
      const storage = createMockStorage();
      storage.setChainHead({ actionSeq: 3, actionHash: new Uint8Array(39), timestamp: BigInt(0) });

      const result = await initializeGenesis(
        storage as any,
        testDnaHash,
        testAgentPubKey
      );

      expect(result.initialized).toBe(false);
      expect(result.pendingRecords).toHaveLength(0);
    });

    it("should include agent entry for Create action", async () => {
      const storage = createMockStorage();

      const result = await initializeGenesis(
        storage as any,
        testDnaHash,
        testAgentPubKey
      );

      // Find the Create action (seq: 2)
      const createRecord = result.pendingRecords.find(r => r.action.actionType === "Create");
      expect(createRecord).toBeDefined();
      expect(createRecord!.entry).toBeDefined();
      expect(createRecord!.entry!.entryType).toBe("Agent");
    });
  });

  describe("record conversion", () => {
    it("should convert Dna action to client format", async () => {
      const storage = createMockStorage();
      const result = await initializeGenesis(storage as any, testDnaHash, testAgentPubKey);

      const dnaRecord = result.pendingRecords[0];
      const clientAction = storedActionToClientAction(dnaRecord.action as StoredAction);

      expect(clientAction.type).toBe(ActionType.Dna);
      expect((clientAction as any).hash).toBeInstanceOf(Uint8Array);
    });

    it("should convert AgentValidationPkg action to client format", async () => {
      const storage = createMockStorage();
      const result = await initializeGenesis(storage as any, testDnaHash, testAgentPubKey);

      const avpRecord = result.pendingRecords[1];
      const clientAction = storedActionToClientAction(avpRecord.action as StoredAction);

      expect(clientAction.type).toBe(ActionType.AgentValidationPkg);
      expect((clientAction as any).action_seq).toBe(1);
    });

    it("should convert InitZomesComplete action to client format", async () => {
      const storage = createMockStorage();
      const result = await initializeGenesis(storage as any, testDnaHash, testAgentPubKey);

      const izcRecord = result.pendingRecords[3];
      const clientAction = storedActionToClientAction(izcRecord.action as StoredAction);

      expect(clientAction.type).toBe(ActionType.InitZomesComplete);
      expect((clientAction as any).action_seq).toBe(3);
    });

    it("should build @holochain/client Records from genesis pendingRecords", async () => {
      const storage = createMockStorage();
      const result = await initializeGenesis(storage as any, testDnaHash, testAgentPubKey);

      const clientRecords = buildRecords(result.pendingRecords);

      expect(clientRecords).toHaveLength(4);

      // Verify structure
      for (const record of clientRecords) {
        expect(record.signed_action).toBeDefined();
        expect(record.signed_action.hashed).toBeDefined();
        expect(record.signed_action.hashed.hash).toBeInstanceOf(Uint8Array);
        expect(record.signed_action.hashed.content).toBeDefined();
        expect(record.signed_action.signature).toBeInstanceOf(Uint8Array);
      }
    });
  });

  describe("DHT op production", () => {
    it("should produce DhtOps for all genesis records", async () => {
      const storage = createMockStorage();
      const result = await initializeGenesis(storage as any, testDnaHash, testAgentPubKey);
      const clientRecords = buildRecords(result.pendingRecords);

      // Produce ops from each record
      let totalOps = 0;
      for (const record of clientRecords) {
        const ops = produceOpsFromRecord(record);
        expect(ops.length).toBeGreaterThan(0);
        totalOps += ops.length;
      }

      // Genesis records should produce:
      // - Dna: StoreRecord + RegisterAgentActivity = 2
      // - AgentValidationPkg: StoreRecord + RegisterAgentActivity = 2
      // - Create (Agent): StoreRecord + RegisterAgentActivity + StoreEntry = 3
      // - InitZomesComplete: StoreRecord + RegisterAgentActivity = 2
      // Total: 9 ops
      expect(totalOps).toBe(9);
    });

    it("should produce StoreEntry op for Create (Agent) action", async () => {
      const storage = createMockStorage();
      const result = await initializeGenesis(storage as any, testDnaHash, testAgentPubKey);
      const clientRecords = buildRecords(result.pendingRecords);

      // Find the Create record (seq: 2, index 2)
      const createRecord = clientRecords[2];
      const ops = produceOpsFromRecord(createRecord);

      // Should have StoreRecord, RegisterAgentActivity, and StoreEntry
      const opTypes = ops.map(op => op.type);
      expect(opTypes).toContain("StoreRecord");
      expect(opTypes).toContain("RegisterAgentActivity");
      expect(opTypes).toContain("StoreEntry");
    });
  });
});
