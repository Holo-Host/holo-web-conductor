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
import { normalizeEntryBytes } from "./entry-utils";


/**
 * Process a single get input and return the record or null
 */
function processGetInput(
  input: { any_dht_hash: Uint8Array; get_options?: unknown },
  dnaHash: Uint8Array,
  agentPubKey: Uint8Array,
  storage: ReturnType<typeof getStorageProvider>,
  cascade: Cascade,
  toBase64: (arr: Uint8Array) => string,
  inputIndex: number
): HolochainRecord | null {
  const { any_dht_hash } = input;

  // Detect hash type based on prefix
  const hashType = any_dht_hash[0] === 132 && any_dht_hash[1] === 33 ? 'ENTRY' :
                   any_dht_hash[0] === 132 && any_dht_hash[1] === 41 ? 'ACTION' :
                   any_dht_hash[0] === 132 && any_dht_hash[1] === 32 ? 'AGENT' : 'UNKNOWN';

  console.log(`[get] Input ${inputIndex}: Getting ${hashType} hash: ${toBase64(any_dht_hash)}`);

  // Try cascade: local → cache → network
  const networkRecord = cascade.fetchRecord(dnaHash, any_dht_hash);

  if (!networkRecord) {
    console.log(`[get] Input ${inputIndex}: NOT FOUND`);
    return null;
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
      console.log(`[get] Input ${inputIndex}: Record deleted`);
      return null;
    }
  }

  // Convert action format if needed
  const action = networkRecord.signed_action.hashed.content;
  let actionContent: WireAction;
  const localActionType = (action as unknown as StoredAction).actionType;
  if (typeof localActionType === 'string') {
    actionContent = toHolochainAction(action as unknown as StoredAction);
  } else {
    actionContent = action as unknown as WireAction;
  }

  // Build entry from network record
  // Rust RecordEntry unit variants serialize as strings in msgpack: "NA", "Hidden", "NotStored"
  let entry: RecordEntry = "NA" as unknown as RecordEntry;
  const recordEntry = networkRecord.entry;
  if (recordEntry && typeof recordEntry === 'object' && 'Present' in recordEntry) {
    const presentEntry = recordEntry.Present;
    if (presentEntry) {
      const normalizedEntry = normalizeEntryBytes(presentEntry);
      entry = { Present: normalizedEntry } as RecordEntry;
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

  console.log(`[get] Input ${inputIndex}: Found ${hashType} record`, {
    actionType: actionContent.type || localActionType,
    hasEntry: typeof entry === 'object' && 'Present' in entry,
  });

  return record;
}

/**
 * get host function implementation
 *
 * Uses Cascade pattern: local storage → network cache → network
 * Handles batch queries - processes ALL inputs and returns Vec<Option<Record>>
 */
export const get: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;
  const storage = getStorageProvider();

  // Deserialize and validate input - it's an array of GetInput objects
  const inputs = deserializeTypedFromWasm(
    instance, inputPtr, inputLen,
    validateWasmGetInputArray, 'WasmGetInput[]'
  );

  console.log('[get] Processing batch of', inputs.length, 'queries');

  // Convert to base64url for easier debugging
  const toBase64 = (arr: Uint8Array) => {
    const base64 = btoa(String.fromCharCode(...arr));
    return 'u' + base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  const [dnaHash, agentPubKey] = callContext.cellId;

  // Create cascade for this lookup
  const cascade = new Cascade(storage, getNetworkCache(), getNetworkService());

  // Process ALL inputs and collect results
  // HDK expects Vec<Option<Record>> - one Option<Record> per input
  const allResults = inputs.map((input, index) =>
    processGetInput(input, dnaHash, agentPubKey, storage, cascade, toBase64, index)
  );

  console.log('[get] Batch complete. Found:', allResults.filter(r => r !== null).length, '/', inputs.length);

  return serializeResult(instance, allResults);
};
