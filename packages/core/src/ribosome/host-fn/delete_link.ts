/**
 * delete_link host function
 *
 * Deletes a link from the source chain.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";

/**
 * Delete link input structure
 */
interface DeleteLinkInput {
  /** Hash of the create link action to delete */
  add_address: Uint8Array;
}

/**
 * delete_link host function implementation
 *
 * NOTE: This is a MOCK implementation for Step 5.
 * Returns a random action hash for the delete link action.
 * Step 6 will add real link deletion.
 */
export const deleteLink: HostFunctionImpl = (context, inputPtr) => {
  const { instance } = context;

  // Deserialize input
  const _input = deserializeFromWasm(instance, inputPtr, 0) as DeleteLinkInput;

  // Generate mock delete link action hash
  const actionHash = new Uint8Array(32);
  crypto.getRandomValues(actionHash);

  console.warn(
    "[delete_link] Using MOCK action hash - Step 6 will add real persistence"
  );

  return serializeResult(instance, actionHash);
};
