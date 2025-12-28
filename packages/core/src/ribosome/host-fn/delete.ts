/**
 * delete host function (actually "delete_entry" in Holochain)
 *
 * Marks an entry as deleted on the source chain.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";

/**
 * Delete input structure
 */
interface DeleteInput {
  /** Hash of the entry to delete */
  deletes_address: Uint8Array;
}

/**
 * delete host function implementation
 *
 * NOTE: This is a MOCK implementation for Step 5.
 * Returns a random action hash for the delete action.
 * Step 6 will add real chain storage.
 */
export const deleteEntry: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { instance } = context;

  // Deserialize input
  const _input = deserializeFromWasm(instance, inputPtr, inputLen) as DeleteInput;

  // Generate mock delete action hash (39 bytes: 3 prefix + 32 hash + 4 location)
  const actionHash = new Uint8Array(39);
  crypto.getRandomValues(actionHash);
  actionHash[0] = 0x84; // Action hash prefix
  actionHash[1] = 0x29; // ActionHash-specific byte
  actionHash[2] = 0x24;

  console.warn(
    "[delete] Using MOCK action hash - Step 6 will add real persistence"
  );

  return serializeResult(instance, actionHash);
};
