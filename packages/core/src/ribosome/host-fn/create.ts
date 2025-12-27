/**
 * create host function
 *
 * Creates a new entry on the source chain.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";

/**
 * Create input structure
 */
interface CreateInput {
  /** Entry type */
  entry_type: string | { App: { id: number; zome_id: number; visibility: string } };

  /** Entry content (serialized) */
  entry: Uint8Array | unknown;
}

/**
 * create host function implementation
 *
 * NOTE: This is a MOCK implementation for Step 5.
 * Returns a random action hash without persisting anything.
 * Step 6 will add real source chain storage.
 */
export const create: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { instance } = context;

  // Deserialize input
  const _input = deserializeFromWasm(instance, inputPtr, inputLen) as CreateInput;

  // Generate mock ActionHash (39 bytes): [prefix(3)][hash(32)][location(4)]
  const actionHash = new Uint8Array(39);
  actionHash.set([132, 41, 36], 0); // ACTION_PREFIX

  // Generate random 32-byte hash
  const randomHash = new Uint8Array(32);
  crypto.getRandomValues(randomHash);
  actionHash.set(randomHash, 3);

  actionHash.set([0, 0, 0, 0], 35); // location (all zeros)

  console.warn(
    "[create] Using MOCK action hash - Step 6 will add real persistence"
  );

  return serializeResult(instance, actionHash);
};
