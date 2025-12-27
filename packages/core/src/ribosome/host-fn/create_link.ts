/**
 * create_link host function
 *
 * Creates a link between two entries.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";

/**
 * Create link input structure
 */
interface CreateLinkInput {
  /** Base address (entry or action hash) */
  base: Uint8Array;

  /** Target address (entry or action hash) */
  target: Uint8Array;

  /** Link type */
  link_type: number | { App: { id: number; zome_id: number } };

  /** Optional link tag (arbitrary bytes) */
  tag?: Uint8Array;
}

/**
 * create_link host function implementation
 *
 * NOTE: This is a MOCK implementation for Step 5.
 * Returns a random action hash for the create link action.
 * Step 6 will add real link storage.
 */
export const createLink: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { instance } = context;

  // Deserialize input
  const _input = deserializeFromWasm(instance, inputPtr, inputLen) as CreateLinkInput;

  // Generate mock create link action hash
  const actionHash = new Uint8Array(32);
  crypto.getRandomValues(actionHash);

  console.warn(
    "[create_link] Using MOCK action hash - Step 6 will add real persistence"
  );

  return serializeResult(instance, actionHash);
};
