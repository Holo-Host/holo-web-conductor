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
export const deleteEntry: HostFunctionImpl = (context, inputPtr) => {
  const { instance } = context;

  // Deserialize input
  const _input = deserializeFromWasm(instance, inputPtr, 0) as DeleteInput;

  // Generate mock delete action hash
  const actionHash = new Uint8Array(32);
  crypto.getRandomValues(actionHash);

  console.warn(
    "[delete] Using MOCK action hash - Step 6 will add real persistence"
  );

  return serializeResult(instance, actionHash);
};
