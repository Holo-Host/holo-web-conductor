/**
 * Hash Module
 *
 * Provides Blake2b hashing utilities for Holochain compatibility.
 * Uses @holochain/client library functions where available.
 *
 * Why we need these functions (vs just using @holochain/client):
 * - @holochain/client's hashFromContentAndType() always msgpack-encodes content before hashing
 * - We need to hash pre-encoded bytes (from WASM, with specific field ordering for actions)
 * - blake2b256() gives us direct access to hash raw bytes
 */

import { blake2b } from 'blakejs';
import { encode } from '@msgpack/msgpack';
import {
  hashFrom32AndType,
  dhtLocationFrom32,
  HASH_TYPE_PREFIX,
  HoloHashType,
  ActionType,
  type EntryHash,
  type ActionHash,
  type DnaHash,
} from '@holochain/client';
import { serializeAction, type SerializableAction } from '../types/holochain-serialization';

// Re-export library functions and types
export { hashFrom32AndType, dhtLocationFrom32, HASH_TYPE_PREFIX, HoloHashType, ActionType };
export type { EntryHash, ActionHash, DnaHash };

// Re-export serialization types for convenience
export { serializeAction, type SerializableAction };

// ============================================================================
// BLAKE2b Functions (thin wrappers for direct byte hashing)
// ============================================================================

/**
 * Compute BLAKE2b-256 hash (32 bytes output)
 *
 * Used when we need to hash raw bytes directly (e.g., entry content
 * that's already msgpack-encoded by the zome).
 *
 * @param data - Input data to hash
 * @returns 32-byte hash
 */
export function blake2b256(data: Uint8Array): Uint8Array {
  return blake2b(data, undefined, 32);
}

// ============================================================================
// Entry Hash Computation
// ============================================================================

/**
 * Compute EntryHash for an App entry
 *
 * Holochain computes App entry hashes by:
 * 1. Wrapping the content in the Entry enum: { entry_type: "App", entry: <content> }
 * 2. Serializing with msgpack
 * 3. Hashing with Blake2b-256
 * 4. Wrapping as HoloHash with Entry type
 *
 * @param entryContent - Raw entry content bytes (msgpack-encoded app data)
 * @returns 39-byte EntryHash
 */
export function computeAppEntryHash(entryContent: Uint8Array): EntryHash {
  // Wrap in Entry::App format with internal tagging
  // Rust serde uses #[serde(tag = "entry_type", content = "entry")]
  // which produces {"entry_type": "App", "entry": <bytes>}
  const entryStruct = {
    entry_type: "App",
    entry: entryContent,
  };

  // Serialize the Entry enum
  const serialized = encode(entryStruct);
  const serializedArray = new Uint8Array(serialized);

  // Hash the serialized Entry
  const hash32 = blake2b256(serializedArray);

  return hashFrom32AndType(hash32, HoloHashType.Entry) as EntryHash;
}

/**
 * Compute EntryHash for an Agent entry
 *
 * For Agent entries, Holochain does NOT hash the content.
 * Instead, the EntryHash is the AgentPubKey retyped with Entry prefix.
 * The 32-byte core remains the same, only the 3-byte prefix changes.
 *
 * @param agentPubKey - 39-byte AgentPubKey
 * @returns 39-byte EntryHash (same core as input, Entry prefix)
 */
export function computeAgentEntryHash(agentPubKey: Uint8Array): EntryHash {
  if (agentPubKey.length !== 39) {
    throw new Error(`AgentPubKey must be 39 bytes, got ${agentPubKey.length}`);
  }

  // Extract the 32-byte core (bytes 3-35)
  const core32 = agentPubKey.slice(3, 35);

  // Retype as EntryHash (uses Entry prefix, same DHT location)
  return hashFrom32AndType(core32, HoloHashType.Entry) as EntryHash;
}

// ============================================================================
// Action Hash Computation
// ============================================================================

