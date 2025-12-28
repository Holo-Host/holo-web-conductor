/**
 * create host function
 *
 * Creates a new entry on the source chain with full persistence.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";
import { SourceChainStorage } from "../../storage/source-chain-storage";
import type { CreateAction, StoredEntry, AppEntryType } from "../../storage/types";

/**
 * Create input structure (matches Holochain HDK's CreateInput)
 *
 * Structure sent by HDK:
 * {
 *   entry_location: { App: { zome_index, entry_def_index } },
 *   entry_visibility: "Public" | "Private",
 *   entry: {
 *     entry_type: "App" | "Agent" | "CapClaim" | "CapGrant",
 *     entry: Uint8Array  // MessagePack-serialized entry content
 *   },
 *   chain_top_ordering: "Strict" | "Relaxed"
 * }
 */
interface CreateInput {
  /** Entry location (type definition) */
  entry_location: {
    App: {
      zome_index: number;
      entry_def_index: number;
    };
  };

  /** Entry visibility */
  entry_visibility: 'Public' | 'Private';

  /** Entry wrapper with type and content */
  entry: {
    entry_type: 'App' | 'Agent' | 'CapClaim' | 'CapGrant';
    entry: Uint8Array;  // MessagePack-serialized entry content
  };

  /** Chain top ordering */
  chain_top_ordering: 'Strict' | 'Relaxed';
}

/**
 * create host function implementation
 *
 * Stores entry and action in source chain storage.
 * All operations are queued in transaction and committed by ribosome.
 */
export const create: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { instance, callContext } = context;
  const storage = SourceChainStorage.getInstance();

  // Deserialize create input
  const input = deserializeFromWasm(instance, inputPtr, inputLen) as any;

  // Extract entry content from the nested structure
  // HDK sends: { entry_location, entry_visibility, entry: { entry_type, entry }, chain_top_ordering }
  const entryContent = input.entry?.entry as Uint8Array;

  if (!entryContent || !(entryContent instanceof Uint8Array)) {
    throw new Error('[create] Invalid entry structure - entry.entry must be Uint8Array');
  }

  console.log('[create] Creating entry', {
    entryType: input.entry.entry_type,
    contentLength: entryContent.length,
    visibility: input.entry_visibility,
    zomeIndex: input.entry_location.App.zome_index,
    entryDefIndex: input.entry_location.App.entry_def_index,
  });

  // Hash the entry content
  // TODO Step 7+: Use Blake2b for Holochain compatibility
  const entryHashData = new Uint8Array(32);
  crypto.getRandomValues(entryHashData); // Temporary: use random hash instead of real hash

  // Build entry hash (39 bytes): [prefix(3)][hash(32)][location(4)]
  const entryHash = new Uint8Array(39);
  entryHash.set([132, 33, 36], 0); // ENTRY_PREFIX
  entryHash.set(entryHashData, 3);
  entryHash.set([0, 0, 0, 0], 35); // location (all zeros)

  // Get current chain head from pre-loaded session cache
  const [dnaHash, agentPubKey] = callContext.cellId;
  const chainHeadResult = storage.getChainHead(dnaHash, agentPubKey);

  // Since we pre-loaded the chain, this should be synchronous (not a Promise)
  if (chainHeadResult instanceof Promise) {
    throw new Error('[create] Chain head not in session cache - should have been pre-loaded');
  }

  const chainHead = chainHeadResult;

  // Increment sequence from chain head, or start at 3 for new chain
  const actionSeq = chainHead ? chainHead.actionSeq + 1 : 3;
  const prevActionHash = chainHead ? chainHead.actionHash : null;
  const timestamp = BigInt(Date.now()) * 1000n; // Microseconds

  // Create action hash (39 bytes): [prefix(3)][hash(32)][location(4)]
  // TODO Step 7+: Use proper action hash computation
  const actionHash = new Uint8Array(39);
  actionHash.set([132, 41, 36], 0); // ACTION_PREFIX
  const randomHash = new Uint8Array(32);
  crypto.getRandomValues(randomHash);
  actionHash.set(randomHash, 3);
  actionHash.set([0, 0, 0, 0], 35); // location (all zeros)

  // Create signature (64 bytes)
  // TODO Step 7+: Use Lair keystore for real signing
  const signature = new Uint8Array(64);
  crypto.getRandomValues(signature);

  // Extract entry type from entry_location
  const entryType: AppEntryType = {
    zome_id: input.entry_location.App.zome_index,
    entry_index: input.entry_location.App.entry_def_index,  // Fixed: use entry_def_index
  };

  // Build Create action
  const action: CreateAction = {
    actionHash,
    actionSeq,
    author: agentPubKey,
    timestamp,
    prevActionHash,
    actionType: 'Create',
    signature,
    entryHash,
    entryType,
  };

  // Store entry content
  const entry: StoredEntry = {
    entryHash,
    entryContent: entryContent,
    entryType: entryType,
  };

  // These are synchronous when transaction is active (just buffer in memory)
  storage.putEntry(entry, dnaHash, agentPubKey);
  storage.putAction(action, dnaHash, agentPubKey);
  storage.updateChainHead(dnaHash, agentPubKey, actionSeq, actionHash, timestamp);

  console.log('[create] Created entry', {
    actionHash: Array.from(actionHash.slice(0, 8)),
    actionSeq,
    entryHash: Array.from(entryHash.slice(0, 8)),
  });

  return serializeResult(instance, actionHash);
};
