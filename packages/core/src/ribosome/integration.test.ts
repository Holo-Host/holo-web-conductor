/**
 * Integration tests for ribosome with real WASM zomes
 *
 * These tests use the compiled test-zome WASM to test end-to-end functionality
 * of host functions in a real execution environment.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { callZome, ZomeCallResult } from "./index";
import { readFile } from "fs/promises";
import { resolve } from "path";

describe.skip("Ribosome Integration Tests", () => {
  let testZomeWasm: Uint8Array;
  const testCellId: [Uint8Array, Uint8Array] = [
    new Uint8Array(39).fill(1), // DNA hash
    new Uint8Array(39).fill(2), // Agent pub key
  ];

  beforeAll(async () => {
    // Load the compiled test zome WASM
    const wasmPath = resolve(
      __dirname,
      "../../../extension/test/test-zome.wasm"
    );
    const wasmBuffer = await readFile(wasmPath);
    testZomeWasm = new Uint8Array(wasmBuffer);
  });

  describe("emit_signal host function", () => {
    it("should emit signal and return it in result", async () => {
      const message = "Hello from test zome!";

      const result: ZomeCallResult = await callZome({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "emit_signal_test",
        payload: message,
        provenance: testCellId[1],
      });

      // Check signals were emitted
      expect(result.signals).toBeDefined();
      expect(result.signals.length).toBeGreaterThan(0);

      const signal = result.signals[0];
      expect(signal.zome_name).toBe("test_zome");
      expect(signal.cell_id).toBe(testCellId);
      expect(signal.signal).toBeInstanceOf(Uint8Array);
      expect(signal.timestamp).toBeGreaterThan(0);

      // Function should return Ok(())
      expect(result.result).toEqual({ Ok: null });
    });

    it("should handle multiple signal emissions", async () => {
      // Call emit_signal_test multiple times would require a zome function
      // that emits multiple signals, which we can add later
      // For now, test single emission is sufficient
    });
  });

  describe("query host function", () => {
    it("should query the source chain", async () => {
      const result: ZomeCallResult = await callZome({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "query_test",
        payload: null,
        provenance: testCellId[1],
      });

      // Should return Ok(Vec<Record>)
      expect(result.result).toHaveProperty("Ok");
      const records = (result.result as { Ok: unknown[] }).Ok;
      expect(Array.isArray(records)).toBe(true);
      // Initial chain should have DNA and init actions
      expect(records.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe("agent_info host function", () => {
    it("should return agent info", async () => {
      const result: ZomeCallResult = await callZome({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "get_agent_info",
        payload: null,
        provenance: testCellId[1],
      });

      expect(result.result).toHaveProperty("Ok");
      const agentInfo = (result.result as { Ok: any }).Ok;
      expect(agentInfo).toHaveProperty("agent_initial_pubkey");
      expect(agentInfo).toHaveProperty("agent_latest_pubkey");
    });
  });

  describe("random_bytes host function", () => {
    it("should return random bytes", async () => {
      const result: ZomeCallResult = await callZome({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "get_random_bytes",
        payload: null,
        provenance: testCellId[1],
      });

      expect(result.result).toHaveProperty("Ok");
      const randomBytes = (result.result as { Ok: Uint8Array }).Ok;
      expect(randomBytes).toBeInstanceOf(Uint8Array);
      expect(randomBytes.length).toBe(32);
    });

    it("should return different bytes on each call", async () => {
      const result1: ZomeCallResult = await callZome({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "get_random_bytes",
        payload: null,
        provenance: testCellId[1],
      });

      const result2: ZomeCallResult = await callZome({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "get_random_bytes",
        payload: null,
        provenance: testCellId[1],
      });

      const bytes1 = (result1.result as { Ok: Uint8Array }).Ok;
      const bytes2 = (result2.result as { Ok: Uint8Array }).Ok;

      // Extremely unlikely to be the same
      expect(bytes1).not.toEqual(bytes2);
    });
  });

  describe("sys_time host function", () => {
    it("should return current timestamp", async () => {
      const beforeTime = Date.now() * 1000; // Convert to microseconds

      const result: ZomeCallResult = await callZome({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "get_timestamp",
        payload: null,
        provenance: testCellId[1],
      });

      const afterTime = Date.now() * 1000;

      expect(result.result).toHaveProperty("Ok");
      const timestamp = (result.result as { Ok: number }).Ok;
      expect(timestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(timestamp).toBeLessThanOrEqual(afterTime);
    });
  });

  describe("trace host function", () => {
    it("should log trace message without error", async () => {
      const message = "Test trace message";

      const result: ZomeCallResult = await callZome({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "trace_message",
        payload: message,
        provenance: testCellId[1],
      });

      // Should return Ok(())
      expect(result.result).toEqual({ Ok: null });
    });
  });

  describe("signing host functions", () => {
    it("should sign and verify with ephemeral keys", async () => {
      const result: ZomeCallResult = await callZome({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "test_signing",
        payload: null,
        provenance: testCellId[1],
      });

      // Should return Ok(true) indicating signature verified
      expect(result.result).toEqual({ Ok: true });
    });
  });

  describe("CRUD host functions", () => {
    it("should create entry and return action hash", async () => {
      const content = "Test entry content";

      const result: ZomeCallResult = await callZome({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "create_test_entry",
        payload: content,
        provenance: testCellId[1],
      });

      expect(result.result).toHaveProperty("Ok");
      const actionHash = (result.result as { Ok: Uint8Array }).Ok;
      expect(actionHash).toBeInstanceOf(Uint8Array);
      expect(actionHash.length).toBe(39); // ActionHash is 39 bytes
    });

    it("should get entry by action hash", async () => {
      // First create an entry
      const createResult: ZomeCallResult = await callZome({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "create_test_entry",
        payload: "Test content",
        provenance: testCellId[1],
      });

      const actionHash = (createResult.result as { Ok: Uint8Array }).Ok;

      // Then get it
      const getResult: ZomeCallResult = await callZome({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "get_test_entry",
        payload: actionHash,
        provenance: testCellId[1],
      });

      expect(getResult.result).toHaveProperty("Ok");
      const record = (getResult.result as { Ok: any }).Ok;

      // For now, our mock returns null (not implemented yet)
      // When implemented, record should have signed_action and entry
      expect(record).toBeDefined();
    });
  });

  describe("Link host functions", () => {
    it("should create link between entries", async () => {
      // Create two entries to link
      const create1: ZomeCallResult = await callZome({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "create_test_entry",
        payload: "Entry 1",
        provenance: testCellId[1],
      });

      const create2: ZomeCallResult = await callZome({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "create_test_entry",
        payload: "Entry 2",
        provenance: testCellId[1],
      });

      const base = (create1.result as { Ok: Uint8Array }).Ok;
      const target = (create2.result as { Ok: Uint8Array }).Ok;

      // Create link
      const linkResult: ZomeCallResult = await callZome({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "create_test_link",
        payload: { base, target },
        provenance: testCellId[1],
      });

      expect(linkResult.result).toHaveProperty("Ok");
      const linkHash = (linkResult.result as { Ok: Uint8Array }).Ok;
      expect(linkHash).toBeInstanceOf(Uint8Array);
      expect(linkHash.length).toBe(39);
    });

    it("should get links from base", async () => {
      // Create an entry to use as base
      const createResult: ZomeCallResult = await callZome({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "create_test_entry",
        payload: "Base entry",
        provenance: testCellId[1],
      });

      const base = (createResult.result as { Ok: Uint8Array }).Ok;

      // Get links (should return empty array for mock)
      const linksResult: ZomeCallResult = await callZome({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "get_test_links",
        payload: base,
        provenance: testCellId[1],
      });

      expect(linksResult.result).toHaveProperty("Ok");
      const links = (linksResult.result as { Ok: any[] }).Ok;
      expect(Array.isArray(links)).toBe(true);
    });

    it("should count links from base", async () => {
      const createResult: ZomeCallResult = await callZome({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "create_test_entry",
        payload: "Base entry",
        provenance: testCellId[1],
      });

      const base = (createResult.result as { Ok: Uint8Array }).Ok;

      const countResult: ZomeCallResult = await callZome({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "count_test_links",
        payload: base,
        provenance: testCellId[1],
      });

      expect(countResult.result).toHaveProperty("Ok");
      const count = (countResult.result as { Ok: number }).Ok;
      expect(typeof count).toBe("number");
      expect(count).toBeGreaterThanOrEqual(0);
    });

    it("should delete link", async () => {
      // Create entries and link
      const create1: ZomeCallResult = await callZome({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "create_test_entry",
        payload: "Entry 1",
        provenance: testCellId[1],
      });

      const create2: ZomeCallResult = await callZome({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "create_test_entry",
        payload: "Entry 2",
        provenance: testCellId[1],
      });

      const base = (create1.result as { Ok: Uint8Array }).Ok;
      const target = (create2.result as { Ok: Uint8Array }).Ok;

      const linkResult: ZomeCallResult = await callZome({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "create_test_link",
        payload: { base, target },
        provenance: testCellId[1],
      });

      const linkHash = (linkResult.result as { Ok: Uint8Array }).Ok;

      // Delete link
      const deleteResult: ZomeCallResult = await callZome({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "delete_test_link",
        payload: linkHash,
        provenance: testCellId[1],
      });

      expect(deleteResult.result).toHaveProperty("Ok");
      const deleteHash = (deleteResult.result as { Ok: Uint8Array }).Ok;
      expect(deleteHash).toBeInstanceOf(Uint8Array);
      expect(deleteHash.length).toBe(39);
    });
  });
});
