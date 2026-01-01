/**
 * WASM Input/Output Types and Validators
 *
 * Type definitions for data exchanged between host functions and WASM,
 * with optional runtime validation for development.
 *
 * Type definitions are based on Holochain HDK types from:
 * - holochain_zome_types/src/entry.rs (CreateInput, UpdateInput)
 * - holochain_zome_types/src/query.rs (ChainQueryFilter)
 * - holochain_zome_types/src/link.rs (CreateLinkInput, GetLinksInput)
 */

import type {
  ActionHash,
  EntryHash,
  AnyDhtHash,
  AnyLinkableHash,
  GetOptions,
  ChainTopOrdering,
} from '../types/holochain-types';

// ============================================================================
// Global validation flag - set to true during development to catch format errors
// ============================================================================

/** Enable runtime validation of WASM inputs (development mode) */
export let WASM_INPUT_VALIDATION_ENABLED = true;

/** Set the validation flag (useful for testing or production optimization) */
export function setWasmInputValidation(enabled: boolean): void {
  WASM_INPUT_VALIDATION_ENABLED = enabled;
}

// ============================================================================
// Type validator function signature
// ============================================================================

/** Type guard function that validates unknown data matches expected type T */
export type TypeValidator<T> = (input: unknown) => input is T;

// ============================================================================
// Entry types
// ============================================================================

/** Entry visibility - Public or Private */
export type EntryVisibility = 'Public' | 'Private';

/** Entry definition location for App entries */
export interface EntryDefLocation {
  App: {
    zome_index: number;
    entry_def_index: number;
  };
}

// ============================================================================
// Create Input
// ============================================================================

/**
 * WASM Create input structure
 * Based on holochain_zome_types/src/entry.rs CreateInput
 *
 * struct CreateInput {
 *   entry_location: EntryDefLocation,
 *   entry_visibility: EntryVisibility,
 *   entry: Entry,
 *   chain_top_ordering: ChainTopOrdering,
 * }
 */
export interface WasmCreateInput {
  /** Entry location with zome and entry def indices */
  entry_location: EntryDefLocation;

  /** Entry visibility */
  entry_visibility: EntryVisibility;

  /** Entry wrapper with type and content */
  entry: {
    entry_type: 'App' | 'Agent' | 'CapClaim' | 'CapGrant';
    entry: Uint8Array;  // MessagePack-serialized entry content
  };

  /** Chain top ordering */
  chain_top_ordering: ChainTopOrdering;
}

export function validateWasmCreateInput(input: unknown): input is WasmCreateInput {
  if (!input || typeof input !== 'object') return false;
  const i = input as Record<string, unknown>;

  // Check entry_location
  if (!i.entry_location || typeof i.entry_location !== 'object') return false;
  const loc = i.entry_location as Record<string, unknown>;
  if (!loc.App || typeof loc.App !== 'object') return false;
  const app = loc.App as Record<string, unknown>;
  if (typeof app.zome_index !== 'number' || typeof app.entry_def_index !== 'number') return false;

  // Check entry_visibility
  if (i.entry_visibility !== 'Public' && i.entry_visibility !== 'Private') return false;

  // Check entry
  if (!i.entry || typeof i.entry !== 'object') return false;
  const entry = i.entry as Record<string, unknown>;
  if (!['App', 'Agent', 'CapClaim', 'CapGrant'].includes(entry.entry_type as string)) return false;
  if (!(entry.entry instanceof Uint8Array)) return false;

  // Check chain_top_ordering
  if (i.chain_top_ordering !== 'Strict' && i.chain_top_ordering !== 'Relaxed') return false;

  return true;
}

// ============================================================================
// Get Input
// ============================================================================

/**
 * WASM Get input structure - matches HDK's GetInput serialization
 */
export interface WasmGetInput {
  /** Hash of the action or entry to get */
  any_dht_hash: AnyDhtHash;
  /** Get options */
  get_options?: GetOptions;
}

export function validateWasmGetInput(input: unknown): input is WasmGetInput {
  if (!input || typeof input !== 'object') return false;
  const i = input as Record<string, unknown>;

  // Check any_dht_hash is a Uint8Array (39-byte hash)
  if (!(i.any_dht_hash instanceof Uint8Array)) return false;
  if ((i.any_dht_hash as Uint8Array).length !== 39) return false;

  // get_options is optional
  if (i.get_options !== undefined) {
    if (typeof i.get_options !== 'object' || i.get_options === null) return false;
  }

  return true;
}

