/**
 * Tests for validation pipeline
 *
 * Tests invokeInlineValidation flow including:
 * - Zome resolution for different op types
 * - Validation skipping when no validate export
 * - Error handling for Invalid and UnresolvedDependencies results
 *
 * Since the validate pipeline instantiates real WASM modules, these tests
 * mock the RibosomeRuntime and HostFunctionRegistry at the module level.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  HoloHashType,
  hashFrom32AndType,
  type ActionHash,
  type AgentPubKey,
  type EntryHash,
} from "@holochain/client";
import { encode } from "@msgpack/msgpack";

import { invokeInlineValidation } from "./validate";
import type { CallContext, PendingRecord } from "./call-context";
import type { DnaManifestRuntime, ZomeDefinition } from "../types/bundle-types";
import {
  setStorageProvider,
  type StorageProvider,
} from "../storage/storage-provider";

// ============================================================================
// Mock WASM Runtime and Registry
// ============================================================================

// Track what validate was called with
let mockValidateFn: ((ptr: number, len: number) => bigint) | undefined;
let mockValidateCallCount = 0;

// Mock the runtime module
vi.mock("./runtime", () => {
  const mockModule = {};
  const mockExports = {
    memory: new WebAssembly.Memory({ initial: 1 }),
    __hc__allocate_1: (size: number) => {
      // Simple bump allocator for test
      return 8;
    },
    __hc__deallocate_1: () => {},
  };

  return {
    getRibosomeRuntime: () => ({
      getOrCompileModule: vi.fn().mockResolvedValue(mockModule),
      instantiateModule: vi.fn().mockImplementation(async () => {
        // Return a mock instance that has the validate export
        // if mockValidateFn is set
        const exports: Record<string, unknown> = { ...mockExports };
        if (mockValidateFn) {
          exports.validate = mockValidateFn;
        }
        return { exports };
      }),
    }),
    RibosomeRuntime: vi.fn(),
  };
});

// Mock the host function registry
vi.mock("./host-fn", () => ({
  getHostFunctionRegistry: () => ({
    buildImportObject: vi.fn().mockReturnValue({}),
  }),
}));

// Mock serialization to pass through
vi.mock("./serialization", () => ({
  serializeToWasm: vi.fn().mockReturnValue({ ptr: 8, len: 10 }),
  deserializeFromWasm: vi.fn().mockReturnValue({ Ok: "Valid" }),
}));

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

function mockSignature(): Uint8Array {
  return new Uint8Array(64).fill(1);
}

function mockDnaManifest(
  integrityZomes: ZomeDefinition[]
): DnaManifestRuntime {
  return {
    name: "test_dna",
    integrity_zomes: integrityZomes,
    coordinator_zomes: [],
  };
}

function mockZomeDef(
  name: string,
  index: number,
  hasWasm: boolean = true
): ZomeDefinition {
  return {
    name,
    index,
    wasm: hasWasm ? new Uint8Array([0, 97, 115, 109]) : undefined,
    dependencies: [],
  };
}

function mockCallContext(): CallContext {
  return {
    cellId: [
      new Uint8Array(39).fill(100),
      mockAgentPubKey(1),
    ],
    zome: "test_coord_zome",
    fn: "test_fn",
    payload: null,
    provenance: mockAgentPubKey(1),
  };
}

function makePendingCreate(): PendingRecord {
  return {
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
}

function makePendingCreateLink(): PendingRecord {
  return {
    action: {
      actionHash: mockActionHash(60),
      actionType: "CreateLink",
      actionSeq: 4,
      author: mockAgentPubKey(1),
      timestamp: BigInt(Date.now()) * 1000n,
      prevActionHash: mockActionHash(50),
      signature: mockSignature(),
      baseAddress: mockEntryHash(9),
      targetAddress: mockEntryHash(10),
      zomeIndex: 1,
      linkType: 0,
      tag: new Uint8Array([1, 2, 3]),
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("invokeInlineValidation", () => {
  const mockStorage: Partial<StorageProvider> = {
    getAction: vi.fn().mockReturnValue(null),
    getEntry: vi.fn().mockReturnValue(null),
    getActionByEntryHash: vi.fn().mockReturnValue(null),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateFn = undefined;
    mockValidateCallCount = 0;
    setStorageProvider(mockStorage as StorageProvider);
  });

  it("should pass when no pending records", async () => {
    const context = mockCallContext();
    const manifest = mockDnaManifest([mockZomeDef("integrity_zome", 0)]);

    // Should not throw
    await invokeInlineValidation([], context, manifest);
  });

  it("should pass when validate export does not exist", async () => {
    // No validate function set - WASM has no validate export
    mockValidateFn = undefined;

    const context = mockCallContext();
    const manifest = mockDnaManifest([mockZomeDef("integrity_zome", 0)]);
    const pendingRecords = [makePendingCreate()];

    // Should not throw (returns "Valid" when no validate export)
    await invokeInlineValidation(pendingRecords, context, manifest);
  });

  it("should pass when validate returns Valid", async () => {
    // Mock validate function that returns a valid result
    mockValidateFn = (_ptr: number, _len: number): bigint => {
      mockValidateCallCount++;
      // Return ptr=8, len=10 (packed into i64)
      return (8n << 32n) | 10n;
    };

    // Mock deserializeFromWasm to return Valid
    const { deserializeFromWasm } = await import("./serialization");
    (deserializeFromWasm as any).mockReturnValue({ Ok: "Valid" });

    const context = mockCallContext();
    const manifest = mockDnaManifest([mockZomeDef("integrity_zome", 0)]);
    const pendingRecords = [makePendingCreate()];

    await invokeInlineValidation(pendingRecords, context, manifest);
  });

  it("should throw when validate returns Invalid", async () => {
    mockValidateFn = (_ptr: number, _len: number): bigint => {
      return (8n << 32n) | 10n;
    };

    const { deserializeFromWasm } = await import("./serialization");
    (deserializeFromWasm as any).mockReturnValue({
      Ok: { Invalid: "Entry is not valid" },
    });

    const context = mockCallContext();
    const manifest = mockDnaManifest([mockZomeDef("integrity_zome", 0)]);
    const pendingRecords = [makePendingCreate()];

    await expect(
      invokeInlineValidation(pendingRecords, context, manifest)
    ).rejects.toThrow("Validation failed");
  });

  it("should throw when validate returns UnresolvedDependencies", async () => {
    mockValidateFn = (_ptr: number, _len: number): bigint => {
      return (8n << 32n) | 10n;
    };

    const { deserializeFromWasm } = await import("./serialization");
    (deserializeFromWasm as any).mockReturnValue({
      Ok: { UnresolvedDependencies: { Hashes: [mockEntryHash(99)] } },
    });

    const context = mockCallContext();
    const manifest = mockDnaManifest([mockZomeDef("integrity_zome", 0)]);
    const pendingRecords = [makePendingCreate()];

    await expect(
      invokeInlineValidation(pendingRecords, context, manifest)
    ).rejects.toThrow("unresolved dependencies");
  });

  it("should skip zomes with no WASM", async () => {
    // Zome with no WASM should be skipped
    const zomeNoWasm = mockZomeDef("no_wasm_zome", 0, false);

    const context = mockCallContext();
    const manifest = mockDnaManifest([zomeNoWasm]);
    const pendingRecords = [makePendingCreate()];

    // Should not throw - zome is skipped
    await invokeInlineValidation(pendingRecords, context, manifest);
  });

  it("should validate multiple pending records", async () => {
    mockValidateFn = (_ptr: number, _len: number): bigint => {
      mockValidateCallCount++;
      return (8n << 32n) | 10n;
    };

    const { deserializeFromWasm } = await import("./serialization");
    (deserializeFromWasm as any).mockReturnValue({ Ok: "Valid" });

    const context = mockCallContext();
    const manifest = mockDnaManifest([mockZomeDef("integrity_zome", 0)]);
    const pendingRecords = [makePendingCreate(), makePendingCreate()];

    await invokeInlineValidation(pendingRecords, context, manifest);

    // Each Create produces 3 ops (StoreRecord, StoreEntry, RegisterAgentActivity)
    // RegisterAgentActivity goes to ALL integrity zomes (1 zome)
    // StoreRecord with App entry goes to zome[0]
    // StoreEntry with App entry goes to zome[0]
    // So 3 validate calls per record, 6 total for 2 records
    expect(mockValidateCallCount).toBe(6);
  });

  it("should handle multiple integrity zomes for RegisterAgentActivity", async () => {
    mockValidateFn = (_ptr: number, _len: number): bigint => {
      mockValidateCallCount++;
      return (8n << 32n) | 10n;
    };

    const { deserializeFromWasm } = await import("./serialization");
    (deserializeFromWasm as any).mockReturnValue({ Ok: "Valid" });

    const context = mockCallContext();
    const manifest = mockDnaManifest([
      mockZomeDef("integrity_zome_0", 0),
      mockZomeDef("integrity_zome_1", 1),
    ]);

    const pendingRecords = [makePendingCreate()];

    await invokeInlineValidation(pendingRecords, context, manifest);

    // Create produces: StoreRecord(zome_index=0), StoreEntry(zome_index=0),
    // RegisterAgentActivity(all zomes = 2)
    // Total: 1 + 1 + 2 = 4 validate calls
    expect(mockValidateCallCount).toBe(4);
  });
});
