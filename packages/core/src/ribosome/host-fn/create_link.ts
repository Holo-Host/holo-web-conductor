/**
 * create_link host function
 *
 * Creates a link between two entries with full persistence.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";
import { getStorageProvider } from "../../storage/storage-provider";
import type { CreateLinkAction, Link } from "../../storage/types";
import { computeActionHashV2, serializeAction } from "../../hash";
import { buildCreateLinkAction } from "../../types/holochain-serialization";
import { signAction } from "../../signing";

/**
 * Create link input structure (matches Holochain HDK CreateLinkInput)
 *
 * Reference: holochain/crates/holochain_zome_types/src/link.rs
 *
 * pub struct CreateLinkInput {
 *     pub base_address: AnyLinkableHash,
 *     pub target_address: AnyLinkableHash,
 *     pub zome_index: ZomeIndex,  // u8 newtype
 *     pub link_type: LinkType,    // u8 newtype
 *     pub tag: LinkTag,
 *     pub chain_top_ordering: ChainTopOrdering,
 * }
 */
interface CreateLinkInput {
  /** Base address (entry or action hash) */
  base_address: Uint8Array;

  /** Target address (entry or action hash) */
  target_address: Uint8Array;

  /** Zome index (ZomeIndex newtype serializes as u8) */
  zome_index: number;

  /** Link type (LinkType newtype serializes as u8) */
  link_type: number;

  /** Link tag (LinkTag - binary data) */
  tag: Uint8Array;

  /** Chain ordering (optional, defaults to Strict) */
  chain_top_ordering?: "Strict" | "Relaxed";
}

/**
 * create_link host function implementation
 *
 * Stores link and action in source chain storage.
 * All operations are queued in transaction and committed by ribosome.
 */
export const createLink: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;
  const storage = getStorageProvider();

  // Deserialize input
  const input = deserializeFromWasm(instance, inputPtr, inputLen) as CreateLinkInput;

  const [dnaHash, agentPubKey] = callContext.cellId;

  // Read link type and zome index directly from input
  // (they are separate fields in CreateLinkInput, not combined)
  const linkType = input.link_type;
  const zomeIndex = input.zome_index;

  // Get current chain head
  const chainHead = storage.getChainHead(dnaHash, agentPubKey);

  // Increment sequence from chain head, or start at 3 for new chain
  const actionSeq = chainHead ? chainHead.actionSeq + 1 : 3;
  const prevActionHash = chainHead ? chainHead.actionHash : null;
  const timestampMicros = Date.now() * 1000; // Microseconds as number for serialization
  const timestampBigInt = BigInt(timestampMicros); // BigInt for storage

  // Build action using type-safe builder (ensures correct field ordering for serialization)
  const tag = input.tag;
  const serializableAction = buildCreateLinkAction({
    author: agentPubKey,
    timestamp: timestampMicros,
    action_seq: actionSeq,
    prev_action: prevActionHash!,
    base_address: input.base_address,
    target_address: input.target_address,
    zome_index: zomeIndex,
    link_type: linkType,
    tag,
    weight: { bucket_id: 0, units: 0 },  // RateWeight (not EntryRateWeight)
  });

  // Serialize action for both hashing and signing (same bytes)
  const serializedAction = serializeAction(serializableAction);

  // Compute action hash using Blake2b on serialized bytes
  const actionHash = computeActionHashV2(serializableAction);

  // Sign the serialized action bytes (NOT the hash - Holochain signs the Action struct)
  const signature = signAction(agentPubKey, serializedAction);

  // Build CreateLink action for storage (uses BigInt timestamp)
  const action: CreateLinkAction = {
    actionHash,
    actionSeq,
    author: agentPubKey,
    timestamp: timestampBigInt,
    prevActionHash,
    actionType: 'CreateLink',
    signature,
    baseAddress: input.base_address,
    targetAddress: input.target_address,
    zomeIndex,
    linkType,
    tag,
  };

  // Build link record (uses BigInt timestamp)
  const link: Link = {
    createLinkHash: actionHash,
    baseAddress: input.base_address,
    targetAddress: input.target_address,
    timestamp: timestampBigInt,
    zomeIndex,
    linkType,
    tag: input.tag,
    author: agentPubKey,
    deleted: false,
  };

  // These are synchronous when transaction is active (just buffer in memory)
  storage.putAction(action, dnaHash, agentPubKey);
  storage.putLink(link, dnaHash, agentPubKey);
  storage.updateChainHead(dnaHash, agentPubKey, actionSeq, actionHash, timestampBigInt);

  // Queue optimistic cache merge -- applied after transaction commits successfully
  if (!callContext.pendingCacheOps) {
    callContext.pendingCacheOps = [];
  }
  const networkLink = {
    create_link_hash: actionHash,
    base: input.base_address,
    target: input.target_address,
    zome_index: zomeIndex,
    link_type: linkType,
    tag: input.tag,
    timestamp: timestampMicros,
    author: agentPubKey,
  };

  callContext.pendingCacheOps.push({
    type: 'mergeLink',
    baseAddress: input.base_address,
    link: networkLink,
  });

  callContext.pendingCacheOps.push({
    type: 'mergeLinkDetail',
    baseAddress: input.base_address,
    link: networkLink,
  });

  // Track record for publishing after transaction commits (no entry for links)
  if (!callContext.pendingRecords) {
    callContext.pendingRecords = [];
  }
  callContext.pendingRecords.push({ action });

  return serializeResult(instance, actionHash);
};
