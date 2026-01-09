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
import { computeActionHashV2, serializeAction } from "../../hash";
import { buildDeleteAction } from "../../types/holochain-serialization";
import { signAction } from "../../signing";

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
  const timestampMicros = Date.now() * 1000; // Microseconds as number for serialization
  const timestampBigInt = BigInt(timestampMicros); // BigInt for storage

  // Build action using type-safe builder (ensures correct field ordering for serialization)
  const serializableAction = buildDeleteAction({
    author: agentPubKey,
    timestamp: timestampMicros,
    action_seq: actionSeq,
    prev_action: prevActionHash!,
    deletes_address: input.deletes_action_hash,
    deletes_entry_address: deletesEntryHash,
    weight: { bucket_id: 0, units: 0 },
  });

  // Serialize action for both hashing and signing (same bytes)
  const serializedAction = serializeAction(serializableAction);

  // Compute action hash using Blake2b on serialized bytes
  const actionHash = computeActionHashV2(serializableAction);

  // Sign the serialized action bytes (NOT the hash - Holochain signs the Action struct)
  const signature = signAction(agentPubKey, serializedAction);

  // Build Delete action for storage (uses BigInt timestamp)
  const action: DeleteAction = {
    actionHash,
    actionSeq,
    author: agentPubKey,
    timestamp: timestampBigInt,
    prevActionHash,
    actionType: "Delete",
    signature,
    deletesActionHash: input.deletes_action_hash,
    deletesEntryHash,
  };

  storage.putAction(action, dnaHash, agentPubKey);
  storage.updateChainHead(dnaHash, agentPubKey, actionSeq, actionHash, timestampBigInt);

  // Track record for publishing after transaction commits (no entry for delete)
  if (!callContext.pendingRecords) {
    callContext.pendingRecords = [];
  }
  callContext.pendingRecords.push({ action });

  console.log("[delete] Deleted entry", {
    actionHash: Array.from(actionHash.slice(0, 8)),
    actionSeq,
  });

  return serializeResult(instance, actionHash);
};
