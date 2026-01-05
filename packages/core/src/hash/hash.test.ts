/**
 * Hash Module Tests
 *
 * Tests that verify our hash functions correctly use @holochain/client library.
 * We don't test the library itself (blakejs, @holochain/client) - only our code.
 */

import { describe, it, expect } from 'vitest';

import {
  blake2b256,
  dhtLocationFrom32,
  assembleHoloHash,
  computeEntryHash,
  computeActionHash,
  ENTRY_HASH_PREFIX,
  ACTION_HASH_PREFIX,
  AGENT_PUBKEY_PREFIX,
  DNA_HASH_PREFIX,
  ActionType,
} from './index';

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
});

describe('dhtLocationFrom32', () => {
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

describe('assembleHoloHash (uses hashFrom32AndType)', () => {
  it('produces 39 bytes total', () => {
    const hash32 = new Uint8Array(32).fill(0xAB);
    const holoHash = assembleHoloHash(hash32, ENTRY_HASH_PREFIX);
    expect(holoHash).toBeInstanceOf(Uint8Array);
    expect(holoHash.length).toBe(39);
  });

  it('uses correct prefix for each hash type', () => {
    const hash32 = new Uint8Array(32).fill(0xAB);

    // EntryHash
    const entryHash = assembleHoloHash(hash32, ENTRY_HASH_PREFIX);
    expect(entryHash.slice(0, 3)).toEqual(new Uint8Array([0x84, 0x21, 0x24]));

    // ActionHash
    const actionHash = assembleHoloHash(hash32, ACTION_HASH_PREFIX);
    expect(actionHash.slice(0, 3)).toEqual(new Uint8Array([0x84, 0x29, 0x24]));

    // AgentPubKey
    const agentHash = assembleHoloHash(hash32, AGENT_PUBKEY_PREFIX);
    expect(agentHash.slice(0, 3)).toEqual(new Uint8Array([0x84, 0x20, 0x24]));

    // DnaHash
    const dnaHash = assembleHoloHash(hash32, DNA_HASH_PREFIX);
    expect(dnaHash.slice(0, 3)).toEqual(new Uint8Array([0x84, 0x2d, 0x24]));
  });

  it('contains the 32-byte hash in bytes 3-34', () => {
    const hash32 = new Uint8Array(32);
    for (let i = 0; i < 32; i++) hash32[i] = i;
    const holoHash = assembleHoloHash(hash32, ENTRY_HASH_PREFIX);
    expect(holoHash.slice(3, 35)).toEqual(hash32);
  });

  it('ends with 4-byte DHT location', () => {
    const hash32 = new Uint8Array(32).fill(0xAB);
    const holoHash = assembleHoloHash(hash32, ENTRY_HASH_PREFIX);
    const location = holoHash.slice(35, 39);
    expect(location.length).toBe(4);
    expect(location).toEqual(dhtLocationFrom32(hash32));
  });
});

describe('computeEntryHash', () => {
  it('produces 39-byte EntryHash with correct prefix', () => {
    const entryContent = new Uint8Array([1, 2, 3, 4, 5]);
    const hash = computeEntryHash(entryContent);
    expect(hash).toBeInstanceOf(Uint8Array);
    expect(hash.length).toBe(39);
    expect(hash.slice(0, 3)).toEqual(ENTRY_HASH_PREFIX);
  });

  it('is deterministic', () => {
    const entryContent = new Uint8Array([1, 2, 3, 4, 5]);
    const hash1 = computeEntryHash(entryContent);
    const hash2 = computeEntryHash(entryContent);
    expect(hash1).toEqual(hash2);
  });

  it('different content produces different hash', () => {
    const content1 = new Uint8Array([1, 2, 3, 4, 5]);
    const content2 = new Uint8Array([5, 4, 3, 2, 1]);
    const hash1 = computeEntryHash(content1);
    const hash2 = computeEntryHash(content2);
    expect(hash1).not.toEqual(hash2);
  });
});

describe('computeActionHash', () => {
  const sampleCreateAction = {
    type: ActionType.Create,
    author: new Uint8Array(39).fill(0xAA),
    timestamp: 1704067200000000n,
    action_seq: 3,
    prev_action: new Uint8Array(39).fill(0xBB),
    entry_type: { App: { zome_index: 0, entry_index: 0, visibility: 'Public' as const } },
    entry_hash: new Uint8Array(39).fill(0xCC),
    weight: { bucket_id: 0, units: 0, rate_bytes: 0 },
  };

  it('produces 39-byte ActionHash with correct prefix', () => {
    const hash = computeActionHash(sampleCreateAction);
    expect(hash).toBeInstanceOf(Uint8Array);
    expect(hash.length).toBe(39);
    expect(hash.slice(0, 3)).toEqual(ACTION_HASH_PREFIX);
  });

  it('is deterministic', () => {
    const hash1 = computeActionHash(sampleCreateAction);
    const hash2 = computeActionHash(sampleCreateAction);
    expect(hash1).toEqual(hash2);
  });

  it('different action_seq produces different hash', () => {
    const action1 = { ...sampleCreateAction, action_seq: 3 };
    const action2 = { ...sampleCreateAction, action_seq: 4 };
    expect(computeActionHash(action1)).not.toEqual(computeActionHash(action2));
  });

  it('different timestamp produces different hash', () => {
    const action1 = { ...sampleCreateAction, timestamp: 1704067200000000n };
    const action2 = { ...sampleCreateAction, timestamp: 1704067200000001n };
    expect(computeActionHash(action1)).not.toEqual(computeActionHash(action2));
  });
});

describe('Re-exported prefixes match @holochain/client', () => {
  // These verify our re-exports are correct
  it('prefixes are correct byte sequences', () => {
    expect(ENTRY_HASH_PREFIX).toEqual(new Uint8Array([0x84, 0x21, 0x24]));
    expect(ACTION_HASH_PREFIX).toEqual(new Uint8Array([0x84, 0x29, 0x24]));
    expect(AGENT_PUBKEY_PREFIX).toEqual(new Uint8Array([0x84, 0x20, 0x24]));
    expect(DNA_HASH_PREFIX).toEqual(new Uint8Array([0x84, 0x2d, 0x24]));
  });
});
