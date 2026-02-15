/**
 * Tests for concurrent zome call serialization (Step 18)
 *
 * Proves that concurrent callZome() invocations interleave at await points
 * and corrupt storage transactions, then proves the promise-chain pattern
 * (same as ribosome-worker.ts) fixes it.
 *
 * Uses SourceChainStorage + fake-indexeddb which has the same concurrency
 * bug as DirectSQLiteStorage: beginTransaction() throws "Transaction already
 * in progress" when two calls interleave.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { encode } from "@msgpack/msgpack";
import { readFile } from "fs/promises";
import { resolve } from "path";
import { SourceChainStorage } from "../storage";
import { setLairClient } from "../signing";
import { callZome, ZomeCallResult } from "./index";
import type { ZomeCallRequest } from "./call-context";
import type { DnaManifestRuntime } from "../types/bundle-types";
import type { LairClient } from "@fishy/lair";

import "fake-indexeddb/auto";

/**
 * Minimal mock Lair client that returns deterministic 64-byte signatures.
 * Tests don't validate signatures, they just need signSync to not throw.
 */
function createMockLairClient(): LairClient {
  return {
    signSync(_pubKey: Uint8Array, data: Uint8Array): Uint8Array {
      const sig = new Uint8Array(64);
      for (let i = 0; i < 64; i++) {
        sig[i] = data[i % data.length] ^ (i & 0xff);
      }
      return sig;
    },
    async generateSigningKeypair() { return new Uint8Array(32); },
    async signByPubKey(_pk: Uint8Array, data: Uint8Array) { return this.signSync(_pk, data); },
    async preloadKeyForSync() {},
    hasPreloadedKey() { return true; },
    async listEntries() { return []; },
    async importSeed() { return new Uint8Array(32); },
    async exportSeed() { return new Uint8Array(32); },
    async close() {},
  } as unknown as LairClient;
}

/**
 * Call callZome with msgpack-encoded payload, matching the worker's call path.
 * Returns the raw ZomeCallResult without double-decoding.
 */
async function invokeZome(
  request: Omit<ZomeCallRequest, "payload"> & { payload: unknown }
): Promise<ZomeCallResult> {
  const payloadBytes = new Uint8Array(encode(request.payload));
  return callZome({ ...request, payload: payloadBytes });
}

