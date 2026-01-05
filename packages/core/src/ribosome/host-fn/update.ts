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
import { computeEntryHash, computeActionHash, type ActionForHashing, ActionType } from "../../hash";

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

  console.log("[update] Input:", {
    hasOriginalActionAddress: !!input.original_action_address,
    hasEntry: !!input.entry,
    entryType: input.entry.entry_type,
    chainTopOrdering: input.chain_top_ordering,
  });

  // Extract entry content from validated input
  const entryContent = input.entry.entry;

  // Get entry type from original action to maintain consistency
  // Or from manifest as fallback
  const manifest = callContext.dnaManifest;
  const currentZome = manifest?.integrity_zomes?.find(z => z.name === callContext.zome);
  const zomeIndex = currentZome?.index ?? 0;
  const entryDefIndex = 0; // Will be overridden from original action if available

  console.log("[update] Updating entry", {
    originalActionHash: Array.from(input.original_action_address.slice(0, 8)),
    entrySize: entryContent.length,
    zomeIndex,
    entryDefIndex,
  });

  // Hash the new entry content using Blake2b
  const entryHash = computeEntryHash(entryContent);

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
  const timestamp = BigInt(Date.now()) * 1000n;

  // Build action structure for hashing (before we know the hash)
  const actionForHashing: ActionForHashing = {
    type: ActionType.Update,
    author: agentPubKey,
    timestamp,
    action_seq: actionSeq,
    prev_action: prevActionHash,
    entry_type: {
      App: {
        zome_index: zomeIndex,
        entry_index: entryDefIndex,
        visibility: 'Public',
      }
    },
    entry_hash: entryHash,
    original_action_address: input.original_action_address,
    original_entry_address: originalEntryHash,
    weight: { bucket_id: 0, units: 0, rate_bytes: 0 },
  };

  // Compute action hash using Blake2b
  const actionHash = computeActionHash(actionForHashing);

  // Generate signature (TODO: use Lair in production)
  const signature = new Uint8Array(64);
  crypto.getRandomValues(signature);

  // Build Update action for storage
  const action: UpdateAction = {
    actionHash,
    actionSeq,
    author: agentPubKey,
    timestamp,
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
  storage.updateChainHead(dnaHash, agentPubKey, actionSeq, actionHash, timestamp);

  console.log("[update] Updated entry", {
    actionHash: Array.from(actionHash.slice(0, 8)),
    actionSeq,
    entryHash: Array.from(entryHash.slice(0, 8)),
  });

  return serializeResult(instance, actionHash);
};
