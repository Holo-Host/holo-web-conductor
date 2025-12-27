/**
 * get_links host function
 *
 * Retrieves links from a base address.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";

/**
 * Get links input structure
 */
interface GetLinksInput {
  /** Base address to get links from */
  base: Uint8Array;

  /** Link type filter */
  link_type?: number | { App: { id: number; zome_id: number } };

  /** Tag filter prefix */
  tag_prefix?: Uint8Array;
}

/**
 * Link structure
 */
interface Link {
  /** Target of the link */
  target: Uint8Array;

  /** Timestamp */
  timestamp: number;

  /** Link type */
  link_type: number;

  /** Tag */
  tag: Uint8Array;

  /** Create link action hash */
  create_link_hash: Uint8Array;
}

/**
 * get_links host function implementation
 *
 * NOTE: This is a MOCK implementation for Step 5.
 * Always returns an empty array (no links found).
 * Step 6 will add real link queries.
 */
export const getLinks: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { instance } = context;

  // Deserialize input
  const _input = deserializeFromWasm(instance, inputPtr, inputLen) as GetLinksInput;

  // Return empty array (no links found)
  const links: Link[] = [];

  console.warn(
    "[get_links] Returning empty results - Step 6 will add real link queries"
  );

  return serializeResult(instance, links);
};
