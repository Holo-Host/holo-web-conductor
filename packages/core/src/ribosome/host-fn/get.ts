/**
 * get host function
 *
 * Retrieves a record from the source chain or DHT using cascade pattern.
 * Order: Local storage → Network cache → Network
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";
import { SourceChainStorage } from "../../storage/source-chain-storage";
import { toHolochainAction } from "./action-serialization";
import { Cascade, getNetworkCache, getNetworkService } from "../../network";
import type { Record as HolochainRecord } from "../holochain-types";

/**
 * Get input structure
 *
 * Note: The input is actually an array of GetInput objects for batch operations
 */
interface GetInput {
  /** Hash of the action or entry to get */
  any_dht_hash: Uint8Array;

  /** Get options */
  get_options?: {
    strategy?: string;
  };
}

// Using HolochainRecord type from holochain-types.ts

/**
 * get host function implementation
 *
 * Uses Cascade pattern: local storage → network cache → network
 */
export const get: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;
  const storage = SourceChainStorage.getInstance();

  // Deserialize input - it's an array of GetInput objects
  const inputs = deserializeFromWasm(instance, inputPtr, inputLen) as GetInput[];
  const input = inputs[0]; // Get first element
  const { any_dht_hash } = input;

  console.log(`[get] Getting record for hash:`, Array.from(any_dht_hash.slice(0, 8)));

  const [dnaHash, agentPubKey] = callContext.cellId;

  // Create cascade for this lookup
  // Uses global network service if configured (MockNetworkService for testing, SyncXHRNetworkService for production)
  const cascade = new Cascade(storage, getNetworkCache(), getNetworkService());

  // Try cascade: local → cache → network
  const networkRecord = cascade.fetchRecord(dnaHash, any_dht_hash);

  if (!networkRecord) {
    console.log('[get] Record not found in cascade');
    return serializeResult(instance, [null]);
  }

  // Check if this action has been deleted
  const deleteActions = storage.queryActionsFromCache(dnaHash, agentPubKey, { actionType: 'Delete' });

  if (deleteActions && deleteActions.length > 0) {
    const actionHash = networkRecord.signed_action.hashed.hash;
    const isDeleted = deleteActions.some((deleteAction: any) => {
      if (deleteAction.actionType === 'Delete') {
        const deletesHash = deleteAction.deletesActionHash;
        if (deletesHash && deletesHash.length === actionHash.length) {
          return deletesHash.every((byte: number, i: number) => byte === actionHash[i]);
        }
      }
      return false;
    });

    if (isDeleted) {
      console.log('[get] Record has been deleted - returning null');
      return serializeResult(instance, [null]);
    }
  }

  // The cascade returns NetworkRecord format, which we need to convert to Holochain Record format
  // NetworkRecord has: signed_action, entry (NetworkEntry)
  // HolochainRecord needs: signed_action with toHolochainAction format, entry

  // Check if this came from local storage (has our internal action format)
  // or from network (has Holochain wire format)
  const action = networkRecord.signed_action.hashed.content as any;

  // If from local storage, convert to Holochain format
  // Local actions have actionType as string, network actions have type as object
  let actionContent: any;
  const localActionType = action.actionType;
  if (typeof localActionType === 'string') {
    // Local format - convert
    actionContent = toHolochainAction(action);
  } else {
    // Already in network/Holochain format
    actionContent = action;
  }

  // Build entry from network record
  // Cascade now produces entries in correct Holochain format: { entry_type: "App", entry: content }
  let entry: any = "NA";
  const recordEntry = networkRecord.entry as any;
  if (recordEntry !== "NotApplicable" && recordEntry !== "NA" && recordEntry !== 'NotStored' && recordEntry !== 'Hidden') {
    const presentEntry = recordEntry?.Present;
    if (presentEntry) {
      entry = { Present: presentEntry };
    }
  }

  const record: HolochainRecord = {
    signed_action: {
      hashed: {
        content: actionContent,
        hash: networkRecord.signed_action.hashed.hash,
      },
      signature: networkRecord.signed_action.signature,
    },
    entry,
  };

  console.log('[get] Found record via cascade', {
    actionType: actionContent.type || localActionType,
    hasEntry: entry !== "NA",
  });

  // Return Vec<Option<Record>> - HDK host function signature
  return serializeResult(instance, [record]);
};
