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
} from '@holochain/client';

// Re-export prefixes from @holochain/client for convenience
export const ENTRY_HASH_PREFIX = HASH_TYPE_PREFIX[HoloHashType.Entry];
export const ACTION_HASH_PREFIX = HASH_TYPE_PREFIX[HoloHashType.Action];
export const AGENT_PUBKEY_PREFIX = HASH_TYPE_PREFIX[HoloHashType.Agent];
export const DNA_HASH_PREFIX = HASH_TYPE_PREFIX[HoloHashType.Dna];

// Re-export library functions and types
export { hashFrom32AndType, dhtLocationFrom32, HASH_TYPE_PREFIX, HoloHashType, ActionType };
export type { EntryHash, ActionHash };

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
 * Compute EntryHash from entry content
 *
 * For App entries, the content is already msgpack-encoded by the zome.
 * We hash the raw bytes and wrap in a HoloHash.
 *
 * @param entryContent - Raw entry content bytes
 * @returns 39-byte EntryHash
 */
export function computeEntryHash(entryContent: Uint8Array): EntryHash {
  const hash32 = blake2b256(entryContent);
  return hashFrom32AndType(hash32, HoloHashType.Entry) as EntryHash;
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
