/**
 * delete_link host function
 *
 * Deletes a link from the source chain.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";
import { SourceChainStorage } from "../../storage/source-chain-storage";
import type { DeleteLinkAction } from "../../storage/types";

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
  const storage = SourceChainStorage.getInstance();

  // Deserialize input
  const input = deserializeFromWasm(instance, inputPtr, inputLen) as DeleteLinkInput;

  console.log("[delete_link] Deleting link", {
    linkAddHash: Array.from(input.address.slice(0, 8)),
  });

  // Get the CreateLink action
  const createLinkActionResult = storage.getAction(input.address);
  if (createLinkActionResult instanceof Promise) {
    throw new Error("[delete_link] CreateLink action not in session cache - should have been pre-loaded");
  }

  const createLinkAction = createLinkActionResult;
  if (!createLinkAction || createLinkAction.actionType !== "CreateLink") {
    throw new Error("Link to delete not found or not a CreateLink action");
  }

  const [dnaHash, agentPubKey] = callContext.cellId;

  // Get current chain head from pre-loaded session cache
  const chainHeadResult = storage.getChainHead(dnaHash, agentPubKey);

  // Since we pre-loaded the chain, this should be synchronous (not a Promise)
  if (chainHeadResult instanceof Promise) {
    throw new Error('[delete_link] Chain head not in session cache - should have been pre-loaded');
  }

  const chainHead = chainHeadResult;

  // Increment sequence from chain head
  const actionSeq = chainHead ? chainHead.actionSeq + 1 : 3;
  const prevActionHash = chainHead ? chainHead.actionHash : null;
  const timestamp = BigInt(Date.now()) * 1000n;

  // Generate action hash
  const actionHash = new Uint8Array(39);
  crypto.getRandomValues(actionHash);
  actionHash[0] = 0x84;
  actionHash[1] = 0x29;
  actionHash[2] = 0x24;

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
