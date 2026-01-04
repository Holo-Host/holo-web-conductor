/**
 * delete_link host function
 *
 * Deletes a link from the source chain.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";
import { getStorageProvider } from "../../storage/storage-provider";
import type { DeleteLinkAction } from "../../storage/types";
import { hashFrom32AndType, HoloHashType } from "@holochain/client";

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
  const timestamp = BigInt(Date.now()) * 1000n;

  // Generate action hash using @holochain/client utility
  const actionHash = hashFrom32AndType(
    crypto.getRandomValues(new Uint8Array(32)),
    HoloHashType.Action
  );

  // Generate signature (mock - should use Lair in production)
  const signature = new Uint8Array(64);
  crypto.getRandomValues(signature);

  // Build DeleteLink action
  const action: DeleteLinkAction = {
    actionHash,
    actionSeq,
    author: agentPubKey,
    timestamp,
    prevActionHash,
    actionType: "DeleteLink",
    signature,
    linkAddAddress: input.address,
    baseAddress: createLinkAction.baseAddress,
  };

  // Store action and mark link as deleted (synchronous during transaction)
  storage.putAction(action, dnaHash, agentPubKey);
  storage.deleteLink(input.address, actionHash);
  storage.updateChainHead(dnaHash, agentPubKey, actionSeq, actionHash, timestamp);

  console.log("[delete_link] Deleted link", {
    actionHash: Array.from(actionHash.slice(0, 8)),
    actionSeq,
  });

  return serializeResult(instance, actionHash);
};
