/**
 * get host function
 *
 * Retrieves a record from the source chain or DHT.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";

/**
 * Get input structure
 */
interface GetInput {
  /** Hash of the action or entry to get */
  hash: Uint8Array;

  /** Get options */
  options?: {
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
        entry_type?: { App: { id: number; zome_id: number; visibility: string } };
        entry_hash?: Uint8Array;
      };
      hash: Uint8Array;
    };
    signature: Uint8Array;
  };
  entry?: {
    Present: {
      entry_type: string;
      entry: Uint8Array;
    };
  } | null;
}

/**
 * get host function implementation
 *
 * NOTE: This is a MOCK implementation for Step 5.
 * Returns a mock record structure. Always returns Some(record), never None.
 * Step 6 will add real chain/DHT storage lookups.
 */
export const get: HostFunctionImpl = (context, inputPtr) => {
  const { callContext, instance } = context;

  // Deserialize input
  const input = deserializeFromWasm(instance, inputPtr, 0) as GetInput;
  const { hash } = input;

  // Create mock record
  const [_dnaHash, agentPubKey] = callContext.cellId;

  const mockRecord: Record = {
    signed_action: {
      hashed: {
        content: {
          type: "Create",
          author: agentPubKey,
          timestamp: Date.now() * 1000, // microseconds
          action_seq: 0,
          prev_action: null, // Genesis
          entry_type: { App: { id: 0, zome_id: 0, visibility: "Public" } },
          entry_hash: hash,
        },
        hash: hash,
      },
      signature: new Uint8Array(64), // Empty signature
    },
    entry: {
      Present: {
        entry_type: "App",
        entry: new Uint8Array(0), // Empty entry
      },
    },
  };

  console.warn(
    "[get] Returning MOCK record - Step 6 will add real storage"
  );

  // Return Some(record) - in Holochain this would be Option<Record>
  return serializeResult(instance, mockRecord);
};
