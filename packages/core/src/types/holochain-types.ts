/**
 * Holochain Type Definitions for Host Function Input/Output
 *
 * This file contains TypeScript type definitions for Holochain types that are not
 * available in holochain-client-js but are needed for host function implementation.
 *
 * Types are based on Rust definitions from:
 * /home/eric/code/metacurrency/holochain/holochain/crates/holochain_zome_types/
 * /home/eric/code/metacurrency/holochain/holochain/crates/holochain_integrity_types/
 */

// Import reusable types from @holochain/client
import type {
  AgentPubKey,
  ActionHash,
  EntryHash,
  DnaHash,
  AnyDhtHash,
  Action,
  Entry,
  Record,
  Link,
  SignedActionHashed,
  Timestamp,
} from '@holochain/client';

// Re-export commonly used types for convenience
export type {
  AgentPubKey,
  ActionHash,
  EntryHash,
  DnaHash,
  AnyDhtHash,
  Action,
  Entry,
  Record,
  Link,
  SignedActionHashed,
  Timestamp,
};

// ============================================================================
// Chain and Entry Types
// ============================================================================

/**
 * Chain top ordering for action creation
 */
export type ChainTopOrdering = 'Strict' | 'Relaxed';

/**
 * Entry visibility
 */
export type EntryVisibility = 'Public' | 'Private';

/**
 * Get strategy for retrieval operations
 */
export type GetStrategy = 'Network' | 'Local';

/**
 * Options for get operations
 */
export interface GetOptions {
  strategy: GetStrategy;
}

/**
 * App entry definition location
 */
export interface AppEntryDefLocation {
  zome_index: number;
  entry_def_index: number;
}

/**
 * Entry definition location (discriminated union)
 */
export type EntryDefLocation =
  | { App: AppEntryDefLocation }
  | 'CapClaim'
  | 'CapGrant';

/**
 * Entry definition ID
 *
 * Source: holochain/crates/holochain_integrity_types/src/entry_def.rs
 * ```rust
 * pub enum EntryDefId {
 *     App(AppEntryName),
 *     CapClaim,
 *     CapGrant,
 * }
 * pub struct AppEntryName(pub Cow<'static, str>);
 * ```
 */
export type EntryDefId =
  | { App: string }  // AppEntryName serializes as string
  | 'CapClaim'
  | 'CapGrant';

/**
 * Required validations count (0-50)
 *
 * Source: holochain/crates/holochain_integrity_types/src/entry_def.rs
 * ```rust
 * pub type RequiredValidations = u8;
 * const DEFAULT_REQUIRED_VALIDATIONS: u8 = 5;
 * ```
 */
export type RequiredValidations = number;

/**
 * Entry definition for a zome entry type
 *
 * Source: holochain/crates/holochain_integrity_types/src/entry_def.rs
 * ```rust
 * pub struct EntryDef {
 *     pub id: EntryDefId,
 *     pub visibility: EntryVisibility,
 *     pub required_validations: RequiredValidations,
 *     pub cache_at_agent_activity: bool,
 * }
 * ```
 */
export interface EntryDef {
  /** Zome-unique identifier for this entry type */
  id: EntryDefId;
  /** Public or Private */
  visibility: EntryVisibility;
  /** How many validations to receive before considered "network saturated" (max 50) */
  required_validations: RequiredValidations;
  /** Should this entry be cached with agent activity authorities */
  cache_at_agent_activity: boolean;
}

/**
 * All entry definitions for an integrity zome
 *
 * Source: holochain/crates/holochain_integrity_types/src/entry_def.rs
 * ```rust
 * pub struct EntryDefs(pub Vec<EntryDef>);
 * ```
 */
export type EntryDefs = EntryDef[];

/**
 * Result from entry_defs callback
 *
 * Source: holochain/crates/holochain_integrity_types/src/entry_def.rs
 * ```rust
 * pub enum EntryDefsCallbackResult {
 *     Defs(EntryDefs),
 * }
 * ```
 */
export interface EntryDefsCallbackResult {
  Defs: EntryDefs;
}

// ============================================================================
// CRUD Operation Input Types
// ============================================================================

/**
 * Input for create_entry host function
 */
export interface CreateInput {
  entry_location: EntryDefLocation;
  entry_visibility: EntryVisibility;
  entry: Entry;
  chain_top_ordering: ChainTopOrdering;
}

/**
 * Input for update host function
 */
export interface UpdateInput {
  original_action_address: ActionHash;
  entry: Entry;
  chain_top_ordering: ChainTopOrdering;
}

/**
 * Input for delete/delete_entry host function
 */
export interface DeleteInput {
  deletes_action_hash: ActionHash;
  chain_top_ordering: ChainTopOrdering;
}

/**
 * Input for get host function
 */
export interface GetInput {
  any_dht_hash: AnyDhtHash;
  get_options: GetOptions;
}

