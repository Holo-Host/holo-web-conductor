/**
 * Hash Module
 *
 * Provides Blake2b hashing utilities for Holochain compatibility.
 * Uses @holochain/client library functions where available.
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

// Re-export prefixes from @holochain/client for convenience
export const ENTRY_HASH_PREFIX = HASH_TYPE_PREFIX[HoloHashType.Entry];
export const ACTION_HASH_PREFIX = HASH_TYPE_PREFIX[HoloHashType.Action];
export const AGENT_PUBKEY_PREFIX = HASH_TYPE_PREFIX[HoloHashType.Agent];
export const DNA_HASH_PREFIX = HASH_TYPE_PREFIX[HoloHashType.Dna];
export const WASM_HASH_PREFIX = HASH_TYPE_PREFIX[HoloHashType.Wasm]; // [132, 42, 36] = 0x84, 0x2a, 0x24

// Re-export library functions and types
export { hashFrom32AndType, dhtLocationFrom32, HASH_TYPE_PREFIX, HoloHashType, ActionType };
export type { EntryHash, ActionHash, DnaHash };

// Re-export serialization types for convenience
export { serializeAction, type SerializableAction };

export const assembleHoloHash = (hash32: Uint8Array, prefix: Uint8Array): Uint8Array => {
  // Determine hash type from prefix
  const type = Object.entries(HASH_TYPE_PREFIX).find(
    ([, p]) => p[0] === prefix[0] && p[1] === prefix[1] && p[2] === prefix[2]
  )?.[0] as HoloHashType | undefined;

  if (type) {
    return hashFrom32AndType(hash32, type);
  }

  // Fallback for unknown prefix types
  const location = dhtLocationFrom32(hash32);
  const holoHash = new Uint8Array(39);
  holoHash.set(prefix, 0);
  holoHash.set(hash32, 3);
  holoHash.set(location, 35);
  return holoHash;
};

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
 * Compute EntryHash from raw content bytes
 *
 * DEPRECATED: Use computeAppEntryHash or computeAgentEntryHash instead.
 *
 * This function hashes raw bytes directly. This is ONLY correct for
 * entries where the content has already been wrapped in the Entry enum
 * and serialized.
 *
 * @param entryContent - Raw entry content bytes
 * @returns 39-byte EntryHash
 */
export function computeEntryHash(entryContent: Uint8Array): EntryHash {
  const hash32 = blake2b256(entryContent);
  return hashFrom32AndType(hash32, HoloHashType.Entry) as EntryHash;
}

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

  // Debug: show the EXACT serialized bytes we're hashing
  console.log('[computeAppEntryHash] Serialized bytes to hash:', Array.from(new Uint8Array(serialized)));

  // Debug: log the serialized bytes to compare with Rust
  const serializedArray = new Uint8Array(serialized);

  // Log ALL entries to debug what's being created
  let decoded = '';
  try {
    decoded = new TextDecoder().decode(entryContent);
  } catch {
    decoded = '[binary - could not decode]';
  }

  // Determine entry type based on content
  const isProfileEntry = decoded.includes('nickname');
  const hasPathMarker = entryContent[0] === 145 || entryContent[0] === 146 || entryContent[0] === 147; // fixarray markers

  if (isProfileEntry) {
    console.log('[computeAppEntryHash] 👤 PROFILE ENTRY:', decoded.substring(0, 50));
  } else {
    // Log all non-profile entries - these could be paths
    console.log('[computeAppEntryHash] 📦 ENTRY (possibly path)');
    console.log('[computeAppEntryHash] Content length:', entryContent.length);
    console.log('[computeAppEntryHash] First byte (msgpack type):', entryContent[0], '(145-147 = fixarray)');
    console.log('[computeAppEntryHash] Full entry content bytes:', Array.from(entryContent));
    console.log('[computeAppEntryHash] Decoded attempt:', decoded.substring(0, 100));
  }

  console.log('[computeAppEntryHash] Entry content length:', entryContent.length);
  console.log('[computeAppEntryHash] Serialized Entry length:', serializedArray.length);

  // Hash the serialized Entry
  const hash32 = blake2b256(serializedArray);
  console.log('[computeAppEntryHash] Blake2b hash32:', Array.from(hash32));

  const result = hashFrom32AndType(hash32, HoloHashType.Entry) as EntryHash;
  console.log('[computeAppEntryHash] Final EntryHash:', Array.from(result));

  return result;
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
 * Action structure for hashing
 *
 * This is a generic structure that covers all action types.
 * Specific action types have additional fields.
 */
export interface ActionForHashing {
  type: ActionType;
  author: Uint8Array;
  timestamp: bigint;
  action_seq: number;
  prev_action: Uint8Array | null;
  // Additional fields depending on action type
  [key: string]: unknown;
}

/**
 * Compute ActionHash from action data
 *
 * @deprecated Use computeActionHashV2 with SerializableAction for correct serialization
 * Serializes the action using msgpack and hashes it.
 * The action must be in Holochain's internally tagged enum format.
 *
 * @param action - Action data in Holochain format
 * @returns 39-byte ActionHash
 */
export function computeActionHash(action: ActionForHashing): ActionHash {
  // Serialize action to msgpack
  const serialized = encode(actionToSerializable(action));

  // Hash the serialized action
  const hash32 = blake2b256(new Uint8Array(serialized));
  return hashFrom32AndType(hash32, HoloHashType.Action) as ActionHash;
}

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

/**
 * Serialize action to msgpack bytes
 *
 * This is the canonical serialization used for both hashing and signing.
 * Holochain signs the serialized action bytes, NOT the hash.
 *
 * @param action - Action data in Holochain format
 * @returns Msgpack-serialized action bytes
 */
export function serializeActionForSigning(action: ActionForHashing): Uint8Array {
  return new Uint8Array(encode(actionToSerializable(action)));
}

/**
 * Convert action to a serializable format
 *
 * Converts BigInt timestamps to numbers and handles Uint8Array fields
 * for proper msgpack serialization.
 */
function actionToSerializable(action: ActionForHashing): Record<string, unknown> {
  const result: Record<string, unknown> = {
    type: action.type,
    author: action.author,
    timestamp: Number(action.timestamp),  // Convert BigInt to number
    action_seq: action.action_seq,
  };

  // Only include prev_action if it's not null (Holochain omits None values)
  if (action.prev_action !== null) {
    result.prev_action = action.prev_action;
  }

  // Copy other fields (entry_type, entry_hash, weight, etc.)
  for (const [key, value] of Object.entries(action)) {
    if (!['type', 'author', 'timestamp', 'action_seq', 'prev_action'].includes(key)) {
      result[key] = value;
    }
  }

  return result;
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

  // Debug: log first 100 bytes of serialized data
  const serializedArray = new Uint8Array(serialized);
  console.log('[computeDnaHash] Serialized bytes (first 100):', Array.from(serializedArray.slice(0, 100)));
  console.log('[computeDnaHash] Serialized length:', serializedArray.length);

  // Hash with Blake2b-256
  const hash32 = blake2b256(serializedArray);

  // Return as DnaHash HoloHash
  return hashFrom32AndType(hash32, HoloHashType.Dna) as DnaHash;
}
