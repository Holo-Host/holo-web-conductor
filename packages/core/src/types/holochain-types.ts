/**
 * Holochain Type Definitions for Host Function Input/Output
 *
 * This file contains TypeScript type definitions for Holochain types.
 * Types are imported from @holochain/client when available, with additional
 * types defined for host function implementation based on Rust definitions from:
 * /home/eric/code/metacurrency/holochain/holochain/crates/holochain_zome_types/
 * /home/eric/code/metacurrency/holochain/holochain/crates/holochain_integrity_types/
 */

// ============================================================================
// Imports and Re-exports from @holochain/client
// ============================================================================

// Hash types
import type {
  HoloHash,
  AgentPubKey,
  ActionHash,
  EntryHash,
  DnaHash,
  AnyDhtHash,
  ExternalHash,
  Signature,
  CellId,
  Timestamp,
  HoloHashed,
} from '@holochain/client';

// Action types - ActionType is imported as value (used in type guards)
import { ActionType } from '@holochain/client';
import type {
  Action,
  SignedAction,
  SignedActionHashed,
  ActionHashed,
  Create,
  Update,
  Delete,
  CreateLink,
  DeleteLink,
  Dna as DnaAction,
  AgentValidationPkg,
  InitZomesComplete,
  OpenChain,
  CloseChain,
  NewEntryAction,
} from '@holochain/client';

// Entry types
import type {
  Entry,
  EntryType,
  AppEntryDef,
  EntryVisibility as ClientEntryVisibility,
  EntryDhtStatus as ClientEntryDhtStatus,
  EntryDetails as ClientEntryDetails,
} from '@holochain/client';

// Record types
import type {
  Record,
  RecordEntry as ClientRecordEntry,
  RecordDetails as ClientRecordDetails,
} from '@holochain/client';

// Link types
import type {
  Link,
  AnyLinkableHash as ClientAnyLinkableHash,
  LinkType as ClientLinkType,
  LinkTag,
  ZomeIndex,
  RateWeight,
} from '@holochain/client';

// Details types
import type {
  Details as ClientDetails,
  DetailsType,
} from '@holochain/client';

// Utilities - these are values not types, import directly
import {
  encodeHashToBase64,
  decodeHashFromBase64,
} from '@holochain/client';

// Re-export hash types
export type {
  HoloHash,
  AgentPubKey,
  ActionHash,
  EntryHash,
  DnaHash,
  AnyDhtHash,
  ExternalHash,
  Signature,
  CellId,
  Timestamp,
  HoloHashed,
};

// Re-export Action types
export type {
  Action,
  SignedAction,
  SignedActionHashed,
  ActionHashed,
  Create,
  Update,
  Delete,
  CreateLink,
  DeleteLink,
  NewEntryAction,
};
export { ActionType };

// Re-export Entry types
export type {
  Entry,
  EntryType,
  AppEntryDef,
  LinkTag,
  ZomeIndex,
  RateWeight,
};

// Re-export Record and Link types
export type { Record, Link };

// Re-export Details types
export { DetailsType };

// Re-export utilities
export { encodeHashToBase64, decodeHashFromBase64 };

// ============================================================================
// Action Format Type Aliases
// ============================================================================

/**
 * WireAction - Action format used in network/WASM communication
 *
 * This is the format that comes from @holochain/client and is used when
 * communicating with Holochain or encoding/decoding for WASM.
 *
 * Uses `type: ActionType.Create` (enum discriminant)
 *
 * Note: The storage layer uses a different format (StoredAction) with string literals.
 * See `storage/types.ts` for the storage format.
 */
export type WireAction = Action;

/**
 * WireSignedActionHashed - SignedActionHashed using wire format
 */
export type WireSignedActionHashed = SignedActionHashed;

// ============================================================================
// Chain and Entry Types (fishy-specific extensions)
// ============================================================================

/**
 * Chain top ordering for action creation
 */
export type ChainTopOrdering = 'Strict' | 'Relaxed';

/**
 * Entry visibility - use string literals for internal representation
 * Compatible with ClientEntryVisibility from @holochain/client
 */
export type EntryVisibility = ClientEntryVisibility;

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
 * Any linkable hash (EntryHash, ActionHash, or ExternalHash)
 * Using the type from @holochain/client
 */
export type AnyLinkableHash = ClientAnyLinkableHash;

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
 * Record entry variants - compatible with @holochain/client RecordEntry
 * Note: Client uses { Hidden: void } etc, we use string for simplicity in fishy
 */
export type RecordEntry = ClientRecordEntry;

/**
 * Validation status for records
 */
export type ValidationStatus =
  | 'Valid'
  | 'Invalid'
  | 'Rejected'
  | 'Abandoned';

/**
 * Entry DHT status - compatible with @holochain/client EntryDhtStatus
 */
export type EntryDhtStatus = 'live' | 'dead';

/**
 * Record details (returned by get_details for ActionHash)
 * Using client type for consistency
 */
export type RecordDetails = ClientRecordDetails;

/**
 * Entry details (returned by get_details for EntryHash)
 * Using client type for consistency
 */
export type EntryDetails = ClientEntryDetails;

/**
 * Details union type (returned by get_details)
 * Note: @holochain/client uses DetailsType enum with type/content pattern
 */
export type Details = ClientDetails;

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

// ============================================================================
// Action Type Guards
// ============================================================================

/**
 * Type guard for Create action
 */
export function isCreateAction(action: Action): action is Create {
  return action.type === ActionType.Create;
}

/**
 * Type guard for Update action
 */
export function isUpdateAction(action: Action): action is Update {
  return action.type === ActionType.Update;
}

/**
 * Type guard for Delete action
 */
export function isDeleteAction(action: Action): action is Delete {
  return action.type === ActionType.Delete;
}

/**
 * Type guard for CreateLink action
 */
export function isCreateLinkAction(action: Action): action is CreateLink {
  return action.type === ActionType.CreateLink;
}

/**
 * Type guard for DeleteLink action
 */
export function isDeleteLinkAction(action: Action): action is DeleteLink {
  return action.type === ActionType.DeleteLink;
}

/**
 * Type guard for NewEntryAction (Create or Update - actions that create entries)
 */
export function isNewEntryAction(action: Action): action is NewEntryAction {
  return action.type === ActionType.Create || action.type === ActionType.Update;
}

/**
 * Type guard for Dna action
 */
export function isDnaAction(action: Action): action is DnaAction {
  return action.type === ActionType.Dna;
}

/**
 * Type guard for AgentValidationPkg action
 */
export function isAgentValidationPkgAction(action: Action): action is AgentValidationPkg {
  return action.type === ActionType.AgentValidationPkg;
}

/**
 * Type guard for InitZomesComplete action
 */
export function isInitZomesCompleteAction(action: Action): action is InitZomesComplete {
  return action.type === ActionType.InitZomesComplete;
}

// ============================================================================
// Utility Type Guards
// ============================================================================

/**
 * Type guard for Uint8Array
 */
export function isUint8Array(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array;
}

/**
 * Type guard for HoloHash (any 39-byte Uint8Array with valid prefix)
 */
export function isHoloHash(value: unknown): value is HoloHash {
  return isUint8Array(value) && value.length === 39;
}

/**
 * Type guard for CellId (tuple of [DnaHash, AgentPubKey])
 */
export function isCellId(value: unknown): value is CellId {
  if (!Array.isArray(value) || value.length !== 2) return false;
  return isHoloHash(value[0]) && isHoloHash(value[1]);
}
