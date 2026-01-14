/**
 * Hash Module Tests
 *
 * Tests for our hash functions that wrap @holochain/client utilities.
 * We don't test the library itself (blakejs, @holochain/client) - only our code.
 */

import { describe, it, expect } from 'vitest';

import {
  blake2b256,
  computeAppEntryHash,
  computeAgentEntryHash,
  computeActionHashV2,
  computeWasmHash,
  hashFrom32AndType,
  dhtLocationFrom32,
  HASH_TYPE_PREFIX,
  HoloHashType,
} from './index';

import { buildCreateAction } from '../types/holochain-serialization';

describe('blake2b256', () => {
  it('produces 32 bytes output', () => {
    const input = new Uint8Array([1, 2, 3, 4, 5]);
    const hash = blake2b256(input);
    expect(hash).toBeInstanceOf(Uint8Array);
    expect(hash.length).toBe(32);
  });

  it('is deterministic', () => {
    const input = new Uint8Array([1, 2, 3, 4, 5]);
    const hash1 = blake2b256(input);
    const hash2 = blake2b256(input);
    expect(hash1).toEqual(hash2);
  });

  it('produces different hashes for different inputs', () => {
    const hash1 = blake2b256(new Uint8Array([1, 2, 3]));
    const hash2 = blake2b256(new Uint8Array([3, 2, 1]));
    expect(hash1).not.toEqual(hash2);
  });
});

describe('dhtLocationFrom32 (re-exported from @holochain/client)', () => {
  it('produces 4 bytes from 32-byte input', () => {
    const hash32 = new Uint8Array(32).fill(0);
    const location = dhtLocationFrom32(hash32);
    expect(location).toBeInstanceOf(Uint8Array);
    expect(location.length).toBe(4);
  });

  it('is deterministic', () => {
    const hash32 = blake2b256(new Uint8Array([1, 2, 3]));
    const loc1 = dhtLocationFrom32(hash32);
    const loc2 = dhtLocationFrom32(hash32);
    expect(loc1).toEqual(loc2);
  });

  it('different inputs produce different locations', () => {
    const zeros = new Uint8Array(32);
    const ones = new Uint8Array(32).fill(0xFF);
    const locZeros = dhtLocationFrom32(zeros);
    const locOnes = dhtLocationFrom32(ones);
    expect(locZeros).not.toEqual(locOnes);
  });
});

describe('hashFrom32AndType (re-exported from @holochain/client)', () => {
  it('produces 39 bytes total', () => {
    const hash32 = new Uint8Array(32).fill(0xAB);
    const holoHash = hashFrom32AndType(hash32, HoloHashType.Entry);
    expect(holoHash).toBeInstanceOf(Uint8Array);
    expect(holoHash.length).toBe(39);
  });

  it('uses correct prefix for each hash type', () => {
    const hash32 = new Uint8Array(32).fill(0xAB);

    // EntryHash
    const entryHash = hashFrom32AndType(hash32, HoloHashType.Entry);
    expect(entryHash.slice(0, 3)).toEqual(HASH_TYPE_PREFIX[HoloHashType.Entry]);

    // ActionHash
    const actionHash = hashFrom32AndType(hash32, HoloHashType.Action);
    expect(actionHash.slice(0, 3)).toEqual(HASH_TYPE_PREFIX[HoloHashType.Action]);

    // AgentPubKey
    const agentHash = hashFrom32AndType(hash32, HoloHashType.Agent);
    expect(agentHash.slice(0, 3)).toEqual(HASH_TYPE_PREFIX[HoloHashType.Agent]);

    // DnaHash
    const dnaHash = hashFrom32AndType(hash32, HoloHashType.Dna);
    expect(dnaHash.slice(0, 3)).toEqual(HASH_TYPE_PREFIX[HoloHashType.Dna]);
  });

  it('contains the 32-byte hash in bytes 3-34', () => {
    const hash32 = new Uint8Array(32);
    for (let i = 0; i < 32; i++) hash32[i] = i;
    const holoHash = hashFrom32AndType(hash32, HoloHashType.Entry);
    expect(holoHash.slice(3, 35)).toEqual(hash32);
  });

  it('ends with 4-byte DHT location', () => {
    const hash32 = new Uint8Array(32).fill(0xAB);
    const holoHash = hashFrom32AndType(hash32, HoloHashType.Entry);
    const location = holoHash.slice(35, 39);
    expect(location.length).toBe(4);
    // Location should match what dhtLocationFrom32 produces
    expect(location).toEqual(dhtLocationFrom32(hash32));
  });
});

