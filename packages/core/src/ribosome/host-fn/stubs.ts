/**
 * Stub implementations for all remaining Holochain host functions
 *
 * These are Priority 2+ host functions that will be implemented in later steps.
 * For now, they return null, empty arrays, or throw "not implemented" errors
 * to allow WASM instantiation to succeed.
 *
 * Reference: holochain/crates/holochain/src/core/ribosome/host_fn/
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";
import { getStorageProvider } from "../../storage/storage-provider";
import { toHolochainAction } from "./action-serialization";
import { buildEntry } from "./entry-utils";

/**
 * Helper to create a stub that returns null
 */
function createNullStub(name: string): HostFunctionImpl {
  return (context, inputPtr, inputLen) => {
    console.warn(`[HostFn] ${name} called (STUB - returns null)`);
    return serializeResult(context.instance, null);
  };
}

/**
 * Helper to create a stub that returns an empty array
 */
function createEmptyArrayStub(name: string): HostFunctionImpl {
  return (context, inputPtr, inputLen) => {
    console.warn(`[HostFn] ${name} called (STUB - returns [])`);
    return serializeResult(context.instance, []);
  };
}

/**
 * Helper to create a stub that throws "not implemented"
 */
function createNotImplementedStub(name: string): HostFunctionImpl {
  return (context, inputPtr, inputLen) => {
    throw new Error(`Host function ${name} not implemented (deferred to later step)`);
  };
}

// DHT / Agent Activity
export const getAgentActivity = createEmptyArrayStub("get_agent_activity");
export const mustGetAgentActivity = createNullStub("must_get_agent_activity");

// get_details returns Vec<Option<Details>>
export const getDetails: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;
  const storage = getStorageProvider();

  // Input is Vec<GetInput> with GetInput = { any_dht_hash, get_options }
  const inputs = deserializeFromWasm(instance, inputPtr, inputLen) as Array<{
    any_dht_hash: Uint8Array;
    get_options?: unknown;
  }>;

  const input = inputs[0]; // Get first element

  console.log("[get_details] Getting details for hash", {
    hash: Array.from(input.any_dht_hash.slice(0, 8)),
    fullHash: Array.from(input.any_dht_hash),
  });

  const [dnaHash, agentPubKey] = callContext.cellId;

  // Try to get as action hash first (always synchronous)
  const action = storage.getAction(input.any_dht_hash);

  console.log("[get_details] Action lookup result", {
    found: !!action,
    actionType: action?.actionType,
    hasEntryHash: action && "entryHash" in action,
    entryHash: action && "entryHash" in action ? Array.from((action as any).entryHash?.slice(0, 8) || []) : null,
  });

  // Get the entry hash from the action
  const entryHashToQuery = action && "entryHash" in action ? action.entryHash : null;

  if (entryHashToQuery) {
    // Get full details for this entry (always synchronous with StorageProvider)
    const details = storage.getDetails(entryHashToQuery, dnaHash, agentPubKey);
    if (details) {
      // Build RecordDetails structure
      const recordDetails = {
        record: {
          signed_action: {
            hashed: {
              content: toHolochainAction(details.record.action),
              hash: details.record.actionHash,
            },
            signature: details.record.action.signature,
          },
          entry: details.record.entry
            ? {
                Present: buildEntry(details.record.entry.entryType, details.record.entry.entryContent)
              }
            : "NA",
        },
        validation_status: details.validationStatus,
        deletes: details.deletes.map((d: any) => ({
          hashed: {
            content: toHolochainAction(d.deleteAction),
            hash: d.deleteHash,
          },
          signature: d.deleteAction.signature,
        })),
        updates: details.updates.map((u: any) => ({
          hashed: {
            content: toHolochainAction(u.updateAction),
            hash: u.updateHash,
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

      console.log("[get_details] Found details", {
        deletes: details.deletes.length,
        updates: details.updates.length,
      });

      // Return Vec<Option<Details>> - host function returns array
      return serializeResult(instance, [result]);
    }
  }

  // Not found - Vec<Option<Details>> with one None element
  console.log("[get_details] No details found");
  return serializeResult(instance, [null]);
};
export const getLinksDetails = createEmptyArrayStub("get_links_details");
export const getValidationReceipts = createEmptyArrayStub("get_validation_receipts");

// Cross-zome/cell calls
export const call = createNotImplementedStub("call");

// Signals
export const emitSignal = createNullStub("emit_signal");
export const sendRemoteSignal = createNullStub("send_remote_signal");

// Capabilities
export const capabilityInfo = createNullStub("capability_info");
export const capabilityClaims = createNullStub("capability_claims");
export const capabilityGrants = createNullStub("capability_grants");

// Clone cells
export const createCloneCell = createNotImplementedStub("create_clone_cell");
export const deleteCloneCell = createNotImplementedStub("delete_clone_cell");
export const enableCloneCell = createNotImplementedStub("enable_clone_cell");
export const disableCloneCell = createNotImplementedStub("disable_clone_cell");

// Chain management
export const closeChain = createNotImplementedStub("close_chain");
export const openChain = createNotImplementedStub("open_chain");

// Agent blocking
export const blockAgent = createNotImplementedStub("block_agent");
export const unblockAgent = createNotImplementedStub("unblock_agent");

// Scheduling
export const schedule = createNotImplementedStub("schedule");
export const sleep = createNotImplementedStub("sleep");

// Countersigning
export const acceptCountersigningPreflightRequest = createNotImplementedStub(
  "accept_countersigning_preflight_request"
);

// X25519 encryption (libsodium)
export const createX25519Keypair: HostFunctionImpl = (context, inputPtr, inputLen) => {
  console.warn(
    "[HostFn] create_x25519_keypair called (STUB - returns mock keypair)"
  );
  // Return mock X25519 keypair (32 bytes each)
  const mockKeypair = {
    public_key: new Uint8Array(32).fill(0x01),
    secret_key: new Uint8Array(32).fill(0x02),
  };
  return serializeResult(context.instance, mockKeypair);
};

export const x25519XSalsa20Poly1305Encrypt = createNotImplementedStub(
  "x_25519_x_salsa20_poly1305_encrypt"
);
export const x25519XSalsa20Poly1305Decrypt = createNotImplementedStub(
  "x_25519_x_salsa20_poly1305_decrypt"
);

// Ed25519 + XSalsa20Poly1305 encryption
export const ed25519XSalsa20Poly1305Encrypt = createNotImplementedStub(
  "ed_25519_x_salsa20_poly1305_encrypt"
);
export const ed25519XSalsa20Poly1305Decrypt = createNotImplementedStub(
  "ed_25519_x_salsa20_poly1305_decrypt"
);

// XSalsa20Poly1305 shared secret encryption
export const xSalsa20Poly1305Encrypt = createNotImplementedStub(
  "x_salsa20_poly1305_encrypt"
);
export const xSalsa20Poly1305Decrypt = createNotImplementedStub(
  "x_salsa20_poly1305_decrypt"
);
export const xSalsa20Poly1305SharedSecretCreateRandom = createNotImplementedStub(
  "x_salsa20_poly1305_shared_secret_create_random"
);
export const xSalsa20Poly1305SharedSecretExport = createNotImplementedStub(
  "x_salsa20_poly1305_shared_secret_export"
);
export const xSalsa20Poly1305SharedSecretIngest = createNotImplementedStub(
  "x_salsa20_poly1305_shared_secret_ingest"
);

// DNA info version 2
export const dnaInfo2 = createNullStub("dna_info_2");
