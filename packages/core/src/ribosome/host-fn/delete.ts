/**
 * delete host function (actually "delete_entry" in Holochain)
 *
 * Marks an entry as deleted on the source chain.
 */

import { HostFunctionImpl } from "./base";
import { deserializeTypedFromWasm, serializeResult } from "../serialization";
import { getStorageProvider } from "../../storage/storage-provider";
import { isEntryAction, type DeleteAction, type ChainHead } from "../../storage/types";
import { validateWasmDeleteInput } from "../wasm-io-types";
import { hashFrom32AndType, HoloHashType } from "@holochain/client";

/**
 * delete host function implementation
 *
 * Creates a Delete action that marks an entry as deleted.
 */
export const deleteEntry: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;
  const storage = getStorageProvider();

  // Deserialize and validate input
  const input = deserializeTypedFromWasm(
    instance, inputPtr, inputLen,
    validateWasmDeleteInput, 'WasmDeleteInput'
  );

  console.log("[delete] Deleting entry", {
    deletesActionHash: Array.from(input.deletes_action_hash.slice(0, 8)),
  });

  // Get action being deleted
  const deletesAction = storage.getAction(input.deletes_action_hash);
  if (!deletesAction || !isEntryAction(deletesAction)) {
    throw new Error("Action to delete not found or not an entry-creating action");
  }

  const deletesEntryHash = deletesAction.entryHash;

  const [dnaHash, agentPubKey] = callContext.cellId;
  const chainHead = storage.getChainHead(dnaHash, agentPubKey);

  const actionSeq = chainHead ? chainHead.actionSeq + 1 : 3;
  const prevActionHash = chainHead ? chainHead.actionHash : null;
  const timestamp = BigInt(Date.now()) * 1000n;

  // Generate action hash using @holochain/client utility
  // TODO Step 7+: Use proper action hash computation
  const actionHash = hashFrom32AndType(
    crypto.getRandomValues(new Uint8Array(32)),
    HoloHashType.Action
  );

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
