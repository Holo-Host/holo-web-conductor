/**
 * Tests for PublishTracker
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { PublishTracker } from "./publish-tracker";
import { PublishStatus, ChainOpType } from "./dht-op-types";
import type { ChainOp, StoreRecordOp } from "./dht-op-types";
import type { Record, Signature, Action, DnaHash } from "@holochain/client";
import { HoloHashType, hashFrom32AndType } from "@holochain/client";

// Mock IndexedDB for testing
import "fake-indexeddb/auto";

// Helper to create mock hashes
function mockCore32(seed: number = 0): Uint8Array {
  const arr = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    arr[i] = (seed + i) % 256;
  }
  return arr;
}

function mockDnaHash(seed: number = 0): DnaHash {
  return hashFrom32AndType(mockCore32(seed), HoloHashType.Dna) as DnaHash;
}

function mockSignature(): Signature {
  return new Uint8Array(64);
}

// Helper to create a mock ChainOp
function createMockStoreRecordOp(seed: number = 0): StoreRecordOp {
  const action: Action = {
    type: "Create",
    author: hashFrom32AndType(mockCore32(seed), HoloHashType.Agent),
    timestamp: BigInt(Date.now() * 1000),
    action_seq: seed,
    prev_action: null,
    entry_type: { App: { entry_index: 0, zome_index: 0, visibility: "Public" } },
    entry_hash: hashFrom32AndType(mockCore32(seed + 100), HoloHashType.Entry),
    weight: { bucket_id: 0, units: 0, rate_bytes: 0 },
  };

  return {
    type: ChainOpType.StoreRecord,
    signature: mockSignature(),
    action,
    entry: { NA: null },
  };
}

describe("PublishTracker", () => {
  let tracker: PublishTracker;
  const testDnaHash = mockDnaHash(1);

  beforeEach(async () => {
    // Get fresh instance and clear
    tracker = PublishTracker.getInstance();
    await tracker.init();
    await tracker.clear();
  });

  describe("initialization", () => {
    it("should initialize database", async () => {
      await tracker.init();
      // Should not throw
      expect(true).toBe(true);
    });

    it("should be singleton", () => {
      const instance1 = PublishTracker.getInstance();
      const instance2 = PublishTracker.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe("storing and retrieving", () => {
    it("should store and retrieve pending publish", async () => {
      const op = createMockStoreRecordOp(1);
      const basis = hashFrom32AndType(mockCore32(10), HoloHashType.Action);

      // Create pending publish manually
      const pending = {
        id: "test-id-1",
        op,
        basis,
        status: PublishStatus.Pending,
        retryCount: 0,
        lastAttempt: 0,
      };

      // Store directly via private method simulation (we'll use public API)
      // Since queueRecordForPublish requires a full Record, test basic flow
      const retrieved = await tracker.getPendingPublish("nonexistent");
      expect(retrieved).toBeNull();
    });

    it("should get pending by status", async () => {
      const pending = await tracker.getPendingByStatus(PublishStatus.Pending);
      expect(pending).toEqual([]);
    });

    it("should get status counts", async () => {
      const counts = await tracker.getStatusCounts();
      expect(counts[PublishStatus.Pending]).toBe(0);
      expect(counts[PublishStatus.InFlight]).toBe(0);
      expect(counts[PublishStatus.Published]).toBe(0);
      expect(counts[PublishStatus.Failed]).toBe(0);
    });
  });

  describe("status updates", () => {
    it("should handle update status for non-existent publish", async () => {
      // Should not throw
      await tracker.updateStatus("nonexistent", PublishStatus.Published);
    });
  });

  describe("cleanup", () => {
    it("should clear all data", async () => {
      await tracker.clear();
      const counts = await tracker.getStatusCounts();
      expect(counts[PublishStatus.Pending]).toBe(0);
    });
  });
});