/** Validates array of WasmGetInput (HDK passes array for batch operations) */
export function validateWasmGetInputArray(inputs: unknown): inputs is WasmGetInput[] {
  if (!Array.isArray(inputs)) return false;
  if (inputs.length === 0) return false;
  return inputs.every(validateWasmGetInput);
}

// ============================================================================
// Update Input
// ============================================================================

/**
 * WASM Update input structure
 * Based on holochain_zome_types/src/entry.rs UpdateInput
 */
export interface WasmUpdateInput {
  /** Original action address to update */
  original_action_address: ActionHash;

  /** Entry wrapper with type and content */
  entry: {
    entry_type: 'App' | 'Agent' | 'CapClaim' | 'CapGrant';
    entry: Uint8Array;  // MessagePack-serialized entry content
  };

  /** Chain top ordering */
  chain_top_ordering: ChainTopOrdering;
}

export function validateWasmUpdateInput(input: unknown): input is WasmUpdateInput {
  if (!input || typeof input !== 'object') return false;
  const i = input as Record<string, unknown>;

  // Check original_action_address
  if (!(i.original_action_address instanceof Uint8Array)) return false;
  if ((i.original_action_address as Uint8Array).length !== 39) return false;

  // Check entry
  if (!i.entry || typeof i.entry !== 'object') return false;
  const entry = i.entry as Record<string, unknown>;
  if (!['App', 'Agent', 'CapClaim', 'CapGrant'].includes(entry.entry_type as string)) return false;
  if (!(entry.entry instanceof Uint8Array)) return false;

  // Check chain_top_ordering
  if (i.chain_top_ordering !== 'Strict' && i.chain_top_ordering !== 'Relaxed') return false;

  return true;
}

// ============================================================================
// Delete Input
// ============================================================================

/**
 * WASM Delete input structure
 * Based on holochain_zome_types/src/entry.rs DeleteInput
 *
 * struct DeleteInput {
 *   deletes_action_hash: ActionHash,
 *   chain_top_ordering: ChainTopOrdering,
 * }
 */
export interface WasmDeleteInput {
  /** Hash of the action to delete (not entry hash) */
  deletes_action_hash: ActionHash;

  /** Chain top ordering */
  chain_top_ordering: ChainTopOrdering;
}

export function validateWasmDeleteInput(input: unknown): input is WasmDeleteInput {
  if (!input || typeof input !== 'object') return false;
  const i = input as Record<string, unknown>;

  // Check deletes_action_hash is a 39-byte Uint8Array
  if (!(i.deletes_action_hash instanceof Uint8Array)) return false;
  if ((i.deletes_action_hash as Uint8Array).length !== 39) return false;

  // Check chain_top_ordering
  if (i.chain_top_ordering !== 'Strict' && i.chain_top_ordering !== 'Relaxed') return false;

  return true;
}

// ============================================================================
// Query Input (ChainQueryFilter)
// ============================================================================

/**
 * Chain query filter range enum variants
 * Based on holochain_zome_types/src/query.rs ChainQueryFilterRange
 */
export type ChainQueryFilterRange =
  | 'Unbounded'
  | { ActionSeqRange: [number, number] }
  | { ActionHashRange: [ActionHash, ActionHash] }
  | { ActionHashTerminated: [ActionHash, number] };

/**
 * WASM Query input structure (ChainQueryFilter)
 * Based on holochain_zome_types/src/query.rs ChainQueryFilter
 */
export interface WasmQueryInput {
  /** Limit results to a range of records */
  sequence_range?: ChainQueryFilterRange;

  /** Filter by entry types (array for OR query) */
  entry_type?: Array<{
    App?: { zome_index: number; entry_index: number };
    Agent?: null;
    CapClaim?: null;
    CapGrant?: null;
  }>;

  /** Filter by entry hashes */
  entry_hashes?: EntryHash[];

  /** Filter by action types (array for OR query) */
  action_type?: string[];

  /** Include entries in results */
  include_entries?: boolean;

  /** Order descending (default ascending) */
  order_descending?: boolean;
}

