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

// Helper to convert to base64url for logging
const toBase64 = (arr: Uint8Array) => {
  const base64 = btoa(String.fromCharCode(...arr));
  return 'u' + base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/**
 * Process a single get_details input and return the details or null
 */
function processGetDetailsInput(
  input: { any_dht_hash: Uint8Array; get_options?: unknown },
  dnaHash: Uint8Array,
  agentPubKey: Uint8Array,
  storage: ReturnType<typeof getStorageProvider>,
  cascade: Cascade,
  inputIndex: number
): any | null {
  const inputHash = input.any_dht_hash;

  // Detect hash type from prefix bytes
  const hashType = getHashType(inputHash);

  console.log(`[get_details] Input ${inputIndex}:`, {
    hash: toBase64(inputHash),
    hashType,
  });

  // Route based on hash type
  if (hashType === HoloHashType.Entry) {
    return processEntryHashQuery(inputHash as EntryHash, dnaHash, agentPubKey, storage, cascade, inputIndex);
  }

  // Default: treat as action hash query
  return processActionHashQuery(inputHash as ActionHash, dnaHash, agentPubKey, storage, cascade, inputIndex);
}

/**
 * get_details host function implementation
 *
 * Returns Vec<Option<Details>> where Details is either Record or Entry details.
 * Handles batch queries - processes ALL inputs.
 */
export const getDetails: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;
  const storage = getStorageProvider();

  // Input is Vec<GetInput> with GetInput = { any_dht_hash, get_options }
  const inputs = deserializeFromWasm(instance, inputPtr, inputLen) as Array<{
    any_dht_hash: Uint8Array;
    get_options?: unknown;
  }>;

  console.log('[get_details] Processing batch of', inputs.length, 'queries');

  const [dnaHash, agentPubKey] = callContext.cellId;

  // Create cascade for network fallback
  const cascade = new Cascade(storage, getNetworkCache(), getNetworkService());

  // Process ALL inputs and collect results
  // HDK expects Vec<Option<Details>> - one Option<Details> per input
  const allResults = inputs.map((input, index) =>
    processGetDetailsInput(input, dnaHash, agentPubKey, storage, cascade, index)
  );

  console.log('[get_details] Batch complete. Found:', allResults.filter(r => r !== null).length, '/', inputs.length);

  return serializeResult(instance, allResults);
};

/**
 * Process query by entry hash - returns Details::Entry or null
 */
function processEntryHashQuery(
  entryHash: EntryHash,
  dnaHash: Uint8Array,
  agentPubKey: Uint8Array,
  storage: ReturnType<typeof getStorageProvider>,
  cascade: Cascade,
  inputIndex: number
): any | null {
  console.log(`[get_details] Input ${inputIndex}: entry hash query`);

  // Use cascade for local-first with network fallback
  const cascadeResult = cascade.fetchDetails(dnaHash, agentPubKey, entryHash);

  if (!cascadeResult) {
    console.log(`[get_details] Input ${inputIndex}: No entry details found`);
    return null;
  }

  // Check if result is from network (already formatted) or local (needs formatting)
  if (cascadeResult.source === 'network') {
    console.log(`[get_details] Input ${inputIndex}: Returning network entry details`);
    return cascadeResult.details;
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

  console.log(`[get_details] Input ${inputIndex}: local entry details`, {
    actionsCount: entryDetails.actions.length,
    updatesCount: entryDetails.updates.length,
  });

  return result;
}

/**
 * Process query by action hash - returns Details::Record or null
 */
function processActionHashQuery(
  actionHash: ActionHash,
  dnaHash: Uint8Array,
  agentPubKey: Uint8Array,
  storage: ReturnType<typeof getStorageProvider>,
  cascade: Cascade,
  inputIndex: number
): any | null {
  console.log(`[get_details] Input ${inputIndex}: action hash query`, {
    actionHash: toBase64(actionHash),
  });

  // Use cascade for local-first with network fallback
  const cascadeResult = cascade.fetchDetails(dnaHash, agentPubKey, actionHash);

  if (!cascadeResult) {
    console.log(`[get_details] Input ${inputIndex}: No record details found`);
    return null;
  }

  // Check if result is from network (already formatted) or local (needs formatting)
  if (cascadeResult.source === 'network') {
    console.log(`[get_details] Input ${inputIndex}: Returning network record details`);
    return cascadeResult.details;
  }

  // Local storage result - format it
  const details = cascadeResult.details;
  const action = cascadeResult.action;

  if (!details || !details.record) {
    console.log(`[get_details] Input ${inputIndex}: No details.record found`);
    return null;
  }

  console.log(`[get_details] Input ${inputIndex}: local record details`, {
    updatesCount: details?.updates?.length ?? 0,
    deletesCount: details?.deletes?.length ?? 0,
  });

  // Build RecordDetails structure
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

  return result;
}
