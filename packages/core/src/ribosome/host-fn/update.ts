/**
 * update host function
 *
 * Updates an existing entry on the source chain.
 */

import { HostFunctionImpl } from "./base";
import { deserializeTypedFromWasm, serializeResult } from "../serialization";
import { getStorageProvider } from "../../storage/storage-provider";
import { isEntryAction, type UpdateAction, type StoredEntry, type ChainHead } from "../../storage/types";
import { validateWasmUpdateInput } from "../wasm-io-types";
import { computeAppEntryHash, computeActionHashV2, serializeAction } from "../../hash";
import { buildUpdateAction, buildAppEntryType } from "../../types/holochain-serialization";
import { signAction } from "../../signing";

/**
 * update host function implementation
 *
 * Creates an Update action and stores the new entry content.
 */
export const update: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;
  const storage = getStorageProvider();

  // Deserialize and validate input
  const input = deserializeTypedFromWasm(
    instance, inputPtr, inputLen,
    validateWasmUpdateInput, 'WasmUpdateInput'
  );

  // Extract entry content from validated input
  const entryContent = input.entry.entry;

  // Get entry type from original action to maintain consistency
  // Or from manifest as fallback
  const manifest = callContext.dnaManifest;
  const currentZome = manifest?.integrity_zomes?.find(z => z.name === callContext.zome);
  const zomeIndex = currentZome?.index ?? 0;
  const entryDefIndex = 0; // Will be overridden from original action if available

  // Hash the new entry - App entries hash the serialized Entry enum { entry_type: "App", entry: content }
  const entryHash = computeAppEntryHash(entryContent);

  // Get original action to retrieve original entry hash
  const originalAction = storage.getAction(input.original_action_address);
  if (!originalAction || !isEntryAction(originalAction)) {
    throw new Error("Original action not found or not an entry-creating action");
  }

  const originalEntryHash = originalAction.entryHash;

  const [dnaHash, agentPubKey] = callContext.cellId;
  const chainHead = storage.getChainHead(dnaHash, agentPubKey);

  const actionSeq = chainHead ? chainHead.actionSeq + 1 : 3;
  const prevActionHash = chainHead ? chainHead.actionHash : null;
  const timestampMicros = Date.now() * 1000; // Microseconds as number for serialization
  const timestampBigInt = BigInt(timestampMicros); // BigInt for storage

  // Build serializable entry type for action
  const serializableEntryType = buildAppEntryType({
    entry_index: entryDefIndex,
    zome_index: zomeIndex,
    visibility: "Public",
  });

  // Build action using type-safe builder (ensures correct field ordering for serialization)
  const serializableAction = buildUpdateAction({
    author: agentPubKey,
    timestamp: timestampMicros,
    action_seq: actionSeq,
    prev_action: prevActionHash!,
    original_action_address: input.original_action_address,
    original_entry_address: originalEntryHash,
    entry_type: serializableEntryType,
    entry_hash: entryHash,
    weight: { bucket_id: 0, units: 0, rate_bytes: 0 },
  });

  // Serialize action for both hashing and signing (same bytes)
  const serializedAction = serializeAction(serializableAction);

  // Compute action hash using Blake2b on serialized bytes
  const actionHash = computeActionHashV2(serializableAction);

  // Sign the serialized action bytes (NOT the hash - Holochain signs the Action struct)
  const signature = signAction(agentPubKey, serializedAction);

  // Build Update action for storage (uses BigInt timestamp)
  const action: UpdateAction = {
    actionHash,
    actionSeq,
    author: agentPubKey,
    timestamp: timestampBigInt,
    prevActionHash,
    actionType: "Update",
    signature,
    entryHash,
    entryType: {
      zome_id: zomeIndex,
      entry_index: entryDefIndex,
    },
    originalActionHash: input.original_action_address,
    originalEntryHash,
  };

  // Store new entry content
  const entry: StoredEntry = {
    entryHash,
    entryContent: entryContent,
    entryType: {
      zome_id: zomeIndex,
      entry_index: entryDefIndex,
    },
  };

  storage.putEntry(entry, dnaHash, agentPubKey);
  storage.putAction(action, dnaHash, agentPubKey);
  storage.updateChainHead(dnaHash, agentPubKey, actionSeq, actionHash, timestampBigInt);

  // Track record for publishing after transaction commits
  if (!callContext.pendingRecords) {
    callContext.pendingRecords = [];
  }
  callContext.pendingRecords.push({ action, entry });

  return serializeResult(instance, actionHash);
};
