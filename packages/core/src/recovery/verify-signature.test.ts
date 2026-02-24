/**
 * Tests for signature verification of recovered chain actions.
 *
 * Uses real Ed25519 keypairs (via libsodium) to verify that
 * verifyActionSignature correctly validates signatures produced
 * by serializeAction + crypto_sign_detached.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import sodium from 'libsodium-wrappers';
import {
  verifyActionSignature,
  storeRecoveredRecords,
  type RecoveredRecord,
} from './chain-recovery';
import { serializeAction, type SerializableAction } from '../types/holochain-serialization';
import { HoloHashType, hashFrom32AndType } from '../hash';
import type { StorageProvider } from '../storage/storage-provider';
import type { SignedActionHashed } from '../types/holochain-types';

// ============================================================================
// Setup
// ============================================================================

let keyPair: sodium.KeyPair;
let agentPubKey: Uint8Array;

beforeAll(async () => {
  await sodium.ready;
  keyPair = sodium.crypto_sign_keypair();
  // Wrap the 32-byte public key as a 39-byte AgentPubKey
  agentPubKey = hashFrom32AndType(keyPair.publicKey, HoloHashType.Agent);
});

// ============================================================================
// Helpers
// ============================================================================

function mockHash(type: HoloHashType, seed: number): Uint8Array {
  const core = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    core[i] = (i * 17 + seed) % 256;
  }
  return hashFrom32AndType(core, type);
}

/**
 * Build a RecoveredRecord with a real signature.
 * Signs the action content using the test keypair.
 */
function signedRecord(action: SerializableAction, actionHash?: Uint8Array): RecoveredRecord {
  const serializedBytes = serializeAction(action);
  const signature = sodium.crypto_sign_detached(serializedBytes, keyPair.privateKey);
  const hash = actionHash ?? mockHash(HoloHashType.Action, 42);
  const seq = 'action_seq' in action ? (action.action_seq ?? 0) : 0;
  const ts = action.timestamp ?? 0;

  return {
    actionHash: hash,
    // SerializableAction is structurally compatible with Action at runtime
    // (same field names), but uses different TS types (string vs ActionType enum).
    signedAction: {
      hashed: {
        hash,
        content: action,
      },
      signature,
    } as unknown as SignedActionHashed,
    entry: null,
    actionSeq: seq,
    timestamp: BigInt(ts),
  };
}

// ============================================================================
// verifyActionSignature tests
// ============================================================================