/**
 * Compute ActionHash from SerializableAction
 *
 * This is the preferred method that uses properly typed and ordered serialization.
 * The action is serialized using Holochain's serde-compatible format.
 *
 * @param action - Action data matching Holochain's Rust types
 * @returns 39-byte ActionHash
 */
export function computeActionHashV2(action: SerializableAction): ActionHash {
  // Serialize using the type-safe serialization function
  const serialized = serializeAction(action);

  // Hash the serialized action
  const hash32 = blake2b256(serialized);
  return hashFrom32AndType(hash32, HoloHashType.Action) as ActionHash;
}

// ============================================================================
// WASM Hash Computation
// ============================================================================

/**
 * Compute WasmHash from WASM bytes
 *
 * Holochain computes WASM hashes by:
 * 1. Hashing the raw WASM bytes with Blake2b-256
 * 2. Wrapping as HoloHash with Wasm type
 *
 * Note: Unlike other hashes, the WASM hash is computed from raw bytes,
 * not from a msgpack-serialized struct. See holochain_types/src/dna/wasm.rs
 * where TryFrom<&DnaWasm> for SerializedBytes just returns code.to_vec().
 *
 * @param wasmBytes - Raw WASM bytes
 * @returns 39-byte WasmHash
 */
export function computeWasmHash(wasmBytes: Uint8Array): Uint8Array {
  // Hash raw WASM bytes directly (not serialized as {code: bytes})
  const hash32 = blake2b256(wasmBytes);
  return hashFrom32AndType(hash32, HoloHashType.Wasm);
}

// ============================================================================
// DNA Hash Computation
// ============================================================================

/**
 * Integrity zome definition for DNA hash computation
 */
export interface IntegrityZomeForHash {
  name: string;
  wasmHash: Uint8Array;  // 39-byte WasmHash
  dependencies: string[];
}

/**
 * DNA modifiers for hash computation
 */
export interface DnaModifiersForHash {
  network_seed: string;
  properties: Uint8Array;  // Msgpack-encoded properties
}

/**
 * Compute DnaHash from DNA definition
 *
 * Holochain computes DNA hashes by:
 * 1. Creating a DnaDefHash structure containing only:
 *    - modifiers: { network_seed, properties }
 *    - integrity_zomes: [(name, { wasm_hash, dependencies }), ...]
 * 2. Serializing with msgpack
 * 3. Hashing with Blake2b-256
 * 4. Wrapping as HoloHash with Dna type
 *
 * NOTE: Coordinator zomes are NOT included in the DNA hash.
 *
 * @param modifiers - DNA modifiers (network_seed, properties)
 * @param integrityZomes - Integrity zome definitions
 * @returns 39-byte DnaHash
 */
export function computeDnaHash(
  modifiers: DnaModifiersForHash,
  integrityZomes: IntegrityZomeForHash[]
): DnaHash {
  // Build the DnaDefHash structure
  // In Rust, IntegrityZomeDef wraps ZomeDef::Wasm(WasmZome { wasm_hash, dependencies })
  // When serialized, ZomeDef::Wasm uses #[serde(untagged)] so it becomes just WasmZome
  const integrityZomesForHash = integrityZomes.map(zome => [
    zome.name,
    {
      wasm_hash: zome.wasmHash,
      dependencies: zome.dependencies,
    }
  ]);

  // DnaModifiers in Rust has network_seed (String) and properties (SerializedBytes)
  // SerializedBytes serializes as raw bytes (the inner Vec<u8>)
  const dnaDefHash = {
    modifiers: {
      network_seed: modifiers.network_seed,
      properties: modifiers.properties,
    },
    integrity_zomes: integrityZomesForHash,
  };

  // Serialize with msgpack
  const serialized = encode(dnaDefHash);
  const serializedArray = new Uint8Array(serialized);

  // Hash with Blake2b-256
  const hash32 = blake2b256(serializedArray);

  // Return as DnaHash HoloHash
  return hashFrom32AndType(hash32, HoloHashType.Dna) as DnaHash;
}
