/**
 * Host Function Registry
 *
 * Manages registration and import of Holochain host functions.
 */

import { CallContext } from "../call-context";
import { HostFunctionImpl, wrapHostFunction } from "./base";

// Import all host functions
import { agentInfo } from "./agent_info";
import { dnaInfo } from "./dna_info";
import { zomeInfo } from "./zome_info";
import { callInfo } from "./call_info";
import { randomBytes } from "./random_bytes";
import { sysTime } from "./sys_time";
import { trace } from "./trace";
import { hash } from "./hash";
import { sign } from "./sign";
import { signEphemeral } from "./sign_ephemeral";
import { verifySignature } from "./verify_signature";
import { create } from "./create";
import { get } from "./get";
import { update } from "./update";
import { deleteEntry } from "./delete";
import { query } from "./query";
import { createLink } from "./create_link";
import { getLinks } from "./get_links";
import { deleteLink } from "./delete_link";
import { countLinks } from "./count_links";
import { mustGetEntry } from "./must_get_entry";
import { mustGetAction } from "./must_get_action";
import { mustGetValidRecord } from "./must_get_valid_record";
import { allocate } from "./allocate";
import { deallocate } from "./deallocate";
import { emit_signal } from "./emit_signal";
import * as stubs from "./stubs";

/**
 * Registry for host functions
 *
 * Manages the collection of available host functions and builds
 * the import object for WASM instantiation.
 */
export class HostFunctionRegistry {
  private functions = new Map<string, HostFunctionImpl>();

  /**
   * Register a host function
   *
   * @param name - Host function name (e.g., "__hc__agent_info_1")
   * @param impl - Host function implementation
   */
  registerHostFunction(name: string, impl: HostFunctionImpl): void {
    console.log(`[Ribosome] Registering host function: ${name}`);
    this.functions.set(name, impl);
  }

  /**
   * Build WASM import object for a specific call context
   *
   * Creates the import object with all registered host functions bound
   * to the current call context and WASM instance.
   *
   * @param instance - WASM instance (needed for memory access in host functions)
   * @param context - Current zome call context
   * @returns Import object for WebAssembly.instantiate
   */
  buildImportObject(
    instanceRef: { current: WebAssembly.Instance | null },
    context: CallContext
  ): WebAssembly.Imports {
    const env: Record<string, (ptr: number, len: number) => bigint> = {};

    for (const [name, impl] of this.functions.entries()) {
      const wrapped = wrapHostFunction(name, impl);
      env[name] = wrapped(instanceRef, context);
    }

    return { env };
  }

  /**
   * Get the number of registered host functions
   */
  get size(): number {
    return this.functions.size;
  }

  /**
   * Check if a host function is registered
   */
  has(name: string): boolean {
    return this.functions.has(name);
  }

  /**
   * Get all registered host function names
   */
  getNames(): string[] {
    return Array.from(this.functions.keys());
  }
}

/**
 * Global host function registry singleton
 */
let globalRegistry: HostFunctionRegistry | null = null;

/**
 * Initialize host function registry with all available host functions
 */