describe('computeAppEntryHash', () => {
  it('produces 39-byte EntryHash with correct prefix', () => {
    const entryContent = new Uint8Array([1, 2, 3, 4, 5]);
    const hash = computeAppEntryHash(entryContent);
    expect(hash).toBeInstanceOf(Uint8Array);
    expect(hash.length).toBe(39);
    expect(hash.slice(0, 3)).toEqual(HASH_TYPE_PREFIX[HoloHashType.Entry]);
  });

  it('is deterministic', () => {
    const entryContent = new Uint8Array([1, 2, 3, 4, 5]);
    const hash1 = computeAppEntryHash(entryContent);
    const hash2 = computeAppEntryHash(entryContent);
    expect(hash1).toEqual(hash2);
  });

  it('different content produces different hash', () => {
    const content1 = new Uint8Array([1, 2, 3, 4, 5]);
    const content2 = new Uint8Array([5, 4, 3, 2, 1]);
    const hash1 = computeAppEntryHash(content1);
    const hash2 = computeAppEntryHash(content2);
    expect(hash1).not.toEqual(hash2);
  });
});

describe('computeAgentEntryHash', () => {
  it('produces 39-byte EntryHash with Entry prefix', () => {
    // Create a valid 39-byte AgentPubKey
    const agentPubKey = new Uint8Array(39);
    agentPubKey.set(HASH_TYPE_PREFIX[HoloHashType.Agent], 0);
    agentPubKey.fill(0xAA, 3, 35); // 32-byte core
    agentPubKey.set(dhtLocationFrom32(agentPubKey.slice(3, 35)), 35);

    const hash = computeAgentEntryHash(agentPubKey);
    expect(hash).toBeInstanceOf(Uint8Array);
    expect(hash.length).toBe(39);
    expect(hash.slice(0, 3)).toEqual(HASH_TYPE_PREFIX[HoloHashType.Entry]);
  });

  it('preserves the 32-byte core from AgentPubKey', () => {
    const agentPubKey = new Uint8Array(39);
    agentPubKey.set(HASH_TYPE_PREFIX[HoloHashType.Agent], 0);
    for (let i = 0; i < 32; i++) agentPubKey[3 + i] = i; // Unique core bytes
    agentPubKey.set(dhtLocationFrom32(agentPubKey.slice(3, 35)), 35);

    const hash = computeAgentEntryHash(agentPubKey);
    // The 32-byte core should be the same
    expect(hash.slice(3, 35)).toEqual(agentPubKey.slice(3, 35));
  });

  it('throws for invalid input length', () => {
    expect(() => computeAgentEntryHash(new Uint8Array(32))).toThrow();
    expect(() => computeAgentEntryHash(new Uint8Array(40))).toThrow();
  });
});

