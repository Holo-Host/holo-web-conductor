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
  const { callContext, instance } = context;

  // Deserialize input
  const input = deserializeFromWasm(
    instance,
    inputPtr,
    inputLen
  ) as GetLinksInput;

  const manifest = callContext.dnaManifest;

  console.log("[get_links] Getting links", {
    zome: callContext.zome,
    hasManifest: !!manifest,
    linkType: input.link_type,
  });

  // TODO: Use manifest to filter links by type in Step 6
  // For now, return empty array (no link storage yet)
  if (!manifest) {
    console.warn(
      "[get_links] No DNA manifest available - returning empty links"
    );
  }

  // Return empty array (no links found)
  const links: Link[] = [];

  console.warn(
    "[get_links] Returning empty results - Step 6 will add real link queries"
  );

  return serializeResult(instance, links);
};
