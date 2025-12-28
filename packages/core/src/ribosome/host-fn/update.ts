/**
 * update host function
 *
 * Updates an existing entry on the source chain.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";

/**
 * Update input structure
 */
interface UpdateInput {
  /** Original action hash to update */
  original_action_hash: Uint8Array;

  /** New entry content */
  entry: Uint8Array | unknown;
}

/**
 * update host function implementation
 *
 * NOTE: This is a MOCK implementation for Step 5.
 * Returns a random action hash for the update action.
 * Step 6 will add real chain storage and validation.
 */
export const update: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { instance } = context;

  // Deserialize input
  const _input = deserializeFromWasm(instance, inputPtr, inputLen) as UpdateInput;

  // Generate mock update action hash (39 bytes: 3 prefix + 32 hash + 4 location)
  const actionHash = new Uint8Array(39);
  crypto.getRandomValues(actionHash);
  actionHash[0] = 0x84; // Action hash prefix
  actionHash[1] = 0x29; // ActionHash-specific byte
  actionHash[2] = 0x24;

  console.warn(
    "[update] Using MOCK action hash - Step 6 will add real persistence"
  );

  return serializeResult(instance, actionHash);
};