export function validateWasmQueryInput(input: unknown): input is WasmQueryInput {
  if (!input || typeof input !== 'object') return false;
  const i = input as Record<string, unknown>;

  // All fields are optional or nullable
  // include_entries and order_descending should be booleans if present and not null
  if (i.include_entries !== undefined && i.include_entries !== null && typeof i.include_entries !== 'boolean') return false;
  if (i.order_descending !== undefined && i.order_descending !== null && typeof i.order_descending !== 'boolean') return false;

  // action_type should be array of strings if present and not null
  if (i.action_type !== undefined && i.action_type !== null) {
    if (!Array.isArray(i.action_type)) return false;
  }

  // sequence_range can be 'Unbounded' string or an object variant
  if (i.sequence_range !== undefined && i.sequence_range !== null) {
    if (typeof i.sequence_range !== 'string' && typeof i.sequence_range !== 'object') return false;
  }

  return true;
}

// ============================================================================
// GetLinks Input
// ============================================================================

/**
 * WASM GetLinks input structure
 * Based on holochain_zome_types/src/link.rs GetLinksInput
 */
export interface WasmGetLinksInput {
  /** Base hash to get links from */
  base_address: AnyLinkableHash;

  /** Link type filter */
  link_type: number | { types: number[] } | 'Dependencies';

  /** Optional tag prefix filter */
  tag_prefix?: Uint8Array;

  /** Get options */
  get_options?: GetOptions;
}

export function validateWasmGetLinksInput(input: unknown): input is WasmGetLinksInput {
  if (!input || typeof input !== 'object') return false;
  const i = input as Record<string, unknown>;

  // Check base_address is a Uint8Array (39-byte hash)
  if (!(i.base_address instanceof Uint8Array)) return false;
  if ((i.base_address as Uint8Array).length !== 39) return false;

  // link_type can be number, object with types array, or 'Dependencies'
  if (i.link_type === undefined) return false;
  if (typeof i.link_type !== 'number' &&
      typeof i.link_type !== 'string' &&
      typeof i.link_type !== 'object') return false;

  return true;
}

/** Validates array of WasmGetLinksInput (HDK may pass array) */
export function validateWasmGetLinksInputArray(inputs: unknown): inputs is WasmGetLinksInput[] {
  if (!Array.isArray(inputs)) return false;
  if (inputs.length === 0) return false;
  return inputs.every(validateWasmGetLinksInput);
}

// ============================================================================
// CreateLink Input
// ============================================================================

/**
 * WASM CreateLink input structure
 * Based on holochain_zome_types/src/link.rs CreateLinkInput
 */
export interface WasmCreateLinkInput {
  /** Base hash */
  base_address: AnyLinkableHash;

  /** Target hash */
  target_address: AnyLinkableHash;

  /** Zome index */
  zome_index: number;

  /** Link type index */
  link_type: number;

  /** Optional tag */
  tag?: Uint8Array;

  /** Chain top ordering */
  chain_top_ordering: ChainTopOrdering;
}

export function validateWasmCreateLinkInput(input: unknown): input is WasmCreateLinkInput {
  if (!input || typeof input !== 'object') return false;
  const i = input as Record<string, unknown>;

  // Check base_address
  if (!(i.base_address instanceof Uint8Array)) return false;
  if ((i.base_address as Uint8Array).length !== 39) return false;

  // Check target_address
  if (!(i.target_address instanceof Uint8Array)) return false;
  if ((i.target_address as Uint8Array).length !== 39) return false;

  // Check zome_index and link_type
  if (typeof i.zome_index !== 'number') return false;
  if (typeof i.link_type !== 'number') return false;

  // Check chain_top_ordering
  if (i.chain_top_ordering !== 'Strict' && i.chain_top_ordering !== 'Relaxed') return false;

  return true;
}

// ============================================================================
// DeleteLink Input
// ============================================================================

/**
 * WASM DeleteLink input structure
 */
export interface WasmDeleteLinkInput {
  /** Hash of the CreateLink action to delete */
  link_add_address: ActionHash;

  /** Chain top ordering */
  chain_top_ordering: ChainTopOrdering;
}

export function validateWasmDeleteLinkInput(input: unknown): input is WasmDeleteLinkInput {
  if (!input || typeof input !== 'object') return false;
  const i = input as Record<string, unknown>;

  // Check link_add_address
  if (!(i.link_add_address instanceof Uint8Array)) return false;
  if ((i.link_add_address as Uint8Array).length !== 39) return false;

  // Check chain_top_ordering
  if (i.chain_top_ordering !== 'Strict' && i.chain_top_ordering !== 'Relaxed') return false;

  return true;
}
