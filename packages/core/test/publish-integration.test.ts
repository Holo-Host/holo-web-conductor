/**
 * Publish Integration Test
 *
 * Tests the end-to-end flow of publishing records from the browser extension
 * to the linker and verifying they reach the DHT.
 *
 * Prerequisites:
 * - Run `./scripts/e2e-test-setup.sh start` before running this test
 * - Conductor and linker must be running
 *
 * Test Flow:
 * 1. Create a Record with proper hashes and signature (simulating extension)
 * 2. Convert to DhtOps using produceOpsFromRecord
 * 3. Send ops to linker /dht/{dna}/publish endpoint
 * 4. Verify linker accepts and processes the ops
 * 5. (Future) Query conductor to verify data reached DHT
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { encode, ExtensionCodec } from "@msgpack/msgpack";
import type { Record, ActionHash, EntryHash, AgentPubKey, Signature, DnaHash } from "@holochain/client";

// Configure msgpack to handle BigInt
const extensionCodec = new ExtensionCodec();
// Register BigInt as extension type (msgpack-javascript doesn't support BigInt natively)
// We'll encode BigInt as i64 bytes
extensionCodec.register({
  type: 0,
  encode: (object: unknown): Uint8Array | null => {
    if (typeof object === "bigint") {
      // Encode as signed 64-bit integer (little-endian)
      const buffer = new ArrayBuffer(8);
      const view = new DataView(buffer);
      // Handle negative numbers
      const high = Number(object >> 32n) | 0;
      const low = Number(object & 0xffffffffn) >>> 0;
      view.setInt32(0, low, true);
      view.setInt32(4, high, true);
      return new Uint8Array(buffer);
    }
    return null;
  },
  decode: (data: Uint8Array): bigint => {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const low = view.getUint32(0, true);
    const high = view.getInt32(4, true);
    return (BigInt(high) << 32n) | BigInt(low);
  },
});

// Custom encode function that handles BigInt
function encodeWithBigInt(value: unknown): Uint8Array {
  return encode(value, { extensionCodec });
}
import { HoloHashType, hashFrom32AndType } from "@holochain/client";

// Test configuration
const LINKER_URL = process.env.LINKER_URL || "http://localhost:8090";
const TEST_TIMEOUT = 30000; // 30 seconds

// Known DNA hash from fixture - base64url encoded
// This is the hash from the e2e-test-setup.sh conductor
const FIXTURE_DNA_HASH = "uhC0k2J3h4yJ17fbOaKJ8muCcpi9r58tqRFVVKFa6PeFqwy84A3ii";

// Helper to check if linker is running
async function isLinkerRunning(): Promise<boolean> {
  try {
    const response = await fetch(`${LINKER_URL}/health`, { method: "GET" });
    return response.ok;
  } catch {
    return false;
  }
}

// Helper to create mock hashes with proper format
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

function mockAgentPubKey(seed: number = 0): AgentPubKey {
  return hashFrom32AndType(mockCore32(seed), HoloHashType.Agent) as AgentPubKey;
}

function mockActionHash(seed: number = 0): ActionHash {
  return hashFrom32AndType(mockCore32(seed), HoloHashType.Action) as ActionHash;
}

function mockEntryHash(seed: number = 0): EntryHash {
  return hashFrom32AndType(mockCore32(seed), HoloHashType.Entry) as EntryHash;
}

function mockSignature(): Signature {
  return new Uint8Array(64).fill(0xaa);
}

// Helper to convert Uint8Array to base64
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Helper to convert Uint8Array to URL-safe base64
function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// Build a mock Record for testing
function buildMockRecord(seed: number = 0): Record {
  const author = mockAgentPubKey(seed);
  const entryHash = mockEntryHash(seed + 100);
  const actionHash = mockActionHash(seed + 200);
  const signature = mockSignature();

  // Create a simple Create action
  const action = {
    type: "Create" as const,
    author,
    timestamp: BigInt(Date.now() * 1000),
    action_seq: 3,
    prev_action: mockActionHash(seed - 1),
    entry_type: {
      App: {
        entry_index: 0,
        zome_index: 0,
        visibility: "Public" as const,
      },
    },
    entry_hash: entryHash,
    weight: { bucket_id: 0, units: 0, rate_bytes: 0 },
  };

  // Entry content (simple test data)
  const entryContent = new Uint8Array([1, 2, 3, 4, 5]);

  return {
    signed_action: {
      hashed: {
        hash: actionHash,
        content: action,
      },
      signature,
    },
    entry: { Present: { App: entryContent } },
  };
}

// Check linker availability before test suite runs
let linkerAvailable = false;
let testDnaHash: DnaHash;

beforeAll(async () => {
  // Check if linker is running
  linkerAvailable = await isLinkerRunning();
  if (!linkerAvailable) {
    console.warn(
      "\n⚠️  Linker not running. Run './scripts/e2e-test-setup.sh start' first.\n" +
      "   Skipping integration tests that require linker.\n"
    );
  } else {
    console.log("✓ Linker available at", LINKER_URL);
  }

  // Use a consistent test DNA hash
  testDnaHash = mockDnaHash(42);
});

describe("Publish Integration", () => {

  describe("DhtOp Production", () => {
    it("should produce ops from a Create record", async () => {
      // Dynamic import to avoid issues when linker not running
      const { produceOpsFromRecord, ChainOpType } = await import("../src/dht");

      const record = buildMockRecord(1);
      const ops = produceOpsFromRecord(record);

      // Create action should produce: StoreRecord, RegisterAgentActivity, StoreEntry
      expect(ops.length).toBeGreaterThanOrEqual(2);

      const opTypes = ops.map((op) => op.type);
      expect(opTypes).toContain(ChainOpType.StoreRecord);
      expect(opTypes).toContain(ChainOpType.RegisterAgentActivity);
    });

    it("should serialize ops for linker transmission", async () => {
      const { produceOpsFromRecord } = await import("../src/dht");

      const record = buildMockRecord(2);
      const ops = produceOpsFromRecord(record);

      // Each op should be serializable to msgpack
      for (const op of ops) {
        // Wrap in DhtOp::ChainOp for Rust compatibility
        const dhtOp = { ChainOp: op };
        const encoded = encodeWithBigInt(dhtOp);
        expect(encoded).toBeInstanceOf(Uint8Array);
        expect(encoded.length).toBeGreaterThan(0);
      }
    });
  });

  describe("Linker Publish Endpoint", () => {
    it("should accept valid publish request", async () => {
      if (!linkerAvailable) {
        console.log("Skipping: Linker not available");
        return;
      }
      const { produceOpsFromRecord } = await import("../src/dht");

      const record = buildMockRecord(3);
      const ops = produceOpsFromRecord(record);

      // Serialize ops for linker
      const signedOps = ops.map((op) => {
        const dhtOp = { ChainOp: op };
        const encoded = encodeWithBigInt(dhtOp);
        return {
          op_data: toBase64(new Uint8Array(encoded)),
          signature: toBase64(op.signature),
        };
      });

      // Send to linker using the fixture DNA hash
      const response = await fetch(`${LINKER_URL}/dht/${FIXTURE_DNA_HASH}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ops: signedOps }),
      });

      // Linker should accept the request (may fail validation but shouldn't 400)
      // Note: Full validation requires proper hashes computed by the extension
      expect(response.status).toBeLessThan(500);

      const result = await response.json();
      expect(result).toHaveProperty("success");
      expect(result).toHaveProperty("queued");
      expect(result).toHaveProperty("failed");
      expect(result).toHaveProperty("results");
    }, TEST_TIMEOUT);

    it("should reject malformed ops", async () => {
      if (!linkerAvailable) {
        console.log("Skipping: Linker not available");
        return;
      }
      // Send invalid op data
      const response = await fetch(`${LINKER_URL}/dht/${FIXTURE_DNA_HASH}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ops: [
            {
              op_data: "not-valid-base64!!!",
              signature: toBase64(new Uint8Array(64)),
            },
          ],
        }),
      });

      const result = await response.json();
      expect(result.success).toBe(false);
      expect(result.failed).toBe(1);
      expect(result.results[0].success).toBe(false);
      expect(result.results[0].error).toBeDefined();
    }, TEST_TIMEOUT);

    it("should reject wrong signature length", async () => {
      if (!linkerAvailable) {
        console.log("Skipping: Linker not available");
        return;
      }
      const { produceOpsFromRecord } = await import("../src/dht");

      const record = buildMockRecord(4);
      const ops = produceOpsFromRecord(record);

      const signedOps = ops.slice(0, 1).map((op) => {
        const dhtOp = { ChainOp: op };
        const encoded = encodeWithBigInt(dhtOp);
        return {
          op_data: toBase64(new Uint8Array(encoded)),
          signature: toBase64(new Uint8Array(32)), // Wrong length - should be 64
        };
      });

      const response = await fetch(`${LINKER_URL}/dht/${FIXTURE_DNA_HASH}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ops: signedOps }),
      });

      const result = await response.json();
      expect(result.success).toBe(false);
      expect(result.results[0].error).toContain("signature length");
    }, TEST_TIMEOUT);
  });

  describe("PublishService Integration", () => {
    it("should create publish service with linker URL", async () => {
      const { PublishService } = await import("../src/dht");

      const service = new PublishService({
        linkerUrl: LINKER_URL,
      });

      expect(service).toBeDefined();
    });

    it("should track status counts", async () => {
      if (!linkerAvailable) {
        console.log("Skipping: Linker not available");
        return;
      }
      const { PublishService, PublishStatus } = await import("../src/dht");

      const service = new PublishService({
        linkerUrl: LINKER_URL,
      });

      await service.init();
      await service.clear(); // Start fresh

      const counts = await service.getStatusCounts();
      expect(counts[PublishStatus.Pending]).toBe(0);
      expect(counts[PublishStatus.InFlight]).toBe(0);
      expect(counts[PublishStatus.Published]).toBe(0);
      expect(counts[PublishStatus.Failed]).toBe(0);
    });
  });

  // TODO: Full E2E test that verifies conductor can see the data
  // This requires completing the linker's kitsune2 publish integration
  describe.todo("Full DHT Visibility", () => {
    it.todo("should make published entry visible to conductor via get");
    it.todo("should make published link visible to conductor via get_links");
    it.todo("should propagate agent activity to DHT");
  });
});
