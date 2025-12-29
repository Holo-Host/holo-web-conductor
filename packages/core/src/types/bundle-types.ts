/**
 * Holochain Bundle Type Definitions
 * Based on holochain_types v0.6 Rust structures
 */

import type { DnaHash, EntryHash } from '@holochain/client';
import type { EntryDef } from './holochain-types';

// ============================================================================
// App Manifest Types (happ.yaml)
// ============================================================================

export interface AppManifestV0 {
  manifest_version: "0";
  name: string;
  description?: string;
  roles: AppRoleManifest[];
  allow_deferred_memproofs?: boolean;
}

export interface AppRoleManifest {
  name: string;
  provisioning?: CellProvisioning;
  dna: AppRoleDnaManifest;
}

export type CellProvisioning =
  | { Create: { deferred: boolean } }
  | "CloneOnly";

export interface AppRoleDnaManifest {
  path?: string;  // Path to DNA bundle within .happ
  modifiers?: DnaModifiers;
  installed_hash?: string;  // Base64-encoded DnaHash
  clone_limit?: number;
}

export interface DnaModifiers {
  network_seed?: string;
  properties?: Record<string, unknown>;
  origin_time?: number;
  quantum_time?: number;
}

// ============================================================================
// DNA Manifest Types (dna.yaml)
// ============================================================================

export interface DnaManifestV0 {
  manifest_version: "0";
  name: string;
  integrity: IntegrityManifest;
  coordinator: CoordinatorManifest;
}

export interface IntegrityManifest {
  network_seed?: string;
  properties?: Record<string, unknown>;
  origin_time?: number;
  zomes: ZomeManifest[];
}

export interface CoordinatorManifest {
  zomes: ZomeManifest[];
}

export interface ZomeManifest {
  name: string;
  hash?: string;  // Base64-encoded WasmHash (optional)
  path: string;   // Relative path to WASM in bundle
  dependencies?: ZomeDependency[];
}

export interface ZomeDependency {
  name: string;
}

// ============================================================================
// Bundle Structures
// ============================================================================

export interface Bundle<M> {
  manifest: M;
  resources: Map<string, Uint8Array>;
}

export type AppBundle = Bundle<AppManifestV0>;
export type DnaBundle = Bundle<DnaManifestV0>;

// ============================================================================
// Runtime Types (what we extract and use)
// ============================================================================

export interface DnaManifestRuntime {
  /** DNA name */
  name: string;

  /** Network seed for this DNA */
  network_seed?: string;

  /** DNA properties */
  properties?: Record<string, unknown>;

  /** Integrity zomes */
  integrity_zomes: ZomeDefinition[];

  /** Coordinator zomes */
  coordinator_zomes: ZomeDefinition[];
}

export interface ZomeDefinition {
  /** Zome name */
  name: string;

  /** Zome index in DNA */
  index: number;

  /** WASM hash (if provided in manifest) */
  wasm_hash?: Uint8Array;

  /** WASM bytes */
  wasm?: Uint8Array;

  /** Dependencies on other zomes */
  dependencies: string[];

  /** Entry definitions (cached from WASM entry_defs callback) */
  entryDefs?: EntryDef[];

  /** Link types (cached from WASM link_types callback) */
  linkTypes?: unknown[];  // TODO: Add proper LinkType type when implementing link functionality

  /** Count of link types (from link_types callback) */
  linkTypeCount?: number;
}

// ============================================================================
// Errors
// ============================================================================

export class BundleError extends Error {
  constructor(
    message: string,
    public code: string,
    public cause?: Error
  ) {
    super(message);
    this.name = 'BundleError';
  }
}

export const BundleErrorCode = {
  INVALID_FORMAT: 'INVALID_FORMAT',
  GZIP_FAILED: 'GZIP_FAILED',
  MSGPACK_FAILED: 'MSGPACK_FAILED',
  YAML_FAILED: 'YAML_FAILED',
  MISSING_RESOURCE: 'MISSING_RESOURCE',
  INVALID_MANIFEST: 'INVALID_MANIFEST',
} as const;
