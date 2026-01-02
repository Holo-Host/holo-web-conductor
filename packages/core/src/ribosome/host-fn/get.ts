/**
 * get host function
 *
 * Retrieves a record from the source chain or DHT using cascade pattern.
 * Order: Local storage → Network cache → Network
 */

import { HostFunctionImpl } from "./base";
import { deserializeTypedFromWasm, serializeResult } from "../serialization";
import { getStorageProvider } from "../../storage/storage-provider";
import { toHolochainAction } from "./action-serialization";
import { Cascade, getNetworkCache, getNetworkService } from "../../network";
import type { Record as HolochainRecord } from "../holochain-types";
import { isStoredDeleteAction, type StoredAction } from "../../storage/types";
import type { WireAction, RecordEntry } from "../../types/holochain-types";
import { validateWasmGetInputArray } from "../wasm-io-types";
import { toUint8Array } from "../../utils/bytes";

/**
 * Normalize entry bytes from gateway JSON format to Uint8Array
 *
 * Gateway returns Entry as JSON where bytes are represented as arrays of numbers.
 * For msgpack encoding to work correctly, we need to convert these to Uint8Array.
 *
 * Entry format: { entry_type: "App"|"Agent"|etc, entry: bytes }
 */
function normalizeEntryBytes(entry: any): any {
  if (!entry || typeof entry !== 'object') return entry;

  const entryType = entry.entry_type;
  const entryData = entry.entry;

  if (!entryType) return entry;

  // Convert entry bytes to Uint8Array if it's an array
  const normalizedData = (Array.isArray(entryData) || (typeof entryData === 'object' && entryData !== null && !(entryData instanceof Uint8Array)))
    ? toUint8Array(entryData)
    : entryData;

  return {
    entry_type: entryType,
    entry: normalizedData,
  };
}


/**
 * get host function implementation
 *
 * Uses Cascade pattern: local storage → network cache → network
 */
export const get: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;
  const storage = getStorageProvider();

  // Deserialize and validate input - it's an array of GetInput objects
  const inputs = deserializeTypedFromWasm(
    instance, inputPtr, inputLen,
    validateWasmGetInputArray, 'WasmGetInput[]'
  );
  const input = inputs[0];
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
  const deleteActions = storage.queryActions(dnaHash, agentPubKey, { actionType: 'Delete' });

  if (deleteActions && deleteActions.length > 0) {
    const actionHash = networkRecord.signed_action.hashed.hash;
    const isDeleted = deleteActions.some((storedAction: StoredAction) => {
      if (isStoredDeleteAction(storedAction)) {
        const deletesHash = storedAction.deletesActionHash;
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
  // StoredAction uses actionType string, WireAction uses type enum
  const action = networkRecord.signed_action.hashed.content;

  // If from local storage, convert to Holochain format
  // Local actions have actionType as string, network actions have type as object
  let actionContent: WireAction;
  const localActionType = (action as unknown as StoredAction).actionType;
  if (typeof localActionType === 'string') {
    // Local format - convert to wire format
    actionContent = toHolochainAction(action as unknown as StoredAction);
  } else {
    // Already in network/Holochain wire format
    actionContent = action as unknown as WireAction;
  }

  // Build entry from network record
  // Cascade produces entries in Holochain format: { Present: { entry_type: "App", entry: content } }
  // Gateway returns entry bytes as JSON array - convert to Uint8Array for msgpack encoding
  let entry: RecordEntry = { NotApplicable: undefined as unknown as void };
  const recordEntry = networkRecord.entry;
  if (recordEntry && typeof recordEntry === 'object' && 'Present' in recordEntry) {
    const presentEntry = recordEntry.Present;
    if (presentEntry) {
      // Normalize entry bytes: convert JSON arrays to Uint8Array
      const normalizedEntry = normalizeEntryBytes(presentEntry);
      entry = { Present: normalizedEntry };
    }
  }

  const record: HolochainRecord = {
    signed_action: {
      hashed: {
        content: actionContent as unknown as HolochainRecord['signed_action']['hashed']['content'],
        hash: networkRecord.signed_action.hashed.hash,
      },
      signature: networkRecord.signed_action.signature,
    },
    entry: entry as unknown as HolochainRecord['entry'],
  };

  console.log('[get] Found record via cascade', {
    actionType: actionContent.type || localActionType,
    hasEntry: !('NotApplicable' in entry),
  });

  // Return Vec<Option<Record>> - HDK host function signature
  return serializeResult(instance, [record]);
};
