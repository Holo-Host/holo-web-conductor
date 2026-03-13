/**
 * delete_link host function
 *
 * Deletes a link from the source chain.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";
import { getStorageProvider } from "../../storage/storage-provider";
import type { DeleteLinkAction } from "../../storage/types";
import { computeActionHashV2, serializeAction } from "../../hash";
import { buildDeleteLinkAction } from "../../types/holochain-serialization";
import { signAction } from "../../signing";

/**
 * Delete link input structure
 */
interface DeleteLinkInput {
  /** Hash of the create link action to delete */
  address: Uint8Array;
}

/**
 * delete_link host function implementation
 *
 * Creates a DeleteLink action on the source chain and marks the link as deleted.
 */
export const deleteLink: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { instance, callContext } = context;
  const storage = getStorageProvider();

  // Deserialize input
  const input = deserializeFromWasm(instance, inputPtr, inputLen) as DeleteLinkInput;

  console.log("[delete_link] Deleting link", {
    linkAddHash: Array.from(input.address.slice(0, 8)),
  });

  // Get the CreateLink action
  const createLinkAction = storage.getAction(input.address);
  if (!createLinkAction || createLinkAction.actionType !== "CreateLink") {
    throw new Error("Link to delete not found or not a CreateLink action");
  }

  const [dnaHash, agentPubKey] = callContext.cellId;

  // Get current chain head
  const chainHead = storage.getChainHead(dnaHash, agentPubKey);

  // Increment sequence from chain head
  const actionSeq = chainHead ? chainHead.actionSeq + 1 : 3;
  const prevActionHash = chainHead ? chainHead.actionHash : null;
  const timestampMicros = Date.now() * 1000; // Microseconds as number for serialization
  const timestampBigInt = BigInt(timestampMicros); // BigInt for storage

  // Build action using type-safe builder (ensures correct field ordering for serialization)
  const serializableAction = buildDeleteLinkAction({
    author: agentPubKey,
    timestamp: timestampMicros,
    action_seq: actionSeq,
    prev_action: prevActionHash!,
    base_address: createLinkAction.baseAddress,
    link_add_address: input.address,
  });

  // Serialize action for both hashing and signing (same bytes)
  const serializedAction = serializeAction(serializableAction);

  // Compute action hash using Blake2b on serialized bytes
  const actionHash = computeActionHashV2(serializableAction);

  // Sign the serialized action bytes (NOT the hash - Holochain signs the Action struct)
  const signature = signAction(agentPubKey, serializedAction);

  // Build DeleteLink action for storage (uses BigInt timestamp)
  const action: DeleteLinkAction = {
    actionHash,
    actionSeq,
    author: agentPubKey,
    timestamp: timestampBigInt,
    prevActionHash,
    actionType: "DeleteLink",
    signature,
    linkAddAddress: input.address,
    baseAddress: createLinkAction.baseAddress,
  };

  // Store action and mark link as deleted (synchronous during transaction)
  storage.putAction(action, dnaHash, agentPubKey);
  storage.deleteLink(input.address, actionHash);
  storage.updateChainHead(dnaHash, agentPubKey, actionSeq, actionHash, timestampBigInt);

  // Queue optimistic cache remove -- applied after transaction commits successfully
  if (!callContext.pendingCacheOps) {
    callContext.pendingCacheOps = [];
  }
  callContext.pendingCacheOps.push({
    type: 'removeLink',
    baseAddress: createLinkAction.baseAddress,
    createLinkHash: input.address,
  });

  callContext.pendingCacheOps.push({
    type: 'addDeleteToLinkDetails',
    baseAddress: createLinkAction.baseAddress,
    createLinkHash: input.address,
    deleteHash: actionHash,
  });

  // Track record for publishing after transaction commits (no entry for delete_link)
  if (!callContext.pendingRecords) {
    callContext.pendingRecords = [];
  }
  callContext.pendingRecords.push({ action });

  console.log("[delete_link] Deleted link", {
    actionHash: Array.from(actionHash.slice(0, 8)),
    actionSeq,
  });

  return serializeResult(instance, actionHash);
};
