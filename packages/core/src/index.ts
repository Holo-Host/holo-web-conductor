/**
 * @fishy/core - Core Holochain conductor functionality
 *
 * This package implements the browser-based Holochain conductor,
 * including:
 * - Ribosome host functions
 * - WASM execution
 * - hApp context management
 * - Source chain operations
 */

// Re-export shared types
export * from "@fishy/shared";

// Placeholder - conductor interface to be implemented
export interface Conductor {
  // Install a hApp from a web context
  installHapp(config: HappInstallConfig): Promise<void>;

  // Call a zome function
  callZome(request: ZomeCallRequest): Promise<unknown>;
}

export interface HappInstallConfig {
  // Domain-based context identifier
  domain: string;
  // WASM bytes for each DNA
  dnas: DnaConfig[];
}

export interface DnaConfig {
  hash: Uint8Array;
  wasm: Uint8Array;
}

export interface ZomeCallRequest {
  cellId: [Uint8Array, Uint8Array]; // [DnaHash, AgentPubKey]
  zome: string;
  fn: string;
  payload: unknown;
}

export const VERSION = "0.0.1";