// ============================================================================
// Link Operation Input Types
// ============================================================================

/**
 * Any linkable hash (EntryHash, ActionHash, or external hash)
 */
export type AnyLinkableHash = EntryHash | ActionHash;

/**
 * Link type filter for get_links
 */
export type LinkTypeFilter =
  | { Type: Array<[number, number[]]> }  // [zome_index, [link_types]]
  | { Dependencies: number[] };          // [zome_indices]

/**
 * Input for create_link host function
 */
export interface CreateLinkInput {
  base_address: AnyLinkableHash;
  target_address: AnyLinkableHash;
  zome_index: number;
  link_type: number;
  tag: Uint8Array;
  chain_top_ordering: ChainTopOrdering;
}

/**
 * Input for delete_link host function
 */
export interface DeleteLinkInput {
  address: ActionHash;
  chain_top_ordering: ChainTopOrdering;
  get_options: GetOptions;
}

/**
 * Input for get_links host function
 */
export interface GetLinksInput {
  base_address: AnyLinkableHash;
  link_type: LinkTypeFilter;
  get_options: GetOptions;
  tag_prefix?: Uint8Array;
  after?: Timestamp;
  before?: Timestamp;
  author?: AgentPubKey;
}

// ============================================================================
// Must Get Input Types (Newtypes)
// ============================================================================

/**
 * Input for must_get_entry host function
 */
export type MustGetEntryInput = EntryHash;

/**
 * Input for must_get_action host function
 */
export type MustGetActionInput = ActionHash;

// ============================================================================
// Signal Types
// ============================================================================

/**
 * App signal payload (ExternIO wrapper - msgpack-encoded bytes)
 */
export type AppSignal = Uint8Array;

// ============================================================================
// Retrieval Operation Return Types
// ============================================================================

/**
 * Record entry variants
 */
export type RecordEntry =
  | { Present: Entry }
  | 'Hidden'
  | 'NotApplicable'
  | 'NotStored';

/**
 * Validation status for records
 */
export type ValidationStatus =
  | 'Valid'
  | 'Invalid'
  | 'Rejected'
  | 'Abandoned';

/**
 * Entry DHT status
 */
export type EntryDhtStatus = 'Live' | 'Dead';

/**
 * Record details (returned by get_details for ActionHash)
 */
export interface RecordDetails {
  record: Record;
  validation_status: ValidationStatus;
  deletes: SignedActionHashed[];
  updates: SignedActionHashed[];
}

/**
 * Entry details (returned by get_details for EntryHash)
 */
export interface EntryDetails {
  entry: Entry;
  actions: SignedActionHashed[];
  rejected_actions: SignedActionHashed[];
  deletes: SignedActionHashed[];
  updates: SignedActionHashed[];
  entry_dht_status: EntryDhtStatus;
}

/**
 * Details union type (returned by get_details)
 */
export type Details =
  | { Record: RecordDetails }
  | { Entry: EntryDetails };

/**
 * Link details (returned by get_link_details)
 * Each element is: [CreateLink action, [DeleteLink actions]]
 */
export type LinkDetails = Array<[SignedActionHashed, SignedActionHashed[]]>;

// ============================================================================
// Hash Type Detection Utilities
// ============================================================================

/**
 * Hash prefixes from Holochain
 * Source: holochain/crates/holo_hash/src/hash_type/primitive.rs
 */
const ENTRY_PREFIX = [0x84, 0x21, 0x24]; // uhCEk [132, 33, 36]
const ACTION_PREFIX = [0x84, 0x29, 0x24]; // uhCkk [132, 41, 36]
const AGENT_PREFIX = [0x84, 0x20, 0x24]; // uhCAk [132, 32, 36] - treated as entry

/**
 * Check if a hash is an entry hash (or agent hash, which is treated as entry)
 */
export function isEntryHash(hash: Uint8Array): boolean {
  if (hash.length < 3) return false;
  return (
    (hash[0] === ENTRY_PREFIX[0] && hash[1] === ENTRY_PREFIX[1] && hash[2] === ENTRY_PREFIX[2]) ||
    (hash[0] === AGENT_PREFIX[0] && hash[1] === AGENT_PREFIX[1] && hash[2] === AGENT_PREFIX[2])
  );
}

/**
 * Check if a hash is an action hash
 */
export function isActionHash(hash: Uint8Array): boolean {
  if (hash.length < 3) return false;
  return hash[0] === ACTION_PREFIX[0] && hash[1] === ACTION_PREFIX[1] && hash[2] === ACTION_PREFIX[2];
}

/**
 * Hash type enum for dispatch
 */
export type HashType = 'Entry' | 'Action' | 'Unknown';

/**
 * Determine the type of a hash from its prefix
 */
export function getHashType(hash: Uint8Array): HashType {
  if (isActionHash(hash)) return 'Action';
  if (isEntryHash(hash)) return 'Entry';
  return 'Unknown';
}
