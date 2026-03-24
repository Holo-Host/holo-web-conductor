/**
 * get_links host function
 *
 * Retrieves links from a base address using cascade pattern.
 * Order: Local storage → Network cache → Network
 */

import { HostFunctionImpl } from "./base";
import { deserializeTypedFromWasm, serializeResult } from "../serialization";
import { getStorageProvider } from "../../storage/storage-provider";
import { Cascade, getNetworkCache, getNetworkService, getGetStrategyMode } from "../../network";
import { validateWasmGetLinksInputArray, type WasmGetLinksInput } from "../wasm-io-types";
import { hashFrom32AndType, HoloHashType } from "@holochain/client";
import type { GetStrategy } from "../../types/holochain-types";

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
 * Parsed link type filter with separate zome_index and link_type
 */
export interface ParsedLinkTypeFilter {
  zomeIndex?: number;
  linkType?: number;
}

/**
 * Parse LinkTypeFilter from WASM input format
 *
 * Holochain LinkTypeFilter enum serializes as:
 * - {"Types": [[zome_index, [link_type, ...]], ...]} - match specific types
 * - {"Dependencies": [zome_index, ...]} - match all types from zomes
 * - number - simple link type (legacy/simplified format)
 *
 * Returns separate zomeIndex and linkType for linker query parameters
 */
export function parseLinkTypeFilter(linkType: unknown): ParsedLinkTypeFilter {
  if (typeof linkType === 'number') {
    // Legacy format - just a link type number without zome context
    return { linkType };
  } else if (typeof linkType === 'object' && linkType !== null) {
    const lt = linkType as { Types?: Array<[number, number[]]>; Dependencies?: number[] };
    if (lt.Types && Array.isArray(lt.Types) && lt.Types.length > 0) {
      const [zomeIndex, linkTypes] = lt.Types[0];
      if (Array.isArray(linkTypes) && linkTypes.length > 0) {
        return { zomeIndex, linkType: linkTypes[0] };
      }
      // Has zome index but no link types - return just zome index (all types from that zome)
      return { zomeIndex };
    }
    if (lt.Dependencies && Array.isArray(lt.Dependencies) && lt.Dependencies.length > 0) {
      // Dependencies - return first zome index, no specific link type
      return { zomeIndex: lt.Dependencies[0] };
    }
  }
  return {};
}

/**
 * Process a single GetLinksInput and return the matching links
 */
function processGetLinksInput(
  input: WasmGetLinksInput,
  dnaHash: Uint8Array,
  agentPubKey: Uint8Array,
  cascade: Cascade,
): Link[] {
  // Resolve GetStrategy: compatibility mode forces Network
  let strategy: GetStrategy | undefined;
  const getOpts = input.get_options as { strategy?: GetStrategy } | undefined;
  if (getOpts?.strategy && getGetStrategyMode() === 'honor') {
    strategy = getOpts.strategy;
  }

  const linkTypeFilter = parseLinkTypeFilter(input.link_type);

  // Try cascade: local → cache → network
  const networkLinks = cascade.fetchLinks(dnaHash, agentPubKey, input.base_address, linkTypeFilter, undefined, strategy);

  // Filter by tag prefix if specified
  let filteredLinks = networkLinks;
  if (input.tag_prefix && input.tag_prefix.length > 0) {
    filteredLinks = networkLinks.filter(link => {
      if (link.tag.length < input.tag_prefix!.length) {
        return false;
      }
      for (let i = 0; i < input.tag_prefix!.length; i++) {
        if (link.tag[i] !== input.tag_prefix![i]) {
          return false;
        }
      }
      return true;
    });
  }

  // Convert NetworkLink to Holochain Link format
  const links: Link[] = filteredLinks.map(link => {
    // Convert 32-byte author to 39-byte prefixed version using @holochain/client utility
    const authorPrefixed = link.author.length === 39
      ? link.author
      : hashFrom32AndType(link.author.slice(0, 32), HoloHashType.Agent);

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

  return links;
}

/**
 * get_links host function implementation
 *
 * Uses Cascade pattern: local storage → network cache → network
 * Handles batch queries - processes ALL inputs and returns Vec<Vec<Link>>
 */
export const getLinks: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;
  const storage = getStorageProvider();

  // Deserialize and validate input - it's an array of GetLinksInput objects
  const inputs = deserializeTypedFromWasm(
    instance, inputPtr, inputLen,
    validateWasmGetLinksInputArray, 'WasmGetLinksInput[]'
  );

  const [dnaHash, agentPubKey] = callContext.cellId;

  // Create cascade for this lookup
  // Uses global network service if configured (MockNetworkService for testing)
  const cascade = new Cascade(storage, getNetworkCache(), getNetworkService());

  // Process ALL inputs and collect results
  // HDK expects Vec<Vec<Link>> - one Vec<Link> per input query
  const allResults: Link[][] = inputs.map((input) =>
    processGetLinksInput(input, dnaHash, agentPubKey, cascade)
  );

  return serializeResult(instance, allResults);
};
