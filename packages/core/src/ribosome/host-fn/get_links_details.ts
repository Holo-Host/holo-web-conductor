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
import type { NetworkLink, CachedLinkDetail } from "../../network/types";
import type { Link as StoredLink } from "../../storage/types";
import type { LinkDetails, SignedActionHashed } from "../../types/holochain-types";
import { buildCreateLinkAction, buildDeleteLinkAction } from "../../types/holochain-serialization";
import { validateWasmGetLinksInputArray, type WasmGetLinksInput } from "../wasm-io-types";
import { hashFrom32AndType, HoloHashType } from "@holochain/client";
import { parseLinkTypeFilter } from "./get_links";
import { encodeHashToBase64 } from "../../types/holochain-types";

/** Zero-filled 39-byte ActionHash used as fallback when prev_action is unavailable */
const ZERO_ACTION_HASH = new Uint8Array(39);
// ActionHash prefix bytes
ZERO_ACTION_HASH[0] = 132;
ZERO_ACTION_HASH[1] = 41;
ZERO_ACTION_HASH[2] = 36;

/** Zero-filled 64-byte signature used as fallback when signature is unavailable */
const ZERO_SIGNATURE = new Uint8Array(64);

function ensureAgentPubKey(author: Uint8Array): Uint8Array {
  return author.length === 39
    ? author
    : hashFrom32AndType(author.slice(0, 32), HoloHashType.Agent);
}

/**
 * Build a SignedActionHashed for a CreateLink action from network link data.
 */
function buildCreateLinkSignedAction(link: NetworkLink): SignedActionHashed {
  const action = buildCreateLinkAction({
    author: ensureAgentPubKey(link.author),
    timestamp: typeof link.timestamp === 'bigint' ? Number(link.timestamp) : link.timestamp,
    action_seq: link.action_seq ?? 0,
    prev_action: link.prev_action ?? ZERO_ACTION_HASH,
    base_address: link.base,
    target_address: link.target,
    zome_index: link.zome_index,
    link_type: link.link_type,
    tag: link.tag,
    weight: link.weight,
  });

  return {
    hashed: {
      content: action,
      hash: link.create_link_hash,
    },
    signature: link.signature ?? ZERO_SIGNATURE,
  } as SignedActionHashed;
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
): SignedActionHashed {
  const action = buildDeleteLinkAction({
    author: ensureAgentPubKey(author),
    timestamp,
    action_seq: 0,
    prev_action: ZERO_ACTION_HASH,
    base_address: baseAddress,
    link_add_address: createLinkHash,
  });

  return {
    hashed: {
      content: action,
      hash: deleteHash,
    },
    signature: ZERO_SIGNATURE,
  } as SignedActionHashed;
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
): LinkDetails {
  console.log(`[get_links_details] Input ${inputIndex}: Getting link details`, {
    base_hash: encodeHashToBase64(input.base_address),
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
    const key = encodeHashToBase64(ll.createLinkHash);
    localLinkMap.set(key, ll);
  }

  // Check cache for prior delete info to merge (monotonically growing)
  const cache = getNetworkCache();
  const cachedDetails = cache.getLinkDetailsSync(input.base_address, linkTypeFilter.linkType);
  const cachedDeleteMap = new Map<string, Uint8Array[]>();
  if (cachedDetails) {
    for (const d of cachedDetails) {
      if (d.deleteHashes.length > 0) {
        cachedDeleteMap.set(encodeHashToBase64(d.create.create_link_hash), d.deleteHashes);
      }
    }
  }

  // Collect merged link details for caching
  const detailsForCache: CachedLinkDetail[] = [];

  // Build LinkDetails tuples: (CreateLink SignedActionHashed, [DeleteLink SignedActionHashed])
  const details: LinkDetails = filteredLinks.map(link => {
    const createAction = buildCreateLinkSignedAction(link);
    const linkKey = encodeHashToBase64(link.create_link_hash);
    const timestamp = typeof link.timestamp === 'bigint' ? Number(link.timestamp) : link.timestamp;

    const deleteHashes: Uint8Array[] = [];
    const deletes: SignedActionHashed[] = [];

    // Local storage deletes
    const localLink = localLinkMap.get(encodeHashToBase64(link.create_link_hash));
    if (localLink?.deleted && localLink.deleteHash) {
      deleteHashes.push(localLink.deleteHash);
      deletes.push(buildDeleteLinkSignedAction(
        localLink.deleteHash, link.create_link_hash, link.base, link.author, timestamp,
      ));
    }

    // Cached deletes (merge any not already present)
    const cachedDeletes = cachedDeleteMap.get(linkKey);
    if (cachedDeletes) {
      for (const dh of cachedDeletes) {
        const already = deleteHashes.some(
          h => h.length === dh.length && h.every((b, i) => b === dh[i])
        );
        if (!already) {
          deleteHashes.push(dh);
          deletes.push(buildDeleteLinkSignedAction(
            dh, link.create_link_hash, link.base, link.author, timestamp,
          ));
        }
      }
    }

    detailsForCache.push({ create: link, deleteHashes });
    return [createAction, deletes];
  });

  // Include cached creates no longer in network results (deleted network-wide)
  if (cachedDetails) {
    for (const d of cachedDetails) {
      const key = encodeHashToBase64(d.create.create_link_hash);
      const inResults = detailsForCache.some(
        dc => encodeHashToBase64(dc.create.create_link_hash) === key
      );
      if (!inResults) {
        detailsForCache.push(d);
        const timestamp = typeof d.create.timestamp === 'bigint'
          ? Number(d.create.timestamp) : d.create.timestamp;
        const createAction = buildCreateLinkSignedAction(d.create);
        const deletes: SignedActionHashed[] = d.deleteHashes.map(dh =>
          buildDeleteLinkSignedAction(
            dh, d.create.create_link_hash, d.create.base, d.create.author, timestamp,
          )
        );
        details.push([createAction, deletes]);
      }
    }
  }

  // Cache the merged link details (only grows over time)
  cache.cacheLinkDetailsSync(input.base_address, detailsForCache, linkTypeFilter.linkType);

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
