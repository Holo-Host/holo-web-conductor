/**
 * update host function
 *
 * Updates an existing entry on the source chain.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";
import { SourceChainStorage } from "../../storage/source-chain-storage";
import type { UpdateAction, StoredEntry } from "../../storage/types";

/**
 * Update input structure (matches Holochain HDK UpdateInput)
 */
interface UpdateInput {
  /** Original action address to update */
  original_action_address: Uint8Array;

  /** Entry location (zome and entry def index) */
  entry_location: {
    App: {
      zome_index: number;
      entry_def_index: number;
    };
  };

  /** Entry wrapper with type and content */
  entry: {
    entry_type: 'App' | 'Agent' | 'CapClaim' | 'CapGrant';
    entry: Uint8Array;  // MessagePack-serialized entry content
  };

  /** Entry visibility */
  entry_visibility: 'Public' | 'Private';

  /** Chain top ordering */
  chain_top_ordering: 'Strict' | 'Relaxed';
}

/**
 * update host function implementation
 *
 * Creates an Update action and stores the new entry content.
 */
export const update: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;
  const storage = SourceChainStorage.getInstance();

  // Deserialize input
  const input = deserializeFromWasm(instance, inputPtr, inputLen) as any;

  console.log("[update] Raw input keys:", Object.keys(input));
  console.log("[update] Input:", {
    hasOriginalActionAddress: !!input.original_action_address,
    hasEntry: !!input.entry,
    hasEntryLocation: !!input.entry_location,
    entryKeys: input.entry ? Object.keys(input.entry) : [],
  });

  // Extract entry content from the nested structure
  const entryContent = input.entry?.entry as Uint8Array;

  if (!entryContent || !(entryContent instanceof Uint8Array)) {
    throw new Error('[update] Invalid entry structure - entry.entry must be Uint8Array');
  }

  // Check if entry_location exists
  if (!input.entry_location || !input.entry_location.App) {
    throw new Error('[update] Invalid input structure - entry_location.App missing');
  }

  console.log("[update] Updating entry", {
    originalActionHash: Array.from(input.original_action_address.slice(0, 8)),
    entrySize: entryContent.length,
    zomeIndex: input.entry_location.App.zome_index,
    entryDefIndex: input.entry_location.App.entry_def_index,
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
  const originalActionResult = storage.getAction(input.original_action_address);
  if (originalActionResult instanceof Promise) {
    console.error("[update] Original action not in session cache");
    throw new Error("Original action not found - must be in session cache");
  }

  const originalAction = originalActionResult;
  if (!originalAction || (originalAction.actionType !== "Create" && originalAction.actionType !== "Update")) {
    throw new Error("Original action not found or not an entry-creating action");
  }

  const originalEntryHash = (originalAction as any).entryHash;

  const [dnaHash, agentPubKey] = callContext.cellId;
  const chainHeadResult = storage.getChainHead(dnaHash, agentPubKey);

  let chainHead: any;
  if (chainHeadResult instanceof Promise) {
    console.error("[update] Chain head not in session cache");
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
      zome_id: input.entry_location.App.zome_index,
      entry_index: input.entry_location.App.entry_def_index,
    },
    originalActionHash: input.original_action_address,
    originalEntryHash,
  };

  // Store new entry content
  const entry: StoredEntry = {
    entryHash,
    entryContent: entryContent,
    entryType: {
      zome_id: input.entry_location.App.zome_index,
      entry_index: input.entry_location.App.entry_def_index,
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
