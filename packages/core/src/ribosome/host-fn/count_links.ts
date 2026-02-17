/**
 * count_links host function
 *
 * Counts links from a base address using cascade (local + network).
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";
import { getStorageProvider } from "../../storage/storage-provider";
import { Cascade, getNetworkCache, getNetworkService } from "../../network";
import { parseLinkTypeFilter } from "./get_links";

/**
 * Count links input structure (HDK sends LinkQuery)
 */
interface CountLinksInput {
  /** Base address to count links from */
  base: Uint8Array;

  /** Link type filter (LinkTypeFilter enum) */
  link_type?: unknown;

  /** Tag filter prefix */
  tag_prefix?: Uint8Array;
}

/**
 * count_links host function implementation
 *
 * Uses cascade pattern (local + network) so zero-arc nodes can count
 * other agents' links via the linker.
 */
export const countLinks: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;
  const storage = getStorageProvider();

  // Deserialize input
  const input = deserializeFromWasm(instance, inputPtr, inputLen) as CountLinksInput;

  const [dnaHash, agentPubKey] = callContext.cellId;

  // Parse link type filter using the same parser as get_links
  const linkTypeFilter = parseLinkTypeFilter(input.link_type);

  // Use cascade for local + network data (same pattern as get_links)
  const cascade = new Cascade(storage, getNetworkCache(), getNetworkService());
  let links = cascade.fetchLinks(dnaHash, agentPubKey, input.base, linkTypeFilter);

  // Filter by tag prefix if specified
  if (input.tag_prefix && input.tag_prefix.length > 0) {
    links = links.filter(link => {
      if (link.tag.length < input.tag_prefix!.length) return false;
      for (let i = 0; i < input.tag_prefix!.length; i++) {
        if (link.tag[i] !== input.tag_prefix![i]) return false;
      }
      return true;
    });
  }

  const count = links.length;

  console.log('[count_links] Counted links (cascade):', count);

  return serializeResult(instance, count);
};
