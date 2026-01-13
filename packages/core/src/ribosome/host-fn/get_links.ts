/**
 * get_links host function
 *
 * Retrieves links from a base address using cascade pattern.
 * Order: Local storage → Network cache → Network
 */

import { HostFunctionImpl } from "./base";
import { deserializeTypedFromWasm, serializeResult } from "../serialization";
import { getStorageProvider } from "../../storage/storage-provider";
import { Cascade, getNetworkCache, getNetworkService } from "../../network";
import { validateWasmGetLinksInputArray, type WasmGetLinksInput } from "../wasm-io-types";
import { hashFrom32AndType, HoloHashType, dhtLocationFrom32 } from "@holochain/client";

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
 * Parse LinkTypeFilter from WASM input format to gateway-encoded format
 *
 * Holochain LinkTypeFilter enum serializes as:
 * - {"Types": [[zome_index, [link_type, ...]], ...]} - match specific types
 * - {"Dependencies": [zome_index, ...]} - match all types from zomes
 * - number - simple link type (legacy/simplified format)
 *
 * Gateway expects encoded format: (zome_index << 8) | link_type
 */
function parseLinkTypeFilter(linkType: unknown): number | undefined {
  if (typeof linkType === 'number') {
    return linkType;
  } else if (typeof linkType === 'object' && linkType !== null) {
    const lt = linkType as { Types?: Array<[number, number[]]>; Dependencies?: number[] };
    if (lt.Types && Array.isArray(lt.Types) && lt.Types.length > 0) {
      const [zomeIndex, linkTypes] = lt.Types[0];
      if (Array.isArray(linkTypes) && linkTypes.length > 0) {
        // Encode as (zome_index << 8) | link_type for gateway query
        return (zomeIndex << 8) | linkTypes[0];
      }
    }
    // 'Dependencies' means all types from specified zomes, so leave undefined
  }
  return undefined;
}

/**
 * Process a single GetLinksInput and return the matching links
 */
function processGetLinksInput(
  input: WasmGetLinksInput,
  dnaHash: Uint8Array,
  agentPubKey: Uint8Array,
  cascade: Cascade,
  toBase64: (arr: Uint8Array) => string,
  inputIndex: number
): Link[] {
  // Validate DHT location of base_address
  const hash32 = input.base_address.slice(3, 35);
  const actualDhtLoc = input.base_address.slice(35, 39);
  const expectedDhtLoc = dhtLocationFrom32(hash32);
  const dhtLocValid = actualDhtLoc.every((b, i) => b === expectedDhtLoc[i]);

  console.log(`[get_links] Input ${inputIndex}: Getting links`, {
    base_hash: toBase64(input.base_address),
    base_prefix: Array.from(input.base_address.slice(0, 3)),
    actualDhtLoc: Array.from(actualDhtLoc),
    expectedDhtLoc: Array.from(expectedDhtLoc),
    dhtLocValid,
    linkType: JSON.stringify(input.link_type),
    tag_prefix: input.tag_prefix ? Array.from(input.tag_prefix) : null,
  });

  const linkTypeFilter = parseLinkTypeFilter(input.link_type);
  console.log(`[get_links] Input ${inputIndex}: Parsed linkTypeFilter:`, linkTypeFilter);

  // Try cascade: local → cache → network
  const networkLinks = cascade.fetchLinks(dnaHash, agentPubKey, input.base_address, linkTypeFilter);
  console.log(`[get_links] Input ${inputIndex}: Cascade returned:`, networkLinks.length, "links");

  // Filter by tag prefix if specified
  let filteredLinks = networkLinks;
  if (input.tag_prefix && input.tag_prefix.length > 0) {
    console.log(`[get_links] Input ${inputIndex}: Filtering by tag prefix, length:`, input.tag_prefix.length);
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
    console.log(`[get_links] Input ${inputIndex}: After tag filtering:`, filteredLinks.length, "links");
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

  // Log each link's target for debugging
  console.log(`[get_links] Input ${inputIndex}: Found links via cascade:`, links.length);
  for (let i = 0; i < links.length; i++) {
    try {
      const link = links[i];
      const targetB64 = toBase64(link.target);
      const targetPrefix = Array.from(link.target.slice(0, 3));
      const isTargetAgent = targetPrefix[0] === 132 && targetPrefix[1] === 32 && targetPrefix[2] === 36;

      console.log(`[get_links] Input ${inputIndex} Link ${i}:`, {
        target_b64: targetB64,
        target_prefix: targetPrefix,
        target_is_agent: isTargetAgent,
      });
    } catch (e) {
      console.error(`[get_links] Input ${inputIndex} Error logging link ${i}:`, e);
    }
  }

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

  // Log raw bytes from WASM memory before deserialization
  const memory = instance.exports.memory as WebAssembly.Memory;
  const rawBytes = new Uint8Array(memory.buffer, inputPtr, inputLen);
  console.log('[get_links] Raw WASM input bytes (first 100):', Array.from(rawBytes.slice(0, 100)));

  // Deserialize and validate input - it's an array of GetLinksInput objects
  const inputs = deserializeTypedFromWasm(
    instance, inputPtr, inputLen,
    validateWasmGetLinksInputArray, 'WasmGetLinksInput[]'
  );

  console.log('[get_links] Processing batch of', inputs.length, 'queries');

  // Convert to base64url for easier debugging (matches Holochain's hash display format)
  const toBase64 = (arr: Uint8Array) => {
    const base64 = btoa(String.fromCharCode(...arr));
    return 'u' + base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  const [dnaHash, agentPubKey] = callContext.cellId;

  // Create cascade for this lookup
  // Uses global network service if configured (MockNetworkService for testing, SyncXHRNetworkService for production)
  const cascade = new Cascade(storage, getNetworkCache(), getNetworkService());

  // Process ALL inputs and collect results
  // HDK expects Vec<Vec<Link>> - one Vec<Link> per input query
  const allResults: Link[][] = inputs.map((input, index) =>
    processGetLinksInput(input, dnaHash, agentPubKey, cascade, toBase64, index)
  );

  console.log('[get_links] Batch complete. Results per query:', allResults.map(r => r.length));

  return serializeResult(instance, allResults);
};
