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

  // Hash the new entry content (simple deterministic hash)
  const entryHash = new Uint8Array(39);
  let hashValue = 0;
  for (let i = 0; i < entryContent.length; i++) {
    hashValue = ((hashValue << 5) - hashValue + entryContent[i]) | 0;
  }
  const view = new DataView(entryHash.buffer);
  for (let i = 0; i < 8; i++) {
    view.setUint32(i * 4 + 3, hashValue ^ i, false);
  }
  entryHash[0] = 0x84;
  entryHash[1] = 0x21;
  entryHash[2] = 0x24;

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

  // Generate action hash (simplified - should use proper hash in production)
  const actionHash = new Uint8Array(39);
  crypto.getRandomValues(actionHash);
  actionHash[0] = 0x84;
  actionHash[1] = 0x29;
  actionHash[2] = 0x24;

  // Generate signature (mock - should use Lair in production)
  const signature = new Uint8Array(64);
  crypto.getRandomValues(signature);

  // Build Update action
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