describe('verifyActionSignature', () => {
  it('verifies a correctly signed Dna action', () => {
    const action: SerializableAction = {
      type: 'Dna',
      author: agentPubKey,
      timestamp: 1000000,
      hash: mockHash(HoloHashType.Dna, 1),
    };
    const record = signedRecord(action);
    expect(verifyActionSignature(record)).toBe(true);
  });

  it('verifies a correctly signed Create action', () => {
    const action: SerializableAction = {
      type: 'Create',
      author: agentPubKey,
      timestamp: 2000000,
      action_seq: 3,
      prev_action: mockHash(HoloHashType.Action, 10),
      entry_type: { App: { entry_index: 0, zome_index: 0, visibility: 'Public' } },
      entry_hash: mockHash(HoloHashType.Entry, 20),
      weight: { bucket_id: 0, units: 0, rate_bytes: 0 },
    };
    const record = signedRecord(action);
    expect(verifyActionSignature(record)).toBe(true);
  });

  it('verifies a correctly signed Update action', () => {
    const action: SerializableAction = {
      type: 'Update',
      author: agentPubKey,
      timestamp: 3000000,
      action_seq: 4,
      prev_action: mockHash(HoloHashType.Action, 11),
      original_action_address: mockHash(HoloHashType.Action, 12),
      original_entry_address: mockHash(HoloHashType.Entry, 13),
      entry_type: { App: { entry_index: 0, zome_index: 0, visibility: 'Public' } },
      entry_hash: mockHash(HoloHashType.Entry, 21),
      weight: { bucket_id: 0, units: 0, rate_bytes: 0 },
    };
    const record = signedRecord(action);
    expect(verifyActionSignature(record)).toBe(true);
  });

  it('verifies a correctly signed Delete action', () => {
    const action: SerializableAction = {
      type: 'Delete',
      author: agentPubKey,
      timestamp: 4000000,
      action_seq: 5,
      prev_action: mockHash(HoloHashType.Action, 14),
      deletes_address: mockHash(HoloHashType.Action, 15),
      deletes_entry_address: mockHash(HoloHashType.Entry, 16),
      weight: { bucket_id: 0, units: 0 },
    };
    const record = signedRecord(action);
    expect(verifyActionSignature(record)).toBe(true);
  });

  it('verifies a correctly signed CreateLink action', () => {
    const action: SerializableAction = {
      type: 'CreateLink',
      author: agentPubKey,
      timestamp: 5000000,
      action_seq: 6,
      prev_action: mockHash(HoloHashType.Action, 17),
      base_address: mockHash(HoloHashType.Entry, 18),
      target_address: mockHash(HoloHashType.Entry, 19),
      zome_index: 0,
      link_type: 3,
      tag: new Uint8Array([0xca, 0xfe]),
      weight: { bucket_id: 0, units: 0 },
    };
    const record = signedRecord(action);
    expect(verifyActionSignature(record)).toBe(true);
  });

  it('verifies a correctly signed DeleteLink action', () => {
    const action: SerializableAction = {
      type: 'DeleteLink',
      author: agentPubKey,
      timestamp: 6000000,
      action_seq: 7,
      prev_action: mockHash(HoloHashType.Action, 20),
      base_address: mockHash(HoloHashType.Entry, 21),
      link_add_address: mockHash(HoloHashType.Action, 22),
    };
    const record = signedRecord(action);
    expect(verifyActionSignature(record)).toBe(true);
  });

  it('verifies a correctly signed AgentValidationPkg action', () => {
    const action: SerializableAction = {
      type: 'AgentValidationPkg',
      author: agentPubKey,
      timestamp: 7000000,
      action_seq: 1,
      prev_action: mockHash(HoloHashType.Action, 23),
    };
    const record = signedRecord(action);
    expect(verifyActionSignature(record)).toBe(true);
  });

  it('verifies a correctly signed InitZomesComplete action', () => {
    const action: SerializableAction = {
      type: 'InitZomesComplete',
      author: agentPubKey,
      timestamp: 8000000,
      action_seq: 2,
      prev_action: mockHash(HoloHashType.Action, 24),
    };
    const record = signedRecord(action);
    expect(verifyActionSignature(record)).toBe(true);
  });

  // ── Failure cases ──────────────────────────────────────────────────────────

  it('returns false for a tampered signature', () => {
    const action: SerializableAction = {
      type: 'Create',
      author: agentPubKey,
      timestamp: 2000000,
      action_seq: 3,
      prev_action: mockHash(HoloHashType.Action, 10),
      entry_type: { App: { entry_index: 0, zome_index: 0, visibility: 'Public' } },
      entry_hash: mockHash(HoloHashType.Entry, 20),
      weight: { bucket_id: 0, units: 0, rate_bytes: 0 },
    };
    const record = signedRecord(action);
    // Tamper with the signature
    record.signedAction.signature[0] ^= 0xff;
    expect(verifyActionSignature(record)).toBe(false);
  });

  it('returns false for a tampered action content', () => {
    const action: SerializableAction = {
      type: 'Create',
      author: agentPubKey,
      timestamp: 2000000,
      action_seq: 3,
      prev_action: mockHash(HoloHashType.Action, 10),
      entry_type: { App: { entry_index: 0, zome_index: 0, visibility: 'Public' } },
      entry_hash: mockHash(HoloHashType.Entry, 20),
      weight: { bucket_id: 0, units: 0, rate_bytes: 0 },
    };
    const record = signedRecord(action);
    // Tamper with the content after signing
    record.signedAction.hashed.content.action_seq = 99;
    expect(verifyActionSignature(record)).toBe(false);
  });

  it('returns false when signature is wrong length', () => {
    const action: SerializableAction = {
      type: 'Dna',
      author: agentPubKey,
      timestamp: 1000000,
      hash: mockHash(HoloHashType.Dna, 1),
    };
    const record = signedRecord(action);
    record.signedAction.signature = new Uint8Array(32); // wrong length
    expect(verifyActionSignature(record)).toBe(false);
  });

  it('returns false when content is missing', () => {
    const record: RecoveredRecord = {
      actionHash: mockHash(HoloHashType.Action, 1),
      signedAction: {
        hashed: { hash: mockHash(HoloHashType.Action, 1), content: null },
        signature: new Uint8Array(64),
      },
      entry: null,
      actionSeq: 0,
      timestamp: BigInt(0),
    };
    expect(verifyActionSignature(record)).toBe(false);
  });

  it('returns false when signature is missing', () => {
    const record: RecoveredRecord = {
      actionHash: mockHash(HoloHashType.Action, 1),
      signedAction: {
        hashed: {
          hash: mockHash(HoloHashType.Action, 1),
          content: { type: 'Dna', author: agentPubKey, timestamp: 1000000, hash: mockHash(HoloHashType.Dna, 1) },
        },
        signature: undefined,
      },
      entry: null,
      actionSeq: 0,
      timestamp: BigInt(0),
    };
    expect(verifyActionSignature(record)).toBe(false);
  });

  it('returns false when author is missing', () => {
    const action: SerializableAction = {
      type: 'Dna',
      author: agentPubKey,
      timestamp: 1000000,
      hash: mockHash(HoloHashType.Dna, 1),
    };
    const record = signedRecord(action);
    record.signedAction.hashed.content.author = undefined;
    expect(verifyActionSignature(record)).toBe(false);
  });

  // ── JSON round-trip tolerance ──────────────────────────────────────────────

  it('verifies after JSON round-trip (Uint8Array -> Array -> Uint8Array)', () => {
    const action: SerializableAction = {
      type: 'Create',
      author: agentPubKey,
      timestamp: 2000000,
      action_seq: 3,
      prev_action: mockHash(HoloHashType.Action, 10),
      entry_type: { App: { entry_index: 0, zome_index: 0, visibility: 'Public' } },
      entry_hash: mockHash(HoloHashType.Entry, 20),
      weight: { bucket_id: 0, units: 0, rate_bytes: 0 },
    };
    const record = signedRecord(action);

    // Simulate JSON round-trip: Uint8Array fields become plain Arrays.
    // Use mutable record views since the wire format has number[] not Uint8Array.
    const content = record.signedAction.hashed.content as unknown as Record<string, unknown>;
    content.author = Array.from(action.author);
    content.prev_action = Array.from(action.prev_action);
    content.entry_hash = Array.from(action.entry_hash);
    const signed = record.signedAction as unknown as Record<string, unknown>;
    signed.signature = Array.from(record.signedAction.signature);

    expect(verifyActionSignature(record)).toBe(true);
  });
});

