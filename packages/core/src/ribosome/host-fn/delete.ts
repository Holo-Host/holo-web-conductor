/**
 * delete host function (actually "delete_entry" in Holochain)
 *
 * Marks an entry as deleted on the source chain.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";
import { SourceChainStorage } from "../../storage/source-chain-storage";
import type { DeleteAction } from "../../storage/types";

/**
 * Delete input structure
 */
interface DeleteInput {
  /** Hash of the action to delete (not entry hash) */
  deletes_action_hash: Uint8Array;
}

/**
 * delete host function implementation
 *
 * Creates a Delete action that marks an entry as deleted.
 */
export const deleteEntry: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;
  const storage = SourceChainStorage.getInstance();

  // Deserialize input
  const input = deserializeFromWasm(instance, inputPtr, inputLen) as DeleteInput;

  console.log("[delete] Deleting entry", {
    deletesActionHash: Array.from(input.deletes_action_hash.slice(0, 8)),
  });

  // Get action being deleted
  const deletesActionResult = storage.getAction(input.deletes_action_hash);
  if (deletesActionResult instanceof Promise) {
    console.error("[delete] Action to delete not in session cache");
    throw new Error("Action to delete not found - must be in session cache");
  }

  const deletesAction = deletesActionResult;
  if (!deletesAction || (deletesAction.actionType !== "Create" && deletesAction.actionType !== "Update")) {
    throw new Error("Action to delete not found or not an entry-creating action");
  }

  const deletesEntryHash = (deletesAction as any).entryHash;

  const [dnaHash, agentPubKey] = callContext.cellId;
  const chainHeadResult = storage.getChainHead(dnaHash, agentPubKey);

  let chainHead: any;
  if (chainHeadResult instanceof Promise) {
    console.error("[delete] Chain head not in session cache");
    throw new Error("Chain head not in session cache");
  }
  chainHead = chainHeadResult;

  const actionSeq = chainHead ? chainHead.actionSeq + 1 : 3;
  const prevActionHash = chainHead ? chainHead.actionHash : null;
  const timestamp = BigInt(Date.now()) * 1000n;

  // Generate action hash (simplified - should use proper hash in production)
  const actionHash = new Uint8Array(39);
  crypto.getRandomValues(actionHash);
  actionHash[0] = 0x84;
  actionHash[1] = 0x29;
  actionHash[2] = 0x24;

  // Generate signature (mock - should use Lair in production)
  const signature = new Uint8Array(64);
  crypto.getRandomValues(signature);

  // Build Delete action
  const action: DeleteAction = {
    actionHash,
    actionSeq,
    author: agentPubKey,
    timestamp,
    prevActionHash,
    actionType: "Delete",
    signature,
    deletesActionHash: input.deletes_action_hash,
    deletesEntryHash,
  };

  storage.putAction(action, dnaHash, agentPubKey);
  storage.updateChainHead(dnaHash, agentPubKey, actionSeq, actionHash, timestamp);

  console.log("[delete] Deleted entry", {
    actionHash: Array.from(actionHash.slice(0, 8)),
    actionSeq,
  });

  return serializeResult(instance, actionHash);
};
