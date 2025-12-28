/**
 * get host function
 *
 * Retrieves a record from the source chain or DHT.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";
import { SourceChainStorage } from "../../storage/source-chain-storage";
import { toHolochainAction } from "./action-serialization";

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

/**
 * Record structure
 */
interface Record {
  signed_action: {
    hashed: {
      content: {
        type: string;
        author: Uint8Array;
        timestamp: number;
        action_seq: number;
        prev_action: Uint8Array | null;
        entry_type?: { App: { entry_index: number; zome_index: number; visibility: string } };
        entry_hash?: Uint8Array;
        entry_index?: number;
        weight?: { bucket_id: number; units: number; rate_bytes: number };
      };
      hash: Uint8Array;
    };
    signature: Uint8Array;
  };
  entry?: {
    Present: {
      entry_type: string;  // "App", "Agent", etc. (serde tag)
      entry: Uint8Array;   // The actual entry bytes (serde content)
    };
  } | null;
}

/**
 * get host function implementation
 *
 * Retrieves record from storage (uses session cache for synchronous reads)
 */
export const get: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { instance } = context;
  const storage = SourceChainStorage.getInstance();

  // Deserialize input - it's an array of GetInput objects
  const inputs = deserializeFromWasm(instance, inputPtr, inputLen) as GetInput[];
  const input = inputs[0]; // Get first element
  const { any_dht_hash } = input;

  console.log(`[get] Getting record for hash:`, Array.from(any_dht_hash.slice(0, 8)));

  // Try to get action from storage (synchronous if in cache)
  const actionResult = storage.getAction(any_dht_hash);

  // If it's a Promise, we can't handle it synchronously yet (Step 7+)
  // For now, return null if not in cache
  if (actionResult instanceof Promise || actionResult === null) {
    console.warn('[get] Record not in session cache - returning null (Step 7+ will support async reads)');
    // Return Vec<Option<Record>> with None = [null]
    return serializeResult(instance, [null]);
  }

  const action = actionResult;

  // Get entry if action has one
  let entry = null;
  if ('entryHash' in action && action.entryHash) {
    const entryResult = storage.getEntry(action.entryHash);
    if (!(entryResult instanceof Promise) && entryResult !== null) {
      entry = entryResult;
    }
  }

  // Convert action to Holochain format with internally tagged enum
  const actionContent = toHolochainAction(action);

  // Build record structure matching Holochain's Record format
  const record: Record = {
    signed_action: {
      hashed: {
        content: actionContent,
        hash: action.actionHash,
      },
      signature: action.signature,
    },
    entry: entry ? {
      Present: {
        entry_type: "App",
        entry: entry.entryContent,
      },
    } : null,
  };

  console.log('[get] Found record in cache', {
    actionType: action.actionType,
    hasEntry: !!entry,
  });

  // Return Vec<Option<Record>> - HDK host function signature
  return serializeResult(instance, [record]);
};
