/**
 * get_links_details host function
 *
 * Returns detailed link information including the full SignedActionHashed
 * for each CreateLink and any associated DeleteLink actions.
 *
 * Input: Vec<GetLinksInput> (same as get_links)
 * Output: Vec<LinkDetails>
 *   where LinkDetails = Vec<(SignedActionHashed, Vec<SignedActionHashed>)>
 *   Each tuple is (CreateLink action, [DeleteLink actions for that link])
 *
 * Uses the same Cascade pattern as get_links:
 *   Local storage → Network cache → Network
 */

import { HostFunctionImpl } from "./base";
import { deserializeTypedFromWasm, serializeResult } from "../serialization";
import { getStorageProvider } from "../../storage/storage-provider";
import { Cascade, getNetworkCache, getNetworkService } from "../../network";
import type { NetworkLink } from "../../network/types";
import type { Link as StoredLink } from "../../storage/types";
import { validateWasmGetLinksInputArray, type WasmGetLinksInput } from "../wasm-io-types";
import { hashFrom32AndType, HoloHashType, ActionType, dhtLocationFrom32 } from "@holochain/client";
import { parseLinkTypeFilter } from "./get_links";

// Helper to convert to base64url for logging
const toBase64 = (arr: Uint8Array) => {
  const base64 = btoa(String.fromCharCode(...arr));
  return 'u' + base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/**
 * Build a SignedActionHashed for a CreateLink action from link data.
 *
 * For network-sourced links we don't have the full action, so we
 * construct a synthetic one from the available fields.
 */
function buildCreateLinkSignedAction(link: NetworkLink): any {
  const authorPrefixed = link.author.length === 39
    ? link.author
    : hashFrom32AndType(link.author.slice(0, 32), HoloHashType.Agent);

  const action = {
    type: ActionType.CreateLink,
    author: authorPrefixed,
    timestamp: typeof link.timestamp === 'bigint' ? Number(link.timestamp) : link.timestamp,
    action_seq: 0,
    base_address: link.base,
    target_address: link.target,
    zome_index: link.zome_index,
    link_type: link.link_type,
    tag: link.tag,
    weight: { bucket_id: 0, units: 0 },
  };

  return {
    hashed: {
      content: action,
      hash: link.create_link_hash,
    },
    signature: new Uint8Array(64),
  };
}

/**
 * Build a SignedActionHashed for a DeleteLink action.
 *
 * For locally stored links that have been deleted, we have the
 * deleteHash but not the full delete action. Construct a synthetic one.
 */
function buildDeleteLinkSignedAction(
  deleteHash: Uint8Array,
  createLinkHash: Uint8Array,
  baseAddress: Uint8Array,
  author: Uint8Array,
  timestamp: number
): any {
  const authorPrefixed = author.length === 39
    ? author
    : hashFrom32AndType(author.slice(0, 32), HoloHashType.Agent);

  const action = {
    type: ActionType.DeleteLink,
    author: authorPrefixed,
    timestamp,
    action_seq: 0,
    link_add_address: createLinkHash,
    base_address: baseAddress,
  };

  return {
    hashed: {
      content: action,
      hash: deleteHash,
    },
    signature: new Uint8Array(64),
  };
}

/**
 * Process a single GetLinksInput and return LinkDetails
 *
 * LinkDetails = Vec<(SignedActionHashed, Vec<SignedActionHashed>)>
 */
function processGetLinksDetailsInput(
  input: WasmGetLinksInput,
  dnaHash: Uint8Array,
  agentPubKey: Uint8Array,
  cascade: Cascade,
  storage: ReturnType<typeof getStorageProvider>,
  inputIndex: number
): Array<[any, any[]]> {
  console.log(`[get_links_details] Input ${inputIndex}: Getting link details`, {
    base_hash: toBase64(input.base_address),
    linkType: JSON.stringify(input.link_type),
    tag_prefix: input.tag_prefix ? Array.from(input.tag_prefix) : null,
  });

  const linkTypeFilter = parseLinkTypeFilter(input.link_type);

  // Fetch links via cascade (same as get_links)
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

  console.log(`[get_links_details] Input ${inputIndex}: Found ${filteredLinks.length} links`);

  // Also get local links to check for delete info
  const localLinks = storage.getLinks(input.base_address, dnaHash, agentPubKey, linkTypeFilter.linkType);

  // Build a map of create_link_hash -> StoredLink for delete lookup
  const localLinkMap = new Map<string, StoredLink>();
  for (const ll of localLinks) {
    const key = toBase64(ll.createLinkHash);
    localLinkMap.set(key, ll);
  }

  // Build LinkDetails tuples: (CreateLink SignedActionHashed, [DeleteLink SignedActionHashed])
  const details: Array<[any, any[]]> = filteredLinks.map(link => {
    const createAction = buildCreateLinkSignedAction(link);

    // Check if this link has been deleted (from local storage)
    const localLink = localLinkMap.get(toBase64(link.create_link_hash));
    const deletes: any[] = [];

    if (localLink?.deleted && localLink.deleteHash) {
      deletes.push(buildDeleteLinkSignedAction(
        localLink.deleteHash,
        link.create_link_hash,
        link.base,
        link.author,
        typeof link.timestamp === 'bigint' ? Number(link.timestamp) : link.timestamp,
      ));
    }

    return [createAction, deletes];
  });

  return details;
}

/**
 * get_links_details host function implementation
 *
 * Uses same Cascade pattern as get_links but returns full action details.
 * Handles batch queries — processes ALL inputs and returns Vec<LinkDetails>.
 */
export const getLinksDetails: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;
  const storage = getStorageProvider();

  // Deserialize and validate input — same as get_links
  const inputs = deserializeTypedFromWasm(
    instance, inputPtr, inputLen,
    validateWasmGetLinksInputArray, 'WasmGetLinksInput[]'
  );

  console.log('[get_links_details] Processing batch of', inputs.length, 'queries');

  const [dnaHash, agentPubKey] = callContext.cellId;

  const cascade = new Cascade(storage, getNetworkCache(), getNetworkService());

  // Process ALL inputs and collect results
  // HDK expects Vec<LinkDetails> — one LinkDetails per input query
  const allResults = inputs.map((input, index) =>
    processGetLinksDetailsInput(input, dnaHash, agentPubKey, cascade, storage, index)
  );

  console.log('[get_links_details] Batch complete. Results per query:', allResults.map(r => r.length));

  return serializeResult(instance, allResults);
};
