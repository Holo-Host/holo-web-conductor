/**
 * get_details host function
 *
 * Returns detailed information about a record including its updates and deletes.
 * Routes based on hash type:
 * - ActionHash -> Details::Record (RecordDetails)
 * - EntryHash -> Details::Entry (EntryDetails)
 *
 * Uses Cascade for local-first lookup with network fallback.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";
import { getStorageProvider } from "../../storage/storage-provider";
import { toHolochainAction } from "./action-serialization";
import { buildEntry } from "./entry-utils";
import { HoloHashType, getHashType } from "@holochain/client";
import type { EntryHash, ActionHash } from "@holochain/client";
import { Cascade, getNetworkCache, getNetworkService } from "../../network";

/**
 * get_details host function implementation
 *
 * Returns Vec<Option<Details>> where Details is either Record or Entry details.
 * The profiles zome uses this to follow update chains via get_latest().
 */
export const getDetails: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;
  const storage = getStorageProvider();

  // Input is Vec<GetInput> with GetInput = { any_dht_hash, get_options }
  const inputs = deserializeFromWasm(instance, inputPtr, inputLen) as Array<{
    any_dht_hash: Uint8Array;
    get_options?: unknown;
  }>;

  const input = inputs[0]; // Get first element
  const inputHash = input.any_dht_hash;

  // Detect hash type from prefix bytes
  const hashType = getHashType(inputHash);

  console.log("[get_details] Getting details for hash", {
    hash: Array.from(inputHash.slice(0, 8)),
    hashType,
  });

  const [dnaHash, agentPubKey] = callContext.cellId;

  // Create cascade for network fallback
  const cascade = new Cascade(storage, getNetworkCache(), getNetworkService());

  // Route based on hash type
  if (hashType === HoloHashType.Entry) {
    return handleEntryHashQuery(instance, inputHash as EntryHash, dnaHash, agentPubKey, storage, cascade);
  }

  // Default: treat as action hash query
  return handleActionHashQuery(instance, inputHash as ActionHash, dnaHash, agentPubKey, storage, cascade);
};

/**
 * Handle query by entry hash - returns Details::Entry
 *
 * Uses Cascade to fetch from network if not in local storage.
 */
function handleEntryHashQuery(
  instance: WebAssembly.Instance,
  entryHash: EntryHash,
  dnaHash: Uint8Array,
  agentPubKey: Uint8Array,
  storage: ReturnType<typeof getStorageProvider>,
  cascade: Cascade
) {
  console.log("[get_details] Handling as entry hash query");

  // Use cascade for local-first with network fallback
  const cascadeResult = cascade.fetchDetails(dnaHash, agentPubKey, entryHash);

  if (!cascadeResult) {
    console.log("[get_details] No entry details found (local or network)");
    return serializeResult(instance, [null]);
  }

  // Check if result is from network (already formatted) or local (needs formatting)
  if (cascadeResult.source === 'network') {
    console.log("[get_details] Returning network entry details");
    // Network response is already in gateway format - return as-is
    return serializeResult(instance, [cascadeResult.details]);
  }

  // Local storage result - format it
  const entryDetails = cascadeResult.details;

  // Build EntryDetails structure matching Holochain's format
  const result = {
    type: "Entry",
    content: {
      entry: buildEntry(entryDetails.entry.entryType, entryDetails.entry.entryContent),
      actions: entryDetails.actions.map((a: any) => ({
        hashed: {
          content: toHolochainAction(a.action),
          hash: a.actionHash,
        },
        signature: a.action.signature,
      })),
      rejected_actions: entryDetails.rejectedActions.map((a: any) => ({
        hashed: {
          content: toHolochainAction(a.action),
          hash: a.actionHash,
        },
        signature: a.action.signature,
      })),
      deletes: entryDetails.deletes.map((d: any) => ({
        hashed: {
          content: toHolochainAction(d.deleteAction),
          hash: d.deleteHash,
        },
        signature: d.deleteAction.signature,
      })),
      updates: entryDetails.updates.map((u: any) => ({
        hashed: {
          content: toHolochainAction(u.updateAction),
          hash: u.updateHash,
        },
        signature: u.updateAction.signature,
      })),
      entry_dht_status: entryDetails.entryDhtStatus,
    },
  };

  console.log("[get_details] Returning local entry details", {
    actionsCount: entryDetails.actions.length,
    updatesCount: entryDetails.updates.length,
    deletesCount: entryDetails.deletes.length,
  });

  return serializeResult(instance, [result]);
}

/**
 * Handle query by action hash - returns Details::Record
 *
 * Uses Cascade to fetch from network if not in local storage.
 */
function handleActionHashQuery(
  instance: WebAssembly.Instance,
  actionHash: ActionHash,
  dnaHash: Uint8Array,
  agentPubKey: Uint8Array,
  storage: ReturnType<typeof getStorageProvider>,
  cascade: Cascade
) {
  console.log("[get_details] Handling as action hash query");

  // Convert to base64url for logging
  const toBase64 = (arr: Uint8Array) => {
    const base64 = btoa(String.fromCharCode(...arr));
    return 'u' + base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  // Use cascade for local-first with network fallback
  const cascadeResult = cascade.fetchDetails(dnaHash, agentPubKey, actionHash);

  if (!cascadeResult) {
    console.log("[get_details] No record details found (local or network)");
    return serializeResult(instance, [null]);
  }

  // Check if result is from network (already formatted) or local (needs formatting)
  if (cascadeResult.source === 'network') {
    console.log("[get_details] Returning network record details");
    // Network response is already in gateway format - return as-is
    return serializeResult(instance, [cascadeResult.details]);
  }

  // Local storage result - format it
  const details = cascadeResult.details;
  const action = cascadeResult.action;

  if (!details) {
    console.log("[get_details] No details found");
    return serializeResult(instance, [null]);
  }

  if (!details.record) {
    console.error("[get_details] details.record is undefined!", { details });
    return serializeResult(instance, [null]);
  }

  console.log("[get_details] Local storage details result", {
    hasRecord: !!details.record,
    hasEntry: details?.record?.entry != null,
    updatesCount: details?.updates?.length ?? 0,
    deletesCount: details?.deletes?.length ?? 0,
    actionHash: toBase64(actionHash),
  });

  // Build RecordDetails structure using the action we looked up
  // This ensures we return the action that was queried, not necessarily the originating action
  const recordDetails = {
    record: {
      signed_action: {
        hashed: {
          content: toHolochainAction(action),
          hash: action.actionHash,
        },
        signature: action.signature,
      },
      entry: details.record.entry
        ? {
            Present: buildEntry(details.record.entry.entryType, details.record.entry.entryContent)
          }
        : { NotApplicable: null },
    },
    validation_status: "Valid",
    deletes: details.deletes.map((d: any) => ({
      hashed: {
        content: toHolochainAction(d.deleteAction),
        hash: d.deleteAction.actionHash,
      },
      signature: d.deleteAction.signature,
    })),
    updates: details.updates.map((u: any) => ({
      hashed: {
        content: toHolochainAction(u.updateAction),
        hash: u.updateAction.actionHash,
      },
      signature: u.updateAction.signature,
    })),
  };

  // Wrap in adjacently-tagged Details enum
  // Details is: #[serde(tag = "type", content = "content")]
  const result = {
    type: "Record",
    content: recordDetails,
  };

  console.log("[get_details] Returning local details", {
    updatesCount: details.updates.length,
    deletesCount: details.deletes.length,
  });

  // Return Vec<Option<Details>> - host function returns array
  return serializeResult(instance, [result]);
}
