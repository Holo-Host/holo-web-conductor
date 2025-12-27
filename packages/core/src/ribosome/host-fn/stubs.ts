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
export const getDetails = createNullStub("get_details");
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