describe('computeActionHashV2', () => {
  const makeTestAgentPubKey = () => {
    const key = new Uint8Array(39);
    key.set(HASH_TYPE_PREFIX[HoloHashType.Agent], 0);
    key.fill(0xAA, 3, 35);
    key.set(dhtLocationFrom32(key.slice(3, 35)), 35);
    return key;
  };

  const makeTestEntryHash = () => {
    const hash = new Uint8Array(39);
    hash.set(HASH_TYPE_PREFIX[HoloHashType.Entry], 0);
    hash.fill(0xCC, 3, 35);
    hash.set(dhtLocationFrom32(hash.slice(3, 35)), 35);
    return hash;
  };

  const makeTestActionHash = () => {
    const hash = new Uint8Array(39);
    hash.set(HASH_TYPE_PREFIX[HoloHashType.Action], 0);
    hash.fill(0xBB, 3, 35);
    hash.set(dhtLocationFrom32(hash.slice(3, 35)), 35);
    return hash;
  };

  it('produces 39-byte ActionHash with correct prefix', () => {
    const action = buildCreateAction({
      author: makeTestAgentPubKey(),
      timestamp: 1704067200000000,
      action_seq: 3,
      prev_action: makeTestActionHash(),
      entry_type: { App: { zome_index: 0, entry_index: 0, visibility: 'Public' } },
      entry_hash: makeTestEntryHash(),
      weight: { bucket_id: 0, units: 0, rate_bytes: 0 },
    });

    const hash = computeActionHashV2(action);
    expect(hash).toBeInstanceOf(Uint8Array);
    expect(hash.length).toBe(39);
    expect(hash.slice(0, 3)).toEqual(HASH_TYPE_PREFIX[HoloHashType.Action]);
  });

  it('is deterministic', () => {
    const action = buildCreateAction({
      author: makeTestAgentPubKey(),
      timestamp: 1704067200000000,
      action_seq: 3,
      prev_action: makeTestActionHash(),
      entry_type: { App: { zome_index: 0, entry_index: 0, visibility: 'Public' } },
      entry_hash: makeTestEntryHash(),
      weight: { bucket_id: 0, units: 0, rate_bytes: 0 },
    });

    const hash1 = computeActionHashV2(action);
    const hash2 = computeActionHashV2(action);
    expect(hash1).toEqual(hash2);
  });

  it('different action_seq produces different hash', () => {
    const action1 = buildCreateAction({
      author: makeTestAgentPubKey(),
      timestamp: 1704067200000000,
      action_seq: 3,
      prev_action: makeTestActionHash(),
      entry_type: { App: { zome_index: 0, entry_index: 0, visibility: 'Public' } },
      entry_hash: makeTestEntryHash(),
      weight: { bucket_id: 0, units: 0, rate_bytes: 0 },
    });
    const action2 = buildCreateAction({
      author: makeTestAgentPubKey(),
      timestamp: 1704067200000000,
      action_seq: 4,
      prev_action: makeTestActionHash(),
      entry_type: { App: { zome_index: 0, entry_index: 0, visibility: 'Public' } },
      entry_hash: makeTestEntryHash(),
      weight: { bucket_id: 0, units: 0, rate_bytes: 0 },
    });

    expect(computeActionHashV2(action1)).not.toEqual(computeActionHashV2(action2));
  });

  it('different timestamp produces different hash', () => {
    const action1 = buildCreateAction({
      author: makeTestAgentPubKey(),
      timestamp: 1704067200000000,
      action_seq: 3,
      prev_action: makeTestActionHash(),
      entry_type: { App: { zome_index: 0, entry_index: 0, visibility: 'Public' } },
      entry_hash: makeTestEntryHash(),
      weight: { bucket_id: 0, units: 0, rate_bytes: 0 },
    });
    const action2 = buildCreateAction({
      author: makeTestAgentPubKey(),
      timestamp: 1704067200000001,
      action_seq: 3,
      prev_action: makeTestActionHash(),
      entry_type: { App: { zome_index: 0, entry_index: 0, visibility: 'Public' } },
      entry_hash: makeTestEntryHash(),
      weight: { bucket_id: 0, units: 0, rate_bytes: 0 },
    });

    expect(computeActionHashV2(action1)).not.toEqual(computeActionHashV2(action2));
  });
});

describe('computeWasmHash', () => {
  it('produces 39-byte WasmHash with correct prefix', () => {
    const wasmBytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d]); // WASM magic
    const hash = computeWasmHash(wasmBytes);
    expect(hash).toBeInstanceOf(Uint8Array);
    expect(hash.length).toBe(39);
    expect(hash.slice(0, 3)).toEqual(HASH_TYPE_PREFIX[HoloHashType.Wasm]);
  });

  it('is deterministic', () => {
    const wasmBytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d]);
    const hash1 = computeWasmHash(wasmBytes);
    const hash2 = computeWasmHash(wasmBytes);
    expect(hash1).toEqual(hash2);
  });

  it('different content produces different hash', () => {
    const wasm1 = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01]);
    const wasm2 = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x02]);
    expect(computeWasmHash(wasm1)).not.toEqual(computeWasmHash(wasm2));
  });
});

describe('HASH_TYPE_PREFIX (from @holochain/client)', () => {
  it('contains expected hash types', () => {
    expect(HASH_TYPE_PREFIX[HoloHashType.Entry]).toBeDefined();
    expect(HASH_TYPE_PREFIX[HoloHashType.Action]).toBeDefined();
    expect(HASH_TYPE_PREFIX[HoloHashType.Agent]).toBeDefined();
    expect(HASH_TYPE_PREFIX[HoloHashType.Dna]).toBeDefined();
    expect(HASH_TYPE_PREFIX[HoloHashType.Wasm]).toBeDefined();
  });

  it('each prefix is 3 bytes', () => {
    expect(HASH_TYPE_PREFIX[HoloHashType.Entry].length).toBe(3);
    expect(HASH_TYPE_PREFIX[HoloHashType.Action].length).toBe(3);
    expect(HASH_TYPE_PREFIX[HoloHashType.Agent].length).toBe(3);
    expect(HASH_TYPE_PREFIX[HoloHashType.Dna].length).toBe(3);
    expect(HASH_TYPE_PREFIX[HoloHashType.Wasm].length).toBe(3);
  });
});
