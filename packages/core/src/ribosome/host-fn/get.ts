/**
 * get host function
 *
 * Retrieves a record from the source chain or DHT.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";

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
 * NOTE: This is a MOCK implementation for Step 5.
 * Returns a mock record structure. Always returns Some(record), never None.
 * Step 6 will add real chain/DHT storage lookups.
 */
export const get: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;

  // Deserialize input - it's an array of GetInput objects
  const inputs = deserializeFromWasm(instance, inputPtr, inputLen) as GetInput[];
  const input = inputs[0]; // Get first element
  const { any_dht_hash } = input;

  // Debug: Check what we received
  console.log(`[get] Received hash:`,
    any_dht_hash instanceof Uint8Array ? `Uint8Array(${any_dht_hash.length})` : typeof any_dht_hash,
    `first 10 bytes:`, any_dht_hash instanceof Uint8Array ? Array.from(any_dht_hash.slice(0, 10)) : 'N/A');

  // Create mock record
  const [_dnaHash, rawAgentPubKey] = callContext.cellId;

  // Construct AgentPubKey (39 bytes): [prefix(3)][hash(32)][location(4)]
  const agentPubKey = new Uint8Array(39);
  agentPubKey.set([132, 32, 36], 0); // AGENT_PREFIX
  agentPubKey.set(rawAgentPubKey, 3); // 32-byte public key
  agentPubKey.set([0, 0, 0, 0], 35); // location (all zeros)

  // Create a mock previous action hash (39 bytes) - not genesis
  const prevActionHash = new Uint8Array(39);
  prevActionHash.set([132, 41, 36], 0); // ACTION_PREFIX
  prevActionHash.set(new Uint8Array(32).fill(1), 3); // Different hash content
  prevActionHash.set([0, 0, 0, 0], 35); // location

  // Create a mock entry hash (39 bytes) with ENTRY_PREFIX
  const entryHash = new Uint8Array(39);
  entryHash.set([132, 33, 36], 0); // ENTRY_PREFIX (not ACTION_PREFIX!)
  entryHash.set(any_dht_hash.slice(3, 35), 3); // Copy hash content from input
  entryHash.set([0, 0, 0, 0], 35); // location

  const mockRecord: Record = {
    signed_action: {
      hashed: {
        content: {
          type: "Create",
          author: agentPubKey, // 39-byte AgentPubKey
          timestamp: Date.now() * 1000, // microseconds
          action_seq: 1, // Not genesis
          prev_action: prevActionHash, // Previous action hash
          entry_type: { App: { entry_index: 0, zome_index: 0, visibility: "Public" } },
          entry_hash: entryHash, // 39-byte EntryHash with correct prefix
          entry_index: 0, // Index of entry in action
          weight: { bucket_id: 0, units: 0, rate_bytes: 0 }, // EntryRateWeight
        },
        hash: any_dht_hash, // 39-byte ActionHash (input hash)
      },
      signature: new Uint8Array(64), // Empty signature
    },
    entry: {
      Present: {
        entry_type: "App",  // serde tag field
        entry: new Uint8Array(0),  // serde content field (AppEntryBytes - empty for mock)
      },
    },
  };

  console.warn(
    "[get] Returning MOCK record - Step 6 will add real storage"
  );

  // Return Vec<Option<Record>> - the zome expects a vector of optional records
  // Some(record) is represented as the record itself (not null)
  return serializeResult(instance, [mockRecord]);
};