function initializeRegistry(): HostFunctionRegistry {
  const registry = new HostFunctionRegistry();

  // Register info host functions
  registry.registerHostFunction("__hc__agent_info_1", agentInfo);
  registry.registerHostFunction("__hc__dna_info_1", dnaInfo);
  registry.registerHostFunction("__hc__zome_info_1", zomeInfo);
  registry.registerHostFunction("__hc__call_info_1", callInfo);

  // Register utility host functions
  registry.registerHostFunction("__hc__random_bytes_1", randomBytes);
  registry.registerHostFunction("__hc__sys_time_1", sysTime);
  registry.registerHostFunction("__hc__trace_1", trace);
  registry.registerHostFunction("__hc__hash_1", hash);

  // Register memory management host functions
  registry.registerHostFunction("__hc__allocate_1", allocate);
  registry.registerHostFunction("__hc__deallocate_1", deallocate);

  // Register signing host functions
  registry.registerHostFunction("__hc__sign_1", sign);
  registry.registerHostFunction("__hc__sign_ephemeral_1", signEphemeral);
  registry.registerHostFunction("__hc__verify_signature_1", verifySignature);

  // Register CRUD host functions
  registry.registerHostFunction("__hc__create_1", create);
  registry.registerHostFunction("__hc__get_1", get);
  registry.registerHostFunction("__hc__update_1", update);
  registry.registerHostFunction("__hc__delete_1", deleteEntry);
  registry.registerHostFunction("__hc__query_1", query);

  // Register link host functions
  registry.registerHostFunction("__hc__create_link_1", createLink);
  registry.registerHostFunction("__hc__get_links_1", getLinks);
  registry.registerHostFunction("__hc__delete_link_1", deleteLink);
  registry.registerHostFunction("__hc__count_links_1", countLinks);

  // Register Priority 2 host functions (STUBS for Step 5.5 testing)
  registry.registerHostFunction("__hc__must_get_entry_1", mustGetEntry);
  registry.registerHostFunction("__hc__must_get_action_1", mustGetAction);
  registry.registerHostFunction(
    "__hc__must_get_valid_record_1",
    mustGetValidRecord
  );

  // Register all other stub host functions (Priority 2+)
  // DHT / Agent Activity
  registry.registerHostFunction(
    "__hc__get_agent_activity_1",
    stubs.getAgentActivity
  );
  registry.registerHostFunction(
    "__hc__must_get_agent_activity_1",
    stubs.mustGetAgentActivity
  );
  registry.registerHostFunction("__hc__get_details_1", stubs.getDetails);
  registry.registerHostFunction(
    "__hc__get_links_details_1",
    stubs.getLinksDetails
  );
  registry.registerHostFunction(
    "__hc__get_validation_receipts_1",
    stubs.getValidationReceipts
  );

  // Cross-zome/cell calls
  registry.registerHostFunction("__hc__call_1", stubs.call);

  // Signals
  registry.registerHostFunction("__hc__emit_signal_1", emit_signal);
  registry.registerHostFunction(
    "__hc__send_remote_signal_1",
    stubs.sendRemoteSignal
  );

  // Capabilities
  registry.registerHostFunction("__hc__capability_info_1", stubs.capabilityInfo);
  registry.registerHostFunction(
    "__hc__capability_claims_1",
    stubs.capabilityClaims
  );
  registry.registerHostFunction(
    "__hc__capability_grants_1",
    stubs.capabilityGrants
  );

  // Clone cells
  registry.registerHostFunction(
    "__hc__create_clone_cell_1",
    stubs.createCloneCell
  );
  registry.registerHostFunction(
    "__hc__delete_clone_cell_1",
    stubs.deleteCloneCell
  );
  registry.registerHostFunction(
    "__hc__enable_clone_cell_1",
    stubs.enableCloneCell
  );
  registry.registerHostFunction(
    "__hc__disable_clone_cell_1",
    stubs.disableCloneCell
  );

  // Chain management
  registry.registerHostFunction("__hc__close_chain_1", stubs.closeChain);
  registry.registerHostFunction("__hc__open_chain_1", stubs.openChain);

  // Agent blocking
  registry.registerHostFunction("__hc__block_agent_1", stubs.blockAgent);
  registry.registerHostFunction("__hc__unblock_agent_1", stubs.unblockAgent);

  // Scheduling
  registry.registerHostFunction("__hc__schedule_1", stubs.schedule);
  registry.registerHostFunction("__hc__sleep_1", stubs.sleep);

  // Countersigning
  registry.registerHostFunction(
    "__hc__accept_countersigning_preflight_request_1",
    stubs.acceptCountersigningPreflightRequest
  );

  // X25519 encryption
  registry.registerHostFunction(
    "__hc__create_x25519_keypair_1",
    stubs.createX25519Keypair
  );
  registry.registerHostFunction(
    "__hc__x_25519_x_salsa20_poly1305_encrypt_1",
    stubs.x25519XSalsa20Poly1305Encrypt
  );
  registry.registerHostFunction(
    "__hc__x_25519_x_salsa20_poly1305_decrypt_1",
    stubs.x25519XSalsa20Poly1305Decrypt
  );

  // Ed25519 + XSalsa20Poly1305 encryption
  registry.registerHostFunction(
    "__hc__ed_25519_x_salsa20_poly1305_encrypt_1",
    stubs.ed25519XSalsa20Poly1305Encrypt
  );
  registry.registerHostFunction(
    "__hc__ed_25519_x_salsa20_poly1305_decrypt_1",
    stubs.ed25519XSalsa20Poly1305Decrypt
  );

  // XSalsa20Poly1305 shared secret encryption
  registry.registerHostFunction(
    "__hc__x_salsa20_poly1305_encrypt_1",
    stubs.xSalsa20Poly1305Encrypt
  );
  registry.registerHostFunction(
    "__hc__x_salsa20_poly1305_decrypt_1",
    stubs.xSalsa20Poly1305Decrypt
  );
  registry.registerHostFunction(
    "__hc__x_salsa20_poly1305_shared_secret_create_random_1",
    stubs.xSalsa20Poly1305SharedSecretCreateRandom
  );
  registry.registerHostFunction(
    "__hc__x_salsa20_poly1305_shared_secret_export_1",
    stubs.xSalsa20Poly1305SharedSecretExport
  );
  registry.registerHostFunction(
    "__hc__x_salsa20_poly1305_shared_secret_ingest_1",
    stubs.xSalsa20Poly1305SharedSecretIngest
  );

  // DNA info version 2
  registry.registerHostFunction("__hc__dna_info_2", stubs.dnaInfo2);

  console.log(
    `[Ribosome] Initialized registry with ${registry.size} host functions`
  );

  return registry;
}

/**
 * Get or create the global host function registry
 *
 * @returns Global host function registry instance
 */
export function getHostFunctionRegistry(): HostFunctionRegistry {
  if (!globalRegistry) {
    globalRegistry = initializeRegistry();
  }
  return globalRegistry;
}
