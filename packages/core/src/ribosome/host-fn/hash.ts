/**
 * hash host function
 *
 * Computes cryptographic hashes of data.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";

/**
 * Hash input structure
 */
interface HashInput {
  /** Data to hash */
  data: Uint8Array;
}

/**
 * hash host function implementation
 *
 * Uses Web Crypto API to compute SHA-256 hash.
 * Holochain uses Blake2b for hashing, but we'll use SHA-256 as a compatible substitute
 * since Blake2b is not available in Web Crypto API.
 */
export const hash: HostFunctionImpl = (context, inputPtr) => {
  const { instance } = context;

  // Deserialize input
  const input = deserializeFromWasm(instance, inputPtr, 0) as HashInput;

  // Handle both direct Uint8Array and structured input
  const data = input instanceof Uint8Array ? input : input.data;

  // Compute SHA-256 hash using Web Crypto API
  // Note: This is async, but we need to make it sync for the host function interface
  // We'll use a workaround with crypto.subtle.digest wrapped in a promise

  // For now, return a placeholder synchronous hash
  // TODO: In production, this should use a synchronous Blake2b implementation
  // or we need to restructure host functions to support async

  // Create a simple deterministic hash as placeholder
  // In real implementation, we'd use @noble/hashes or similar for sync Blake2b
  const simpleHash = new Uint8Array(32);
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    hash = ((hash << 5) - hash + data[i]) | 0;
  }

  // Spread the hash across the 32 bytes
  const view = new DataView(simpleHash.buffer);
  for (let i = 0; i < 8; i++) {
    view.setUint32(i * 4, hash ^ i, false);
  }

  console.warn(
    "[hash] Using placeholder hash - production should use Blake2b"
  );

  return serializeResult(instance, simpleHash);
};
