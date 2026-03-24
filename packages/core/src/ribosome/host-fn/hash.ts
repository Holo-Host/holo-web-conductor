/**
 * hash host function
 *
 * Computes cryptographic hashes of data using Blake2b (same as Holochain).
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";
import { blake2b } from 'blakejs';

/**
 * Hash input structure (matches Holochain's HashInput)
 *
 * HashInput is an enum in Rust:
 * - Entry(Entry) - hash an entry
 * - Action(Action) - hash an action
 * - Content(UnsafeBytes) - hash raw content
 */
interface HashInput {
  /** The variant type (Entry, Action, or Content) */
  Entry?: unknown;
  Action?: unknown;
  Content?: Uint8Array;
}

/**
 * hash host function implementation
 *
 * Uses Blake2b-256 for hashing, matching Holochain's implementation.
 * This is critical for path entries - the WASM computes path entry hashes
 * using this host function.
 */
export const hash: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { instance } = context;

  // Deserialize input - it's a HashInput enum
  const input = deserializeFromWasm(instance, inputPtr, inputLen) as HashInput;

  // Extract the data to hash based on input variant
  let dataToHash: Uint8Array;

  if (input.Content !== undefined) {
    // Direct content hashing
    dataToHash = input.Content instanceof Uint8Array
      ? input.Content
      : new Uint8Array(Object.values(input.Content as Record<string, number>));
  } else if (input.Entry !== undefined) {
    // Entry hashing - the entry is already serialized
    const entry = input.Entry;
    if (entry instanceof Uint8Array) {
      dataToHash = entry;
    } else {
      // Entry might be an object that needs to be treated as bytes
      dataToHash = new Uint8Array(Object.values(entry as Record<string, number>));
    }
  } else if (input.Action !== undefined) {
    // Action hashing
    const action = input.Action;
    if (action instanceof Uint8Array) {
      dataToHash = action;
    } else {
      dataToHash = new Uint8Array(Object.values(action as Record<string, number>));
    }
  } else {
    // Fallback - treat entire input as bytes
    console.warn('[hash] Unknown input structure, using fallback');
    dataToHash = input instanceof Uint8Array
      ? input
      : new Uint8Array(Object.values(input as Record<string, number>));
  }

  // Compute Blake2b-256 hash (32 bytes output) - same as Holochain
  const hash32 = blake2b(dataToHash, undefined, 32);

  return serializeResult(instance, hash32);
};
