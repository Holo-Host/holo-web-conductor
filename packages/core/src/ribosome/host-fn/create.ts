/**
 * create host function
 *
 * Creates a new entry on the source chain with full persistence.
 */

import { HostFunctionImpl } from "./base";
import { deserializeTypedFromWasm, serializeResult } from "../serialization";
import { getStorageProvider } from "../../storage/storage-provider";
import type { CreateAction, StoredEntry, AppEntryType } from "../../storage/types";
import { validateWasmCreateInput, type WasmCreateInput } from "../wasm-io-types";
import { computeEntryHash, computeActionHash, type ActionForHashing, ActionType } from "../../hash";

/**
 * create host function implementation
 *
 * Stores entry and action in source chain storage.
 * All operations are queued in transaction and committed by ribosome.
 */
export const create: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { instance, callContext } = context;
  const storage = getStorageProvider();

  // Deserialize and validate create input
  const input = deserializeTypedFromWasm(
    instance, inputPtr, inputLen,
    validateWasmCreateInput, 'WasmCreateInput'
  );

  // Extract entry content from the validated structure
  const entryContent = input.entry.entry;

  console.log('[create] Creating entry', {
    entryType: input.entry.entry_type,
    contentLength: entryContent.length,
    visibility: input.entry_visibility,
    zomeIndex: input.entry_location.App.zome_index,
    entryDefIndex: input.entry_location.App.entry_def_index,
  });

  // Hash the entry content using Blake2b
  const entryHash = computeEntryHash(entryContent);

  // Get current chain head (synchronous with StorageProvider interface)
  const [dnaHash, agentPubKey] = callContext.cellId;
  const chainHead = storage.getChainHead(dnaHash, agentPubKey);

  // Increment sequence from chain head, or start at 3 for new chain
  const actionSeq = chainHead ? chainHead.actionSeq + 1 : 3;
  const prevActionHash = chainHead ? chainHead.actionHash : null;
  const timestamp = BigInt(Date.now()) * 1000n; // Microseconds

  // Extract entry type from entry_location
  const entryType: AppEntryType = {
    zome_id: input.entry_location.App.zome_index,
    entry_index: input.entry_location.App.entry_def_index,
  };

  // Build action structure for hashing (before we know the hash)
  const actionForHashing: ActionForHashing = {
    type: ActionType.Create,
    author: agentPubKey,
    timestamp,
    action_seq: actionSeq,
    prev_action: prevActionHash,
    entry_type: {
      App: {
        zome_index: entryType.zome_id,
        entry_index: entryType.entry_index,
        visibility: 'Public',
      }
    },
    entry_hash: entryHash,
    weight: { bucket_id: 0, units: 0, rate_bytes: 0 },
  };

  // Compute action hash using Blake2b
  const actionHash = computeActionHash(actionForHashing);

  // Create signature (64 bytes)
  // TODO: Use Lair keystore for real signing
  const signature = new Uint8Array(64);
  crypto.getRandomValues(signature);

  // Build Create action for storage
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
