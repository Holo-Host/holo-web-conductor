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

// Import proper Holochain hash types for use in interfaces
import type {
  DnaHash,
  AgentPubKey,
  CellId,
} from "@holochain/client";

// Re-export shared types
export * from "@fishy/shared";

// Re-export proper Holochain hash types from @holochain/client
export type {
  AgentPubKey,
  ActionHash,
  EntryHash,
  DnaHash,
  AnyDhtHash,
  CellId,
} from "@holochain/client";

// Re-export Holochain type guards and utilities
export {
  isAgentPubKey,
  extractEd25519PubKey,
  isEntryHash,
  isActionHash,
  isHoloHash,
  isCellId,
  getHashType,
} from './types/holochain-types';

// Re-export bundle types
export * from './bundle';
export type { DnaManifestRuntime } from './types/bundle-types';

// Re-export storage types and classes
export * from './storage';

// Re-export network module
export * from './network';

// Re-export DHT module
export * from './dht';

// Re-export hash module (excluding ActionType which is re-exported from storage)
export {
  computeEntryHash,
  computeAppEntryHash,
  computeAgentEntryHash,
  computeActionHash,
  computeWasmHash,
  computeDnaHash,
  blake2b256,
  assembleHoloHash,
  ENTRY_HASH_PREFIX,
  ACTION_HASH_PREFIX,
  AGENT_PUBKEY_PREFIX,
  DNA_HASH_PREFIX,
  WASM_HASH_PREFIX,
  hashFrom32AndType,
  dhtLocationFrom32,
  HASH_TYPE_PREFIX,
  HoloHashType,
  type ActionForHashing,
  type IntegrityZomeForHash,
  type DnaModifiersForHash,
} from './hash';

// Re-export utilities
export * from './utils';

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
  /** DNA hash (39-byte HoloHash) */
  hash: DnaHash;
  /** WASM bytes */
  wasm: Uint8Array;
  name?: string;
  properties?: Record<string, unknown>;
}

export interface ZomeCallRequest {
  /** Cell ID: [DnaHash, AgentPubKey] */
  cellId: CellId;
  zome: string;
  fn: string;
  payload: unknown;
}

/**
 * hApp context - associates a domain with DNAs and agent identity
 */
export interface HappContext {
  /** Unique context ID (UUID v4) */
  id: string;

  /** Domain this context is for (e.g., "https://example.com") */
  domain: string;

  /** Agent public key (39-byte HoloHash) for this context */
  agentPubKey: AgentPubKey;

  /** Tag in Lair keystore for agent key */
  agentKeyTag: string;

  /** DNAs in this hApp */
  dnas: DnaContext[];

  /** Installation metadata */
  appName?: string;
  appVersion?: string;
  installedAt: number;
  lastUsed: number;

  /** Whether this context is enabled */
  enabled: boolean;
}

/**
 * DNA context within a hApp
 */
export interface DnaContext {
  /** DNA hash (39-byte HoloHash) */
  hash: DnaHash;

  /** WASM bytes (stored in IndexedDB) */
  wasm: Uint8Array;

  /** DNA name/identifier */
  name?: string;

  /** Properties for this DNA */
  properties?: Record<string, unknown>;

  /** DNA manifest (from .happ bundle) */
  manifest?: import('./types/bundle-types').DnaManifestRuntime;
}

/**
 * Install request payload from web page
 */
export interface InstallHappRequest {
  /** App name (optional) */
  appName?: string;

  /** App version (optional) */
  appVersion?: string;

  /** .happ bundle bytes (gzipped MessagePack) */
  happBundle: Uint8Array;
}

export const VERSION = "0.0.1";
