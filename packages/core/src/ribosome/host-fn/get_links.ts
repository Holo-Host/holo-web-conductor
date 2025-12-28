/**
 * get_links host function
 *
 * Retrieves links from a base address using storage.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";
import { SourceChainStorage } from "../../storage/source-chain-storage";

/**
 * Get links input structure (matches Holochain HDK GetLinksInput)
 * Note: The input is Vec<GetLinksInput>, so we receive an array
 */
interface GetLinksInput {
  /** Base address to get links from */
  base_address: Uint8Array;

  /** Link type filter */
  link_type?: number | { App: { id: number; zome_id: number } };

  /** Tag filter prefix */
  tag_prefix?: Uint8Array;
}

/**
 * Link structure (matches Holochain's Link type)
 */
interface Link {
  /** Target of the link */
  target: Uint8Array;

  /** Timestamp */
  timestamp: number;

  /** Tag */
  tag: Uint8Array;

  /** Create link action hash */
  create_link_hash: Uint8Array;

  /** Base address of the link */
  base: Uint8Array;

  /** Author of the link */
  author: Uint8Array;

  /** Zome index */
  zome_index: number;

  /** Link type (newtype struct wrapping u8) */
  link_type: number;
}

/**
 * get_links host function implementation
 *
 * Retrieves links from storage (uses session cache for synchronous reads).
 */
export const getLinks: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;
  const storage = SourceChainStorage.getInstance();

  // Deserialize input - it's an array of GetLinksInput objects
  const inputs = deserializeFromWasm(instance, inputPtr, inputLen) as GetLinksInput[];
  const input = inputs[0]; // Get first element

  console.log("[get_links] Getting links", {
    base: Array.from(input.base_address.slice(0, 8)),
    linkType: input.link_type,
  });

  const [dnaHash, agentPubKey] = callContext.cellId;

  // Parse link type filter
  const linkTypeFilter = input.link_type !== undefined
    ? (typeof input.link_type === 'number' ? input.link_type : input.link_type.App?.id)
    : undefined;

  // Get links from storage (synchronous if in cache)
  const linksResult = storage.getLinks(input.base_address, dnaHash, agentPubKey, linkTypeFilter);

  // If it's a Promise, we can't handle it synchronously yet (Step 7+)
  // For now, return empty array if not in cache
  if (linksResult instanceof Promise) {
    console.warn('[get_links] Links not in session cache - returning empty array (Step 7+ will support async reads)');
    return serializeResult(instance, []);
  }

  let storedLinks = linksResult;

  // Filter by tag prefix if specified
  if (input.tag_prefix && input.tag_prefix.length > 0) {
    storedLinks = storedLinks.filter(link => {
      if (link.tag.length < input.tag_prefix!.length) return false;
      for (let i = 0; i < input.tag_prefix!.length; i++) {
        if (link.tag[i] !== input.tag_prefix![i]) return false;
      }
      return true;
    });
  }

  // Filter out deleted links
  storedLinks = storedLinks.filter(link => !link.deleted);

  // Convert to Holochain Link format
  // Convert 32-byte author to 39-byte prefixed version
  const links: Link[] = storedLinks.map(link => {
    const authorPrefixed = new Uint8Array(39);
    if (link.author.length === 32) {
      authorPrefixed.set([0x84, 0x20, 0x24], 0); // AGENT_PREFIX
      authorPrefixed.set(link.author, 3);
      authorPrefixed.set([0, 0, 0, 0], 35);
    } else {
      authorPrefixed.set(link.author);
    }

    return {
      target: link.targetAddress,
      timestamp: Number(link.timestamp),
      tag: link.tag,
      create_link_hash: link.createLinkHash,
      base: link.baseAddress,
      author: authorPrefixed,
      zome_index: link.zomeIndex,
      link_type: link.linkType,
    };
  });

  console.log('[get_links] Found links in cache:', links.length);

  // HDK expects Vec<Vec<Link>> (array of arrays)
  // The outer array is for batching multiple get_links queries
  // Since we only handle one query, we wrap the result in an array
  return serializeResult(instance, [links]);
};
