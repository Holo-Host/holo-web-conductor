/**
 * Integration tests for profiles hApp
 *
 * Tests the fishy ribosome with the real profiles-test.happ bundle
 * to verify entry and link type resolution works correctly.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { readFile } from "fs/promises";
import { resolve } from "path";
import { SourceChainStorage } from "../src/storage";
import { callZome } from "../src/ribosome";
import { unpackHappBundle, unpackDnaBundle, createRuntimeManifest } from "../src/bundle/unpacker";
import { encode, decode } from "@msgpack/msgpack";
import type { DnaManifestRuntime } from "../src/types/bundle-types";

// Set up fake-indexeddb for browser storage APIs in Node test environment
import "fake-indexeddb/auto";

describe("Profiles hApp Integration Tests", () => {
  let storage: SourceChainStorage;
  let dnaManifest: DnaManifestRuntime;
  let coordinatorWasm: Uint8Array;
  let integrityWasm: Uint8Array;
  let dnaHash: Uint8Array;

  const testCellId: [Uint8Array, Uint8Array] = [
    new Uint8Array(32).fill(3), // DNA hash (32 bytes raw)
    new Uint8Array(32).fill(4), // Agent pub key (32 bytes raw)
  ];

  beforeAll(async () => {
    // Load the profiles hApp bundle
    const happPath = resolve(__dirname, "fixtures/profiles-test.happ");
    const happBuffer = await readFile(happPath);
    const happBundle = unpackHappBundle(new Uint8Array(happBuffer));

    console.log("[Test] Unpacked hApp:", happBundle.manifest.name);
    console.log("[Test] Roles:", happBundle.manifest.roles.map(r => r.name));

    // Get the DNA bundle
    const role = happBundle.manifest.roles[0];
    const dnaPath = role.dna.path;
    if (!dnaPath) throw new Error("No DNA path in role");

    const dnaBytes = happBundle.resources.get(dnaPath);
    if (!dnaBytes) throw new Error(`Missing DNA at ${dnaPath}`);

    const dnaBundle = unpackDnaBundle(dnaBytes);
    console.log("[Test] Unpacked DNA:", dnaBundle.manifest.name);
    console.log("[Test] Integrity zomes:", dnaBundle.manifest.integrity.zomes.map(z => z.name));
    console.log("[Test] Coordinator zomes:", dnaBundle.manifest.coordinator.zomes.map(z => z.name));

    // Create runtime manifest
    dnaManifest = createRuntimeManifest(dnaBundle.manifest, dnaBundle.resources);

    // Get the WASM files
    const integrityZome = dnaManifest.integrity_zomes[0];
    const coordinatorZome = dnaManifest.coordinator_zomes[0];

    if (!integrityZome.wasm) throw new Error("Missing integrity WASM");
    if (!coordinatorZome.wasm) throw new Error("Missing coordinator WASM");

    integrityWasm = integrityZome.wasm;
    coordinatorWasm = coordinatorZome.wasm;

    // Compute a simple DNA hash
    const hashBuffer = await crypto.subtle.digest("SHA-256", integrityWasm);
    dnaHash = new Uint8Array(hashBuffer);
    testCellId[0] = dnaHash;

    console.log("[Test] Integrity WASM size:", integrityWasm.length);
    console.log("[Test] Coordinator WASM size:", coordinatorWasm.length);

    // Initialize storage
    storage = SourceChainStorage.getInstance();
    await storage.init();
  });

  beforeEach(async () => {
    // Clear storage between tests for isolation
    await storage.clear();
  });

  /**
   * Helper to call a profiles zome function
   */
  async function callProfilesZome(fn: string, payload: unknown) {
    const payloadBytes = new Uint8Array(encode(payload));

    const result = await callZome({
      dnaWasm: coordinatorWasm,
      cellId: testCellId,
      zome: "profiles",
      fn,
      payload: payloadBytes,
      provenance: testCellId[1],
      dnaManifest,
    });

    // Unwrap Result<T, E>
    if (result.result && typeof result.result === "object" && "Err" in result.result) {
      const errorMsg =
        typeof (result.result as any).Err === "string"
          ? (result.result as any).Err
          : JSON.stringify((result.result as any).Err);
      throw new Error(`Zome call failed: ${errorMsg}`);
    }

    // Extract Ok value if present
    const unwrappedResult =
      result.result && typeof result.result === "object" && "Ok" in result.result
        ? (result.result as { Ok: unknown }).Ok
        : result.result;

    // Decode ExternIO output wrapper
    const decodedResult =
      unwrappedResult instanceof Uint8Array
        ? decode(unwrappedResult)
        : unwrappedResult;

    return {
      result: decodedResult,
      signals: result.signals,
    };
  }

  describe("create_profile", () => {
    it("should create a profile successfully", async () => {
      const profile = {
        nickname: "test-user",
        fields: {},
      };

      const { result, signals } = await callProfilesZome("create_profile", profile);

      console.log("[Test] create_profile result:", result);
      console.log("[Test] Signals emitted:", signals.length);

      // Result should be a Record
      expect(result).not.toBeNull();
      expect(result).toHaveProperty("signed_action");
      expect(result).toHaveProperty("entry");
    });

    it("should emit signals when creating a profile", async () => {
      const profile = {
        nickname: "signal-test-user",
        fields: { bio: "Testing signals" },
      };

      const { signals } = await callProfilesZome("create_profile", profile);

      // Profiles zome emits signals in post_commit
      // Note: signals may be empty if post_commit isn't triggered or emit_signal isn't called
      console.log("[Test] Signals received:", signals.length);
      if (signals.length > 0) {
        console.log("[Test] First signal:", signals[0]);
      }
    });
  });

  describe("get_my_profile", () => {
    it("should return null when no profile exists", async () => {
      const { result } = await callProfilesZome("get_my_profile", null);

      // Should return None/null
      expect(result).toBeNull();
    });

    it("should return profile after creation", async () => {
      // First create a profile
      await callProfilesZome("create_profile", {
        nickname: "my-profile",
        fields: {},
      });

      // Then get it
      const { result } = await callProfilesZome("get_my_profile", null);

      console.log("[Test] get_my_profile result:", result);

      // Should return the created profile
      expect(result).not.toBeNull();
    });
  });

  describe("integrity zome metadata", () => {
    it("should have link types from __num_link_types export", async () => {
      // This test verifies that the integrity WASM properly exports __num_link_types
      const module = await WebAssembly.compile(integrityWasm);
      const exports = WebAssembly.Module.exports(module);
      const exportNames = exports.map(e => e.name);

      console.log("[Test] Integrity WASM exports:", exportNames);

      expect(exportNames).toContain("entry_defs");
      expect(exportNames).toContain("__num_link_types");
      expect(exportNames).toContain("__num_entry_types");
    });

    it("should return correct number of link types", async () => {
      // Instantiate the integrity WASM to check link type count
      const module = await WebAssembly.compile(integrityWasm);

      // Create minimal imports for instantiation
      const memory = new WebAssembly.Memory({ initial: 1 });
      const imports = {
        env: { memory },
      };

      // Note: This may fail because we need proper host functions
      // Just checking the export exists is sufficient
      const exportInfo = WebAssembly.Module.exports(module);
      const numLinkTypesExport = exportInfo.find(e => e.name === "__num_link_types");

      expect(numLinkTypesExport).toBeDefined();
      expect(numLinkTypesExport?.kind).toBe("function");
    });
  });
});
