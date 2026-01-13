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
import { computeAppEntryHash, computeActionHashV2, serializeAction } from "../../hash";
import { buildCreateAction, buildAppEntryType } from "../../types/holochain-serialization";
import { signAction } from "../../signing";

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

  // Convert to base64url for easier debugging (matches Holochain's hash display format)
  const toBase64 = (arr: Uint8Array) => {
    const base64 = btoa(String.fromCharCode(...arr));
    return 'u' + base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  // Try to decode entry content as UTF-8 to see if it's a path
  let contentPreview = '';
  try {
    const decoded = new TextDecoder().decode(entryContent);
    if (decoded.includes('all_profiles') || decoded.length < 100) {
      contentPreview = decoded.substring(0, 80);
    }
  } catch { /* ignore */ }

  console.log('[create] Creating entry', {
    entryType: input.entry.entry_type,
    contentLength: entryContent.length,
    visibility: input.entry_visibility,
    zomeIndex: input.entry_location.App.zome_index,
    entryDefIndex: input.entry_location.App.entry_def_index,
    contentFirst32: Array.from(entryContent.slice(0, 32)),
    contentPreview: contentPreview || '[binary]',
  });

  // Hash the entry - App entries hash the serialized Entry enum { entry_type: "App", entry: content }
  const entryHash = computeAppEntryHash(entryContent);

  // Get current chain head (synchronous with StorageProvider interface)
  const [dnaHash, agentPubKey] = callContext.cellId;
  const chainHead = storage.getChainHead(dnaHash, agentPubKey);

  // Increment sequence from chain head, or start at 3 for new chain
  const actionSeq = chainHead ? chainHead.actionSeq + 1 : 3;
  const prevActionHash = chainHead ? chainHead.actionHash : null;
  const timestampMicros = Date.now() * 1000; // Microseconds as number for serialization
  const timestampBigInt = BigInt(timestampMicros); // BigInt for storage

  // Extract entry type from entry_location for storage format
  const entryType: AppEntryType = {
    zome_id: input.entry_location.App.zome_index,
    entry_index: input.entry_location.App.entry_def_index,
  };

  // Build serializable entry type for action
  const serializableEntryType = buildAppEntryType({
    entry_index: entryType.entry_index,
    zome_index: entryType.zome_id,
    visibility: "Public",
  });

  // Build action using type-safe builder (ensures correct field ordering for serialization)
  const serializableAction = buildCreateAction({
    author: agentPubKey,
    timestamp: timestampMicros,
    action_seq: actionSeq,
    prev_action: prevActionHash!,
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

  // Build Create action for storage (uses BigInt timestamp)
  const action: CreateAction = {
    actionHash,
    actionSeq,
    author: agentPubKey,
    timestamp: timestampBigInt,
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
  storage.updateChainHead(dnaHash, agentPubKey, actionSeq, actionHash, timestampBigInt);

  // Track record for publishing after transaction commits
  if (!callContext.pendingRecords) {
    callContext.pendingRecords = [];
  }
  callContext.pendingRecords.push({ action, entry });

  console.log('[create] Created entry', {
    actionHash: toBase64(actionHash),
    actionSeq,
    entryHash: toBase64(entryHash),
  });

  return serializeResult(instance, actionHash);
};
