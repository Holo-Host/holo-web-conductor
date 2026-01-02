/**
 * create_link host function
 *
 * Creates a link between two entries with full persistence.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";
import { getStorageProvider } from "../../storage/storage-provider";
import type { CreateLinkAction, Link } from "../../storage/types";

/**
 * Create link input structure (matches Holochain HDK CreateLinkInput)
 */
interface CreateLinkInput {
  /** Base address (entry or action hash) */
  base_address: Uint8Array;

  /** Target address (entry or action hash) */
  target_address: Uint8Array;

  /** Link type */
  link_type: number | { App: { id: number; zome_id: number } };

  /** Optional link tag (arbitrary bytes) */
  tag?: Uint8Array;
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

  console.log("[create_link] Creating link", {
    base: Array.from(input.base_address.slice(0, 8)),
    target: Array.from(input.target_address.slice(0, 8)),
    linkType: input.link_type,
  });

  const [dnaHash, agentPubKey] = callContext.cellId;

  // Parse link type
  const linkType = typeof input.link_type === 'number'
    ? input.link_type
    : input.link_type.App.id;
  const zomeIndex = typeof input.link_type === 'number'
    ? 0 // Default zome index if not specified
    : input.link_type.App.zome_id;

  // Get current chain head
  const chainHead = storage.getChainHead(dnaHash, agentPubKey);

  // Increment sequence from chain head, or start at 3 for new chain
  const actionSeq = chainHead ? chainHead.actionSeq + 1 : 3;
  const prevActionHash = chainHead ? chainHead.actionHash : null;
  const timestamp = BigInt(Date.now()) * 1000n; // Microseconds

  // Create action hash (39 bytes)
  // TODO Step 7+: Use proper action hash computation
  const actionHash = new Uint8Array(39);
  actionHash.set([132, 41, 36], 0); // ACTION_PREFIX
  const randomHash = new Uint8Array(32);
  crypto.getRandomValues(randomHash);
  actionHash.set(randomHash, 3);
  actionHash.set([0, 0, 0, 0], 35); // location (all zeros)

  // Create signature (64 bytes)
  // TODO Step 7+: Use Lair keystore for real signing
  const signature = new Uint8Array(64);
  crypto.getRandomValues(signature);

  // Build CreateLink action
  const action: CreateLinkAction = {
    actionHash,
    actionSeq,
    author: agentPubKey,
    timestamp,
    prevActionHash,
    actionType: 'CreateLink',
    signature,
    baseAddress: input.base_address,
    targetAddress: input.target_address,
    zomeIndex,
    linkType,
    tag: input.tag || new Uint8Array(0),
  };

  // Build link record
  const link: Link = {
    createLinkHash: actionHash,
    baseAddress: input.base_address,
    targetAddress: input.target_address,
    timestamp,
    zomeIndex,
    linkType,
    tag: input.tag || new Uint8Array(0),
    author: agentPubKey,
    deleted: false,
  };

  // These are synchronous when transaction is active (just buffer in memory)
  storage.putAction(action, dnaHash, agentPubKey);
  storage.putLink(link, dnaHash, agentPubKey);
  storage.updateChainHead(dnaHash, agentPubKey, actionSeq, actionHash, timestamp);

  console.log('[create_link] Created link', {
    actionHash: Array.from(actionHash.slice(0, 8)),
    actionSeq,
  });

  return serializeResult(instance, actionHash);
};