// ============================================================================
// storeRecoveredRecords verification counts
// ============================================================================

describe('storeRecoveredRecords verification counts', () => {
  function createMockStorage() {
    return {
      putAction: () => {},
      putEntry: () => {},
      updateChainHead: () => {},
    };
  }

  it('returns verifiedCount and unverifiedCount', () => {
    const action: SerializableAction = {
      type: 'Create',
      author: agentPubKey,
      timestamp: 2000000,
      action_seq: 3,
      prev_action: mockHash(HoloHashType.Action, 10),
      entry_type: { App: { entry_index: 0, zome_index: 0, visibility: 'Public' } },
      entry_hash: mockHash(HoloHashType.Entry, 20),
      weight: { bucket_id: 0, units: 0, rate_bytes: 0 },
    };
    const validRecord = signedRecord(action);

    const dnaHash = mockHash(HoloHashType.Dna, 1);
    const result = storeRecoveredRecords(
      [validRecord],
      createMockStorage() as StorageProvider,
      dnaHash,
      agentPubKey
    );

    expect(result.recoveredCount).toBe(1);
    expect(result.verifiedCount).toBe(1);
    expect(result.unverifiedCount).toBe(0);
  });

  it('aborts with zero records stored when signature is invalid', () => {
    const action: SerializableAction = {
      type: 'Dna',
      author: agentPubKey,
      timestamp: 1000000,
      hash: mockHash(HoloHashType.Dna, 1),
    };
    const record = signedRecord(action);
    // Tamper with signature
    record.signedAction.signature[0] ^= 0xff;

    const dnaHash = mockHash(HoloHashType.Dna, 1);
    const result = storeRecoveredRecords(
      [record],
      createMockStorage() as StorageProvider,
      dnaHash,
      agentPubKey
    );

    // Entire operation aborted -- no records stored
    expect(result.recoveredCount).toBe(0);
    expect(result.failedCount).toBe(1);
    expect(result.verifiedCount).toBe(0);
    expect(result.unverifiedCount).toBe(1);
    expect(result.errors[0]).toContain('Signature verification failed');
  });

  it('does not store records when verification fails', () => {
    const action: SerializableAction = {
      type: 'Create',
      author: agentPubKey,
      timestamp: 2000000,
      action_seq: 3,
      prev_action: mockHash(HoloHashType.Action, 10),
      entry_type: { App: { entry_index: 0, zome_index: 0, visibility: 'Public' } },
      entry_hash: mockHash(HoloHashType.Entry, 20),
      weight: { bucket_id: 0, units: 0, rate_bytes: 0 },
    };
    const record = signedRecord(action);
    record.signedAction.signature = new Uint8Array(64); // wrong sig

    const storage = createMockStorage();
    let putActionCalled = false;
    storage.putAction = () => { putActionCalled = true; };

    const dnaHash = mockHash(HoloHashType.Dna, 1);
    storeRecoveredRecords([record], storage as StorageProvider, dnaHash, agentPubKey);

    // Signature verification failed -- putAction should NOT have been called
    expect(putActionCalled).toBe(false);
  });
});
