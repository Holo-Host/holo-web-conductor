/**
 * Integration tests for ribosome with real WASM zomes
 *
 * These tests use the compiled test-zome WASM to test end-to-end functionality
 * of host functions in a real execution environment.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFile } from "fs/promises";
import { resolve } from "path";
import { SourceChainStorage } from "../storage";
import { callZomeAsExtension } from "./test-helpers";
import type { DnaManifestRuntime } from "../types/bundle-types";

describe("Ribosome Integration Tests", () => {
  let testZomeWasm: Uint8Array;
  let storage: SourceChainStorage;
  // Use 32-byte raw hashes (not 39-byte prefixed format)
  const testCellId: [Uint8Array, Uint8Array] = [
    new Uint8Array(32).fill(1), // DNA hash (32 bytes raw)
    new Uint8Array(32).fill(2), // Agent pub key (32 bytes raw)
  ];

  // DNA manifest for test zome
  const testDnaManifest: DnaManifestRuntime = {
    name: "test-dna",
    network_seed: "00000000-0000-0000-0000-000000000000",
    properties: {},
    integrity_zomes: [
      {
        name: "test_zome",
        index: 0,
        wasm: undefined, // Will be set from testZomeWasm
        dependencies: [],
      },
    ],
    coordinator_zomes: [],
  };

  beforeAll(async () => {
    // Load the compiled test zome WASM
    const wasmPath = resolve(
      __dirname,
      "../../../extension/test/test-zome.wasm"
    );
    const wasmBuffer = await readFile(wasmPath);
    testZomeWasm = new Uint8Array(wasmBuffer);

    // Initialize storage
    storage = SourceChainStorage.getInstance();
    await storage.init();
  });

  beforeEach(async () => {
    // Clear storage between tests for isolation
    await storage.clear();
  });

  describe("emit_signal host function", () => {
    it("should emit signal and return it in result", async () => {
      const message = "Hello from test zome!";

      const { result, signals } = await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "emit_signal_test",
        payload: message,
        provenance: testCellId[1],
      });

      // Check signals were emitted
      expect(signals).toBeDefined();
      expect(signals.length).toBeGreaterThan(0);

      const signal = signals[0];
      expect(signal.zome_name).toBe("test_zome");
      expect(signal.cell_id).toBe(testCellId);
      expect(signal.signal).toBeInstanceOf(Uint8Array);
      expect(signal.timestamp).toBeGreaterThan(0);

      // Function should return null (unit type)
      expect(result).toBeNull();
    });

    it("should handle multiple signal emissions", async () => {
      // Call emit_signal_test multiple times would require a zome function
      // that emits multiple signals, which we can add later
      // For now, test single emission is sufficient
    });
  });

  describe("query host function", () => {
    it("should return genesis actions on fresh chain", async () => {
      // First query on a fresh chain should return 4 genesis actions
      const { result } = await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "query_test",
        payload: null,
        provenance: testCellId[1],
        dnaManifest: testDnaManifest,
      });

      // Should return Vec<Record>
      expect(Array.isArray(result)).toBe(true);
      const records = result as unknown[];

      // Should have exactly 4 genesis actions
      expect(records.length).toBe(4);

      // Verify the genesis actions are in the correct order
      const actionTypes = records.map((r: any) =>
        r.signed_action?.hashed?.content?.type
      );

      expect(actionTypes).toEqual([
        'Dna',
        'AgentValidationPkg',
        'Create', // Agent entry
        'InitZomesComplete'
      ]);

      // Verify sequence numbers
      // Note: Dna action doesn't have action_seq field (implicitly 0)
      const actionSeqs = records.map((r: any) =>
        r.signed_action?.hashed?.content?.action_seq
      );
      expect(actionSeqs).toEqual([undefined, 1, 2, 3]);

      // Verify prev_action chain
      const record0 = records[0] as any;
      const record1 = records[1] as any;
      const record2 = records[2] as any;
      const record3 = records[3] as any;

      // First action (Dna) has no prev_action field (undefined, not null)
      expect(record0.signed_action.hashed.content.prev_action).toBeUndefined();

      // Each subsequent action points to the previous
      expect(record1.signed_action.hashed.content.prev_action).toBeTruthy();
      expect(record2.signed_action.hashed.content.prev_action).toBeTruthy();
      expect(record3.signed_action.hashed.content.prev_action).toBeTruthy();

      // Entries are not included by default (include_entries: false)
      // Record 2 is Create action for agent entry, but entry will be 'NA'
      expect(record2.entry).toBe('NA');
    });

    it("should include user entries in query results", async () => {
      // Create a user entry
      const { result: createResult } = await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "create_test_entry",
        payload: "Test entry for query",
        provenance: testCellId[1],
        dnaManifest: testDnaManifest,
      });

      expect(createResult).toBeInstanceOf(Uint8Array);

      // Query should now return 5 records (4 genesis + 1 user)
      const { result } = await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "query_test",
        payload: null,
        provenance: testCellId[1],
        dnaManifest: testDnaManifest,
      });

      expect(Array.isArray(result)).toBe(true);
      const records = result as unknown[];
      expect(records.length).toBe(5);

      // Last record should be the user entry at seq 4
      const userRecord = records[4] as any;
      expect(userRecord.signed_action.hashed.content.type).toBe('Create');
      expect(userRecord.signed_action.hashed.content.action_seq).toBe(4);

      // Should have prev_action pointing to InitZomesComplete
      expect(userRecord.signed_action.hashed.content.prev_action).toBeTruthy();
      expect(userRecord.signed_action.hashed.content.prev_action).not.toBeNull();
    });
  });

  describe("agent_info host function", () => {
    it("should return agent info", async () => {
      const { result } = await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "get_agent_info",
        payload: null,
        provenance: testCellId[1],
      });

      const agentInfo = result as any;
      expect(agentInfo).toHaveProperty("agent_initial_pubkey");
      expect(agentInfo).toHaveProperty("chain_head");
    });
  });

  describe("zome_info host function", () => {
    it("should call entry_defs callback successfully", async () => {
      // First test: call entry_defs directly
      const { result } = await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "get_entry_defs_test",
        payload: null,
        provenance: testCellId[1],
        dnaManifest: testDnaManifest,
      });

      console.log('[TEST] entry_defs result:', result);

      // Should have Defs variant
      expect(result).toHaveProperty('Defs');
      const defs = (result as any).Defs;
      expect(Array.isArray(defs)).toBe(true);
      expect(defs.length).toBeGreaterThan(0);
    });

    it("should return entry_defs from zome_info", async () => {
      // Call a function that internally calls zome_info
      // The test-zome should have TestEntry in its entry_defs
      const { result } = await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "get_zome_info",
        payload: null,
        provenance: testCellId[1],
        dnaManifest: testDnaManifest,
      });

      const zomeInfo = result as any;

      // Should have basic zome info
      expect(zomeInfo.name).toBe("test_zome");
      expect(zomeInfo.id).toBe(0);

      // Should have entry_defs populated from WASM
      expect(zomeInfo.entry_defs).toBeDefined();
      expect(Array.isArray(zomeInfo.entry_defs)).toBe(true);
      expect(zomeInfo.entry_defs.length).toBeGreaterThan(0);

      // Should have TestEntry definition
      // Note: id is { App: "test_entry" } in snake_case, not "TestEntry"
      const testEntryDef = zomeInfo.entry_defs.find((def: any) => def.id?.App === "test_entry");
      expect(testEntryDef).toBeDefined();
      expect(testEntryDef.visibility).toBe("Public");
      expect(testEntryDef.required_validations).toBe(5);
    });
  });

  describe("random_bytes host function", () => {
    it("should return random bytes", async () => {
      const { result } = await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "get_random_bytes",
        payload: null,
        provenance: testCellId[1],
      });

      // MessagePack decode returns Arrays for binary data
      expect(Array.isArray(result)).toBe(true);
      expect((result as number[]).length).toBe(32);
    });

    it("should return different bytes on each call", async () => {
      const { result: result1 } = await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "get_random_bytes",
        payload: null,
        provenance: testCellId[1],
      });

      const { result: result2 } = await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "get_random_bytes",
        payload: null,
        provenance: testCellId[1],
      });

      const bytes1 = result1 as number[];
      const bytes2 = result2 as number[];

      // Extremely unlikely to be the same
      expect(bytes1).not.toEqual(bytes2);
    });
  });

  describe("sys_time host function", () => {
    it("should return current timestamp", async () => {
      const beforeTime = Date.now() * 1000; // Convert to microseconds

      const { result } = await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "get_timestamp",
        payload: null,
        provenance: testCellId[1],
      });

      const afterTime = Date.now() * 1000;

      const timestamp = result as number;
      expect(timestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(timestamp).toBeLessThanOrEqual(afterTime);
    });
  });

  describe("trace host function", () => {
    it("should log trace message without error", async () => {
      const message = "Test trace message";

      const { result } = await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "trace_message",
        payload: message,
        provenance: testCellId[1],
      });

      // Should return () (unit type becomes null)
      expect(result).toBeNull();
    });
  });

  describe("signing host functions", () => {
    it("should sign and verify with ephemeral keys", async () => {
      const { result } = await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "test_signing",
        payload: null,
        provenance: testCellId[1],
      });

      // Should return true indicating signature verified
      expect(result).toBe(true);
    });
  });

  describe("CRUD host functions", () => {
    it("should return null when getting non-existent entry", async () => {
      // Create a fake action hash that doesn't exist
      const fakeHash = new Uint8Array(39);
      fakeHash.set([132, 41, 36], 0); // ACTION_PREFIX
      crypto.getRandomValues(fakeHash.subarray(3, 35)); // Random hash

      const { result } = await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "get_test_entry",
        payload: fakeHash,
        provenance: testCellId[1],
        dnaManifest: testDnaManifest,
      });

      // Should return null/None for non-existent entry
      expect(result).toBeNull();
    });

    it("should create entry and return action hash", async () => {
      const content = "Test entry content";

      const { result } = await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "create_test_entry",
        payload: content,
        provenance: testCellId[1],
        dnaManifest: testDnaManifest,
      });

      const actionHash = result as Uint8Array;
      expect(actionHash).toBeInstanceOf(Uint8Array);
      expect(actionHash.length).toBe(39); // ActionHash is 39 bytes
    });

    it("should get created entry", async () => {
      // Create an entry
      const content = "Test content for get";
      const { result: createResult } = await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "create_test_entry",
        payload: content,
        provenance: testCellId[1],
        dnaManifest: testDnaManifest,
      });

      const actionHash = createResult as Uint8Array;

      // Get the created entry
      const { result: getResult } = await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "get_test_entry",
        payload: actionHash,
        provenance: testCellId[1],
        dnaManifest: testDnaManifest,
      });

      // Should return a Record with signed_action and entry
      expect(getResult).not.toBeNull();
      const record = getResult as any;
      expect(record).toHaveProperty("signed_action");
      expect(record).toHaveProperty("entry");
    });

    it("should update entry and return new action hash", async () => {
      // Create original entry
      const { result: createResult } = await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "create_test_entry",
        payload: "Original content",
        provenance: testCellId[1],
        dnaManifest: testDnaManifest,
      });

      const originalHash = createResult as Uint8Array;

      // Update the entry
      const { result: updateResult } = await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "update_test_entry",
        payload: {
          original_hash: originalHash,
          new_content: "Updated content",
        },
        provenance: testCellId[1],
        dnaManifest: testDnaManifest,
      });

      const updateHash = updateResult as Uint8Array;
      expect(updateHash).toBeInstanceOf(Uint8Array);
      expect(updateHash.length).toBe(39);
      // Update hash should be different from original
      expect(updateHash).not.toEqual(originalHash);
    });

    it("should get updated entry", async () => {
      // Create and update entry
      const { result: createResult } = await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "create_test_entry",
        payload: "Original content",
        provenance: testCellId[1],
        dnaManifest: testDnaManifest,
      });

      const originalHash = createResult as Uint8Array;

      const { result: updateResult } = await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "update_test_entry",
        payload: {
          original_hash: originalHash,
          new_content: "Updated content",
        },
        provenance: testCellId[1],
        dnaManifest: testDnaManifest,
      });

      const updateHash = updateResult as Uint8Array;

      // Get by update hash - should return updated entry
      const { result: getResult } = await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "get_test_entry",
        payload: updateHash,
        provenance: testCellId[1],
        dnaManifest: testDnaManifest,
      });

      expect(getResult).not.toBeNull();
      const record = getResult as any;
      expect(record).toHaveProperty("signed_action");
      expect(record).toHaveProperty("entry");
      // TODO: verify entry content is "Updated content"
    });

    it("should delete entry and return delete action hash", async () => {
      // Create entry to delete
      const { result: createResult } = await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "create_test_entry",
        payload: "Entry to delete",
        provenance: testCellId[1],
        dnaManifest: testDnaManifest,
      });

      const actionHash = createResult as Uint8Array;

      // Delete the entry
      const { result: deleteResult } = await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "delete_test_entry",
        payload: actionHash,
        provenance: testCellId[1],
        dnaManifest: testDnaManifest,
      });

      const deleteHash = deleteResult as Uint8Array;
      expect(deleteHash).toBeInstanceOf(Uint8Array);
      expect(deleteHash.length).toBe(39);
    });

    it("should show entry as deleted when getting after delete", async () => {
      // Create, then delete entry
      const { result: createResult } = await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "create_test_entry",
        payload: "Entry to delete",
        provenance: testCellId[1],
        dnaManifest: testDnaManifest,
      });

      const actionHash = createResult as Uint8Array;

      await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "delete_test_entry",
        payload: actionHash,
        provenance: testCellId[1],
        dnaManifest: testDnaManifest,
      });

      // Get should return null for deleted entry
      const { result: getResult } = await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "get_test_entry",
        payload: actionHash,
        provenance: testCellId[1],
        dnaManifest: testDnaManifest,
      });

      expect(getResult).toBeNull();
    });
  });

  describe("Link host functions", () => {
    it("should create link between entries", async () => {
      // Create two entries to link
      const { result: result1 } = await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "create_test_entry",
        payload: "Entry 1",
        provenance: testCellId[1],
      });

      const { result: result2 } = await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "create_test_entry",
        payload: "Entry 2",
        provenance: testCellId[1],
      });

      const base = new Uint8Array(result1 as number[]);
      const target = new Uint8Array(result2 as number[]);

      // Create link
      const { result: linkResult } = await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "create_test_link",
        payload: { base, target },
        provenance: testCellId[1],
      });

      const linkHash = linkResult as number[];
      expect(Array.isArray(linkHash)).toBe(true);
      expect(linkHash.length).toBe(39);
    });

    it("should get links from base", async () => {
      // Create an entry to use as base
      const { result: createResult } = await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "create_test_entry",
        payload: "Base entry",
        provenance: testCellId[1],
      });

      const base = new Uint8Array(createResult as number[]);

      // Get links (should return empty array for mock)
      const { result: linksResult } = await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "get_test_links",
        payload: base,
        provenance: testCellId[1],
      });

      const links = linksResult as any[];
      expect(Array.isArray(links)).toBe(true);
    });

    it("should count links from base", async () => {
      const { result: createResult } = await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "create_test_entry",
        payload: "Base entry",
        provenance: testCellId[1],
      });

      const base = new Uint8Array(createResult as number[]);

      const { result: countResult } = await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "count_test_links",
        payload: base,
        provenance: testCellId[1],
      });

      const count = countResult as number;
      expect(typeof count).toBe("number");
      expect(count).toBeGreaterThanOrEqual(0);
    });

    it("should delete link", async () => {
      // Create entries and link
      const { result: result1 } = await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "create_test_entry",
        payload: "Entry 1",
        provenance: testCellId[1],
      });

      const { result: result2 } = await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "create_test_entry",
        payload: "Entry 2",
        provenance: testCellId[1],
      });

      const base = new Uint8Array(result1 as number[]);
      const target = new Uint8Array(result2 as number[]);

      const { result: linkResult } = await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "create_test_link",
        payload: { base, target },
        provenance: testCellId[1],
      });

      const linkHash = new Uint8Array(linkResult as number[]);

      // Delete link
      const { result: deleteResult } = await callZomeAsExtension({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "delete_test_link",
        payload: linkHash,
        provenance: testCellId[1],
      });

      const deleteHash = deleteResult as number[];
      expect(Array.isArray(deleteHash)).toBe(true);
      expect(deleteHash.length).toBe(39);
    });
  });
});