describe("Concurrent Zome Call Serialization", () => {
  let testZomeWasm: Uint8Array;
  let storage: SourceChainStorage;
  const testCellId: [Uint8Array, Uint8Array] = [
    new Uint8Array(32).fill(1),
    new Uint8Array(32).fill(2),
  ];

  const testDnaManifest: DnaManifestRuntime = {
    name: "test-dna",
    network_seed: "00000000-0000-0000-0000-000000000000",
    properties: {},
    integrity_zomes: [
      {
        name: "test_zome",
        index: 0,
        wasm: undefined,
        dependencies: [],
      },
    ],
    coordinator_zomes: [],
  };

  function createEntryRequest(content: string) {
    return {
      dnaWasm: testZomeWasm,
      cellId: testCellId,
      zome: "test_zome",
      fn: "create_test_entry",
      payload: content,
      provenance: testCellId[1],
      dnaManifest: testDnaManifest,
    };
  }

  async function getChainSeq(): Promise<number> {
    const { result } = await invokeZome({
      dnaWasm: testZomeWasm,
      cellId: testCellId,
      zome: "test_zome",
      fn: "get_agent_info",
      payload: null,
      provenance: testCellId[1],
      dnaManifest: testDnaManifest,
    });
    return (result as any).chain_head[1];
  }

  /**
   * Promise-chain serializer — same pattern as ribosome-worker.ts handleCallZome.
   * Each call chains onto the previous, ensuring only one runs at a time.
   */
  function createSerializer() {
    let chain: Promise<void> = Promise.resolve();

    return function serializedInvokeZome(
      request: Omit<ZomeCallRequest, "payload"> & { payload: unknown }
    ): Promise<ZomeCallResult> {
      const callPromise = chain.then(() => invokeZome(request));
      chain = callPromise.then(() => {}, () => {}); // swallow errors so chain continues
      return callPromise;
    };
  }

  beforeAll(async () => {
    const wasmPath = resolve(
      __dirname,
      "../../../extension/test/test-zome.wasm"
    );
    const wasmBuffer = await readFile(wasmPath);
    testZomeWasm = new Uint8Array(wasmBuffer);
    testDnaManifest.integrity_zomes[0].wasm = testZomeWasm;

    setLairClient(createMockLairClient());

    storage = SourceChainStorage.getInstance();
    await storage.init();
  });

  beforeEach(async () => {
    await storage.clear();
  });

  it("concurrent callZome without serialization fails with transaction error", async () => {
    // First call to trigger genesis so both subsequent calls hit the real conflict
    await invokeZome(createEntryRequest("warmup"));

    // Launch two calls concurrently — one will fail because beginTransaction()
    // throws when the other call's transaction is still active.
    const results = await Promise.allSettled([
      invokeZome(createEntryRequest("concurrent-A")),
      invokeZome(createEntryRequest("concurrent-B")),
    ]);

    const failures = results.filter((r) => r.status === "rejected");
    expect(failures.length).toBeGreaterThanOrEqual(1);

    // The error should be about transaction conflict
    const error = (failures[0] as PromiseRejectedResult).reason;
    expect(error.message).toMatch(/[Tt]ransaction already in progress/);
  });

  it("concurrent callZome with serialization both succeed", async () => {
    const serializedInvokeZome = createSerializer();

    // Warmup / genesis
    await serializedInvokeZome(createEntryRequest("warmup"));

    // Launch two calls concurrently through the serializer
    const [resultA, resultB] = await Promise.all([
      serializedInvokeZome(createEntryRequest("serialized-A")),
      serializedInvokeZome(createEntryRequest("serialized-B")),
    ]);

    // Both should return a result (callZome already unwraps Ok and decodes ExternIO)
    expect(resultA.result).toBeDefined();
    expect(resultB.result).toBeDefined();

    // create_test_entry returns ActionHash — a 39-byte Uint8Array after ExternIO decode
    expect(resultA.result).toBeInstanceOf(Uint8Array);
    expect(resultB.result).toBeInstanceOf(Uint8Array);
    expect((resultA.result as Uint8Array).length).toBe(39);
    expect((resultB.result as Uint8Array).length).toBe(39);
  });

  it("chain head advances correctly after serialized concurrent creates", async () => {
    const serializedInvokeZome = createSerializer();

    // Genesis + warmup
    await serializedInvokeZome(createEntryRequest("warmup"));
    const seqBefore = await getChainSeq();

    // Two concurrent creates through serializer
    await Promise.all([
      serializedInvokeZome(createEntryRequest("chain-check-A")),
      serializedInvokeZome(createEntryRequest("chain-check-B")),
    ]);

    const seqAfter = await getChainSeq();

    // Each create_test_entry adds 1 action, so seq should advance by 2
    expect(seqAfter).toBe(seqBefore + 2);
  });

  it("a failing call does not block the next queued call", async () => {
    const serializedInvokeZome = createSerializer();

    // Genesis
    await serializedInvokeZome(createEntryRequest("warmup"));

    // Queue a bad call followed by a good call
    const [badResult, goodResult] = await Promise.allSettled([
      serializedInvokeZome({
        dnaWasm: testZomeWasm,
        cellId: testCellId,
        zome: "test_zome",
        fn: "nonexistent_function",
        payload: null,
        provenance: testCellId[1],
        dnaManifest: testDnaManifest,
      }),
      serializedInvokeZome(createEntryRequest("after-failure")),
    ]);

    // Bad call should fail
    expect(badResult.status).toBe("rejected");

    // Good call should succeed despite the preceding failure
    expect(goodResult.status).toBe("fulfilled");
    if (goodResult.status === "fulfilled") {
      expect(goodResult.value.result).toBeInstanceOf(Uint8Array);
      expect((goodResult.value.result as Uint8Array).length).toBe(39);
    }
  });

  it("many concurrent calls all serialize correctly", async () => {
    const serializedInvokeZome = createSerializer();

    // Genesis
    await serializedInvokeZome(createEntryRequest("warmup"));
    const seqBefore = await getChainSeq();

    // Launch 5 concurrent calls
    const count = 5;
    const results = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        serializedInvokeZome(createEntryRequest(`stress-${i}`))
      )
    );

    // All should succeed with valid hashes
    for (const r of results) {
      expect(r.result).toBeInstanceOf(Uint8Array);
      expect((r.result as Uint8Array).length).toBe(39);
    }

    // All hashes should be distinct
    const hashStrings = results.map((r) =>
      Array.from(r.result as Uint8Array).join(",")
    );
    const unique = new Set(hashStrings);
    expect(unique.size).toBe(count);

    // Chain should advance by exactly `count`
    const seqAfter = await getChainSeq();
    expect(seqAfter).toBe(seqBefore + count);
  });
});
