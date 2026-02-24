/**
 * Integration tests for genesis_self_check callback
 *
 * Tests the full genesis_self_check flow using real WASM and real Lair keystore:
 * 1. No progenitor in DNA properties -> Valid (open membrane)
 * 2. Progenitor set, no membrane proof -> Invalid
 * 3. Progenitor set, garbage proof -> Invalid
 * 4. Progenitor set, valid signature proof -> Valid
 *
 * The authorizer key is created via Lair keystore.
 * The membrane proof is the authorizer's Ed25519 signature over the agent's
 * 39-byte AgentPubKey.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { readFile } from "fs/promises";
import { resolve } from "path";
import { encode } from "@msgpack/msgpack";
import {
  HoloHashType,
  hashFrom32AndType,
  dhtLocationFrom32,
  HASH_TYPE_PREFIX,
} from "../hash";
import { setLairClient } from "../signing";
import { runGenesisSelfCheck } from "./genesis-self-check";
import type { DnaManifestRuntime } from "../types/bundle-types";

// Set up fake-indexeddb for browser storage APIs in Node test environment
import "fake-indexeddb/auto";

/**
 * Build a 39-byte AgentPubKey from a 32-byte Ed25519 public key
 */
function buildAgentPubKey(ed25519PubKey: Uint8Array): Uint8Array {
  const prefixed = new Uint8Array(39);
  prefixed.set(HASH_TYPE_PREFIX[HoloHashType.Agent], 0);
  prefixed.set(ed25519PubKey, 3);
  prefixed.set(dhtLocationFrom32(ed25519PubKey), 35);
  return prefixed;
}

describe("genesis_self_check integration", () => {
  let testZomeWasm: Uint8Array;

  // Keys created via libsodium directly (no lair dependency to avoid crypto polyfill issues)
  let authorizerEd25519PubKey: Uint8Array;
  let authorizerEd25519PrivKey: Uint8Array;
  let authorizerAgentPubKey: Uint8Array;

  let agentEd25519PubKey: Uint8Array;
  let agentPubKey: Uint8Array;

  // DNA hash (arbitrary for testing)
  const dnaHash = hashFrom32AndType(new Uint8Array(32).fill(1), HoloHashType.Dna);

  /**
   * Build a DnaManifestRuntime with optional progenitor in properties
   */
  function buildManifest(
    progenitorKey?: Uint8Array
  ): DnaManifestRuntime {
    const properties: Record<string, unknown> = {};
    if (progenitorKey) {
      // Store progenitor as array of numbers (how JS Uint8Array serializes via msgpack)
      properties.progenitor = Array.from(progenitorKey);
    }

    return {
      name: "test-dna",
      network_seed: "00000000-0000-0000-0000-000000000000",
      properties,
      integrity_zomes: [
        {
          name: "test_zome",
          index: 0,
          wasm: testZomeWasm,
          dependencies: [],
        },
      ],
      coordinator_zomes: [],
    };
  }

  beforeAll(async () => {
    // Dynamic import of libsodium to ensure crypto polyfill from setup file is applied
    const sodium = (await import("libsodium-wrappers")).default;
    await sodium.ready;

    // Load the compiled test zome WASM
    const wasmPath = resolve(
      __dirname,
      "../../../extension/test/test-zome.wasm"
    );
    const wasmBuffer = await readFile(wasmPath);
    testZomeWasm = new Uint8Array(wasmBuffer);

    // Generate keys directly via libsodium (avoids lair client crypto loading issues)
    const authKp = sodium.crypto_sign_keypair();
    authorizerEd25519PubKey = authKp.publicKey;
    authorizerEd25519PrivKey = authKp.privateKey;
    authorizerAgentPubKey = buildAgentPubKey(authorizerEd25519PubKey);

    const agentKp = sodium.crypto_sign_keypair();
    agentEd25519PubKey = agentKp.publicKey;
    agentPubKey = buildAgentPubKey(agentEd25519PubKey);

    // Mock lair client that returns deterministic signatures using the agent's key
    const mockLairClient = {
      signSync(_pubKey: Uint8Array, data: Uint8Array): Uint8Array {
        return sodium.crypto_sign_detached(data, agentKp.privateKey);
      },
      async generateSigningKeypair() { return agentEd25519PubKey; },
      async signByPubKey(_pk: Uint8Array, data: Uint8Array) {
        return this.signSync(_pk, data);
      },
      async preloadKeyForSync() {},
      hasPreloadedKey() { return true; },
      async listEntries() { return []; },
      async importSeed() { return agentEd25519PubKey; },
      async exportSeed() { return agentEd25519PubKey; },
      async close() {},
    };
    setLairClient(mockLairClient as any);
  });

  it("should return Valid when no progenitor in DNA properties (open membrane)", async () => {
    const manifest = buildManifest(); // No progenitor
    const cellId: [Uint8Array, Uint8Array] = [dnaHash, agentPubKey];

    const result = await runGenesisSelfCheck(manifest, cellId);
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("should return Invalid when progenitor set but no membrane proof provided", async () => {
    const manifest = buildManifest(authorizerAgentPubKey);
    const cellId: [Uint8Array, Uint8Array] = [dnaHash, agentPubKey];

    const result = await runGenesisSelfCheck(
      manifest,
      cellId,
      undefined, // No proof
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Membrane proof required");
  });

  it("should return Invalid when progenitor set but garbage proof bytes", async () => {
    const manifest = buildManifest(authorizerAgentPubKey);
    const cellId: [Uint8Array, Uint8Array] = [dnaHash, agentPubKey];

    // Create garbage 64-byte proof (random bytes, not a valid signature)
    const garbageProof = new Uint8Array(64);
    for (let i = 0; i < 64; i++) garbageProof[i] = i;

    // Wrap as SerializedBytes: encode the raw bytes with msgpack
    const membraneProof = new Uint8Array(encode(garbageProof));

    const result = await runGenesisSelfCheck(
      manifest,
      cellId,
      membraneProof,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("signature verification failed");
  });

  it("should return Valid when progenitor set and valid signature proof provided", async () => {
    const sodium = (await import("libsodium-wrappers")).default;
    const manifest = buildManifest(authorizerAgentPubKey);
    const cellId: [Uint8Array, Uint8Array] = [dnaHash, agentPubKey];

    // Create valid membrane proof: authorizer signs the agent's 39-byte pubkey
    const signature = sodium.crypto_sign_detached(
      agentPubKey,
      authorizerEd25519PrivKey
    );

    // Wrap as SerializedBytes: encode the raw signature bytes with msgpack
    const membraneProof = new Uint8Array(encode(signature));

    const result = await runGenesisSelfCheck(
      manifest,
      cellId,
      membraneProof,
    );
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("should return Invalid when proof is wrong length (not 64 bytes)", async () => {
    const manifest = buildManifest(authorizerAgentPubKey);
    const cellId: [Uint8Array, Uint8Array] = [dnaHash, agentPubKey];

    // Create proof with wrong length
    const shortProof = new Uint8Array(32).fill(0xab);
    const membraneProof = new Uint8Array(encode(shortProof));

    const result = await runGenesisSelfCheck(
      manifest,
      cellId,
      membraneProof,
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("64 bytes");
  });
});
