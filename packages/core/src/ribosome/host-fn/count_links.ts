/**
 * count_links host function
 *
 * Counts links from a base address.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";

/**
 * Count links input structure
 */
interface CountLinksInput {
  /** Base address to count links from */
  base: Uint8Array;

  /** Link type filter */
  link_type?: number | { App: { id: number; zome_id: number } };

  /** Tag filter prefix */
  tag_prefix?: Uint8Array;
}

/**
 * count_links host function implementation
 *
 * NOTE: This is a MOCK implementation for Step 5.
 * Always returns 0 (no links found).
 * Step 6 will add real link counting.
 */
export const countLinks: HostFunctionImpl = (context, inputPtr) => {
  const { instance } = context;

  // Deserialize input
  const _input = deserializeFromWasm(instance, inputPtr, 0) as CountLinksInput;

  // Return count of 0 (no links)
  const count = 0;

  console.warn(
    "[count_links] Returning 0 - Step 6 will add real link counting"
  );

  return serializeResult(instance, count);
};
