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
export const create: HostFunctionImpl = (context, inputPtr) => {
  const { instance } = context;

  // Deserialize input
  const _input = deserializeFromWasm(instance, inputPtr, 0) as CreateInput;

  // Generate mock action hash (32 random bytes)
  const actionHash = new Uint8Array(32);
  crypto.getRandomValues(actionHash);

  console.warn(
    "[create] Using MOCK action hash - Step 6 will add real persistence"
  );

  return serializeResult(instance, actionHash);
};
