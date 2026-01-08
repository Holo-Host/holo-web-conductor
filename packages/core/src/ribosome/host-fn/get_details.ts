/**
 * get_details host function
 *
 * Returns detailed information about a record including its updates and deletes.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";
import { getStorageProvider } from "../../storage/storage-provider";
import { toHolochainAction } from "./action-serialization";
import { buildEntry } from "./entry-utils";

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

  console.log("[get_details] Getting details for hash", {
    hash: Array.from(inputHash.slice(0, 8)),
    fullHash: Array.from(inputHash),
  });

  const [dnaHash, agentPubKey] = callContext.cellId;

  // Try to get as action hash first (always synchronous)
  const action = storage.getAction(inputHash);

  console.log("[get_details] Action lookup result", {
    found: !!action,
    actionType: action?.actionType,
    hasEntryHash: action && "entryHash" in action,
    actionHash: action ? Array.from(action.actionHash.slice(0, 8)) : null,
  });

  // Get the entry hash from the action
  const entryHashToQuery = action && "entryHash" in action ? (action as any).entryHash : null;

  if (!entryHashToQuery || !action) {
    console.log("[get_details] No entry hash found, returning null");
    return serializeResult(instance, [null]);
  }

  console.log("[get_details] Entry hash to query", {
    entryHash: Array.from(entryHashToQuery.slice(0, 8)),
  });

  // Get full details for this entry
  const details = storage.getDetails(entryHashToQuery, dnaHash, agentPubKey);

  console.log("[get_details] Storage getDetails result", {
    found: !!details,
    hasRecord: details ? !!details.record : false,
    hasEntry: details?.record ? !!details.record.entry : false,
    updatesCount: details?.updates?.length ?? 0,
    deletesCount: details?.deletes?.length ?? 0,
  });

  if (!details) {
    console.log("[get_details] No details found");
    return serializeResult(instance, [null]);
  }

  if (!details.record) {
    console.error("[get_details] details.record is undefined!", { details });
    return serializeResult(instance, [null]);
  }

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
    deletes: details.deletes.map((d) => ({
      hashed: {
        content: toHolochainAction(d.deleteAction),
        hash: d.deleteAction.actionHash,
      },
      signature: d.deleteAction.signature,
    })),
    updates: details.updates.map((u) => ({
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

  console.log("[get_details] Returning details", {
    updatesCount: details.updates.length,
    deletesCount: details.deletes.length,
  });

  // Return Vec<Option<Details>> - host function returns array
  return serializeResult(instance, [result]);
};
