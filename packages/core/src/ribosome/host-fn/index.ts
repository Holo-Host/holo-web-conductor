/**
 * Host Function Registry
 *
 * Manages registration and import of Holochain host functions.
 */

import { CallContext } from "../call-context";
import { HostFunctionImpl, wrapHostFunction } from "./base";

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
    instance: WebAssembly.Instance,
    context: CallContext
  ): WebAssembly.Imports {
    const env: Record<string, (ptr: number) => bigint> = {};

    for (const [name, impl] of this.functions.entries()) {
      const wrapped = wrapHostFunction(name, impl);
      env[name] = wrapped(instance, context);
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

  // Import and register info host functions
  const { agentInfo } = require("./agent_info");
  const { dnaInfo } = require("./dna_info");
  const { zomeInfo } = require("./zome_info");
  const { callInfo } = require("./call_info");

  registry.registerHostFunction("__hc__agent_info_1", agentInfo);
  registry.registerHostFunction("__hc__dna_info_1", dnaInfo);
  registry.registerHostFunction("__hc__zome_info_1", zomeInfo);
  registry.registerHostFunction("__hc__call_info_1", callInfo);

  // Import and register utility host functions
  const { randomBytes } = require("./random_bytes");
  const { sysTime } = require("./sys_time");
  const { trace } = require("./trace");
  const { hash } = require("./hash");

  registry.registerHostFunction("__hc__random_bytes_1", randomBytes);
  registry.registerHostFunction("__hc__sys_time_1", sysTime);
  registry.registerHostFunction("__hc__trace_1", trace);
  registry.registerHostFunction("__hc__hash_1", hash);

  // Import and register signing host functions
  const { sign } = require("./sign");
  const { signEphemeral } = require("./sign_ephemeral");
  const { verifySignature } = require("./verify_signature");

  registry.registerHostFunction("__hc__sign_1", sign);
  registry.registerHostFunction("__hc__sign_ephemeral_1", signEphemeral);
  registry.registerHostFunction("__hc__verify_signature_1", verifySignature);

  // Import and register CRUD host functions
  const { create } = require("./create");
  const { get } = require("./get");
  const { update } = require("./update");
  const { deleteEntry } = require("./delete");
  const { query } = require("./query");

  registry.registerHostFunction("__hc__create_1", create);
  registry.registerHostFunction("__hc__get_1", get);
  registry.registerHostFunction("__hc__update_1", update);
  registry.registerHostFunction("__hc__delete_1", deleteEntry);
  registry.registerHostFunction("__hc__query_1", query);

  // Import and register link host functions
  const { createLink } = require("./create_link");
  const { getLinks } = require("./get_links");
  const { deleteLink } = require("./delete_link");
  const { countLinks } = require("./count_links");

  registry.registerHostFunction("__hc__create_link_1", createLink);
  registry.registerHostFunction("__hc__get_links_1", getLinks);
  registry.registerHostFunction("__hc__delete_link_1", deleteLink);
  registry.registerHostFunction("__hc__count_links_query_1", countLinks);

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
