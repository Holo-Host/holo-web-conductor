/**
 * get_links host function
 *
 * Retrieves links from a base address using cascade pattern.
 * Order: Local storage → Network cache → Network
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";
import { SourceChainStorage } from "../../storage/source-chain-storage";
import { Cascade, getNetworkCache, getNetworkService } from "../../network";

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
 * Uses Cascade pattern: local storage → network cache → network
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

  // Create cascade for this lookup
  // Uses global network service if configured (MockNetworkService for testing, SyncXHRNetworkService for production)
  const cascade = new Cascade(storage, getNetworkCache(), getNetworkService());

  // Try cascade: local → cache → network
  const networkLinks = cascade.fetchLinks(dnaHash, agentPubKey, input.base_address, linkTypeFilter);

  // Filter by tag prefix if specified
  let filteredLinks = networkLinks;
  if (input.tag_prefix && input.tag_prefix.length > 0) {
    filteredLinks = networkLinks.filter(link => {
      if (link.tag.length < input.tag_prefix!.length) return false;
      for (let i = 0; i < input.tag_prefix!.length; i++) {
        if (link.tag[i] !== input.tag_prefix![i]) return false;
      }
      return true;
    });
  }

  // Convert NetworkLink to Holochain Link format
  const links: Link[] = filteredLinks.map(link => {
    // Convert 32-byte author to 39-byte prefixed version if needed
    let authorPrefixed: Uint8Array;
    if (link.author.length === 32) {
      authorPrefixed = new Uint8Array(39);
      authorPrefixed.set([0x84, 0x20, 0x24], 0); // AGENT_PREFIX
      authorPrefixed.set(link.author, 3);
      authorPrefixed.set([0, 0, 0, 0], 35);
    } else {
      authorPrefixed = link.author;
    }

    return {
      target: link.target,
      timestamp: typeof link.timestamp === 'bigint' ? Number(link.timestamp) : link.timestamp,
      tag: link.tag,
      create_link_hash: link.create_link_hash,
      base: link.base,
      author: authorPrefixed,
      zome_index: link.zome_index,
      link_type: link.link_type,
    };
  });

  console.log('[get_links] Found links via cascade:', links.length);

  // HDK expects Vec<Vec<Link>> (array of arrays)
  // The outer array is for batching multiple get_links queries
  // Since we only handle one query, we wrap the result in an array
  return serializeResult(instance, [links]);
};
