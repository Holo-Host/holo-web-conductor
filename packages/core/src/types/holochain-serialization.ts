/**
 * Holochain Serialization Types
 *
 * TypeScript types that serialize to EXACTLY the same bytes as Holochain's Rust types.
 * These must be used for all actions that will be signed, as signature verification
 * compares against the serialized bytes.
 *
 * CRITICAL: The msgpack serialization must match Holochain's serde serialization:
 * - Field order matters (msgpack maps preserve insertion order)
 * - Newtype wrappers serialize transparently (ZomeIndex(5) -> 5)
 * - The Action enum uses internal tagging: {"type": "Create", ...fields}
 * - EntryType enum uses external tagging: {"App": {...}} or "AgentPubKey"
 * - LinkTag uses serde_bytes (binary format)
 *
 * Reference: holochain/crates/holochain_integrity_types/src/action.rs
 */

import { encode } from "@msgpack/msgpack";
import type {
  AgentPubKey,
  ActionHash,
  EntryHash,
  DnaHash,
  AnyLinkableHash,
} from "@holochain/client";

// =============================================================================
// Primitive Types (Newtype wrappers - serialize as inner value)
// =============================================================================

/** ZomeIndex - serializes as u8 */
export type ZomeIndex = number;

/** EntryDefIndex - serializes as u8 */
export type EntryDefIndex = number;

/** LinkType - serializes as u8 */
export type LinkType = number;

/** LinkTag - serializes as binary (Uint8Array) using msgpack bin type */
export type LinkTag = Uint8Array;

/** Timestamp - microseconds from UNIX epoch, serializes as i64 */
export type Timestamp = number;

/** RateBucketId - serializes as u8 */
export type RateBucketId = number;

/** RateUnits - serializes as u64 */
export type RateUnits = number;

/** RateBytes - serializes as u64 */
export type RateBytes = number;

// =============================================================================
// Rate Weight Types
// =============================================================================

/**
 * RateWeight - used for CreateLink, Delete, DeleteLink
 * Serialization order: bucket_id, units
 */
export interface RateWeight {
  bucket_id: RateBucketId;
  units: RateUnits;
}

/**
 * EntryRateWeight - used for Create, Update
 * Serialization order: bucket_id, units, rate_bytes
 */
export interface EntryRateWeight {
  bucket_id: RateBucketId;
  units: RateUnits;
  rate_bytes: RateBytes;
}

// =============================================================================
// Entry Types
// =============================================================================

/**
 * EntryVisibility - enum without serde rename
 * Serializes as string: "Public" or "Private"
 */
export type EntryVisibility = "Public" | "Private";

/**
 * AppEntryDef - struct for app entry definitions
 * Serialization order: entry_index, zome_index, visibility
 */
export interface AppEntryDef {
  entry_index: EntryDefIndex;
  zome_index: ZomeIndex;
  visibility: EntryVisibility;
}

/**
 * EntryType - externally tagged enum (serde default)
 *
 * Unit variants serialize as strings: "AgentPubKey", "CapClaim", "CapGrant"
 * Tuple variants serialize as objects: {"App": {...}}
 */
export type EntryType =
  | "AgentPubKey"
  | "CapClaim"
  | "CapGrant"
  | { App: AppEntryDef };

// =============================================================================
// Action Structs (field order is critical for serialization)
// =============================================================================

/**
 * Dna action struct
 * Field order: author, timestamp, hash
 */
export interface DnaActionContent {
  author: AgentPubKey;
  timestamp: Timestamp;
  hash: DnaHash;
}

/**
 * AgentValidationPkg action struct
 * Field order: author, timestamp, action_seq, prev_action, membrane_proof
 */
export interface AgentValidationPkgActionContent {
  author: AgentPubKey;
  timestamp: Timestamp;
  action_seq: number;
  prev_action: ActionHash;
  membrane_proof?: Uint8Array;
}

/**
 * InitZomesComplete action struct
 * Field order: author, timestamp, action_seq, prev_action
 */
export interface InitZomesCompleteActionContent {
  author: AgentPubKey;
  timestamp: Timestamp;
  action_seq: number;
  prev_action: ActionHash;
}

/**
 * Create action struct
 * Field order: author, timestamp, action_seq, prev_action, entry_type, entry_hash, weight
 */
export interface CreateActionContent {
  author: AgentPubKey;
  timestamp: Timestamp;
  action_seq: number;
  prev_action: ActionHash;
  entry_type: EntryType;
  entry_hash: EntryHash;
  weight: EntryRateWeight;
}

/**
 * Update action struct
 * Field order: author, timestamp, action_seq, prev_action,
 *              original_action_address, original_entry_address,
 *              entry_type, entry_hash, weight
 */
export interface UpdateActionContent {
  author: AgentPubKey;
  timestamp: Timestamp;
  action_seq: number;
  prev_action: ActionHash;
  original_action_address: ActionHash;
  original_entry_address: EntryHash;
  entry_type: EntryType;
  entry_hash: EntryHash;
  weight: EntryRateWeight;
}

/**
 * Delete action struct
 * Field order: author, timestamp, action_seq, prev_action,
 *              deletes_address, deletes_entry_address, weight
 */
export interface DeleteActionContent {
  author: AgentPubKey;
  timestamp: Timestamp;
  action_seq: number;
  prev_action: ActionHash;
  deletes_address: ActionHash;
  deletes_entry_address: EntryHash;
  weight: RateWeight;
}

/**
 * CreateLink action struct
 * Field order: author, timestamp, action_seq, prev_action,
 *              base_address, target_address, zome_index, link_type, tag, weight
 */
export interface CreateLinkActionContent {
  author: AgentPubKey;
  timestamp: Timestamp;
  action_seq: number;
  prev_action: ActionHash;
  base_address: AnyLinkableHash;
  target_address: AnyLinkableHash;
  zome_index: ZomeIndex;
  link_type: LinkType;
  tag: LinkTag;
  weight: RateWeight;
}

/**
 * DeleteLink action struct
 * Field order: author, timestamp, action_seq, prev_action,
 *              base_address, link_add_address
 */
export interface DeleteLinkActionContent {
  author: AgentPubKey;
  timestamp: Timestamp;
  action_seq: number;
  prev_action: ActionHash;
  base_address: AnyLinkableHash;
  link_add_address: ActionHash;
}

// =============================================================================
// Action Enum (internally tagged with "type" field)
// =============================================================================

/**
 * Action type names - match Rust enum variant names exactly
 */
export type ActionTypeName =
  | "Dna"
  | "AgentValidationPkg"
  | "InitZomesComplete"
  | "Create"
  | "Update"
  | "Delete"
  | "CreateLink"
  | "DeleteLink"
  | "OpenChain"
  | "CloseChain";

/**
 * Serializable Action - internally tagged enum
 *
 * The "type" field is added to the struct fields for serde internal tagging.
 * This produces: {"type": "Create", "author": ..., "timestamp": ..., ...}
 */
export type SerializableAction =
  | ({ type: "Dna" } & DnaActionContent)
  | ({ type: "AgentValidationPkg" } & AgentValidationPkgActionContent)
  | ({ type: "InitZomesComplete" } & InitZomesCompleteActionContent)
  | ({ type: "Create" } & CreateActionContent)
  | ({ type: "Update" } & UpdateActionContent)
  | ({ type: "Delete" } & DeleteActionContent)
  | ({ type: "CreateLink" } & CreateLinkActionContent)
  | ({ type: "DeleteLink" } & DeleteLinkActionContent);

// =============================================================================
// Serialization Functions
// =============================================================================

/**
 * Serialize an action to msgpack bytes in Holochain's format.
 *
 * This produces the exact bytes that Holochain signs and verifies against.
 * Field order is preserved in the serialization.
 */
export function serializeAction(action: SerializableAction): Uint8Array {
  // Create object with fields in exact order for serialization
  const ordered = createOrderedAction(action);
  return new Uint8Array(encode(ordered));
}

/**
 * Create an ordered object for serialization.
 * JavaScript preserves insertion order for string keys.
 */
function createOrderedAction(
  action: SerializableAction
): Record<string, unknown> {
  switch (action.type) {
    case "Dna":
      return {
        type: "Dna",
        author: action.author,
        timestamp: action.timestamp,
        hash: action.hash,
      };

    case "AgentValidationPkg":
      // membrane_proof is Option<T> in Rust - None serializes as null, not skipped
      return {
        type: "AgentValidationPkg",
        author: action.author,
        timestamp: action.timestamp,
        action_seq: action.action_seq,
        prev_action: action.prev_action,
        membrane_proof: action.membrane_proof ?? null,
      };

    case "InitZomesComplete":
      return {
        type: "InitZomesComplete",
        author: action.author,
        timestamp: action.timestamp,
        action_seq: action.action_seq,
        prev_action: action.prev_action,
      };

    case "Create":
      return {
        type: "Create",
        author: action.author,
        timestamp: action.timestamp,
        action_seq: action.action_seq,
        prev_action: action.prev_action,
        entry_type: action.entry_type,
        entry_hash: action.entry_hash,
        weight: {
          bucket_id: action.weight.bucket_id,
          units: action.weight.units,
          rate_bytes: action.weight.rate_bytes,
        },
      };

    case "Update":
      return {
        type: "Update",
        author: action.author,
        timestamp: action.timestamp,
        action_seq: action.action_seq,
        prev_action: action.prev_action,
        original_action_address: action.original_action_address,
        original_entry_address: action.original_entry_address,
        entry_type: action.entry_type,
        entry_hash: action.entry_hash,
        weight: {
          bucket_id: action.weight.bucket_id,
          units: action.weight.units,
          rate_bytes: action.weight.rate_bytes,
        },
      };

    case "Delete":
      return {
        type: "Delete",
        author: action.author,
        timestamp: action.timestamp,
        action_seq: action.action_seq,
        prev_action: action.prev_action,
        deletes_address: action.deletes_address,
        deletes_entry_address: action.deletes_entry_address,
        weight: {
          bucket_id: action.weight.bucket_id,
          units: action.weight.units,
        },
      };

    case "CreateLink":
      return {
        type: "CreateLink",
        author: action.author,
        timestamp: action.timestamp,
        action_seq: action.action_seq,
        prev_action: action.prev_action,
        base_address: action.base_address,
        target_address: action.target_address,
        zome_index: action.zome_index,
        link_type: action.link_type,
        tag: action.tag,
        weight: {
          bucket_id: action.weight.bucket_id,
          units: action.weight.units,
        },
      };

    case "DeleteLink":
      return {
        type: "DeleteLink",
        author: action.author,
        timestamp: action.timestamp,
        action_seq: action.action_seq,
        prev_action: action.prev_action,
        base_address: action.base_address,
        link_add_address: action.link_add_address,
      };

    default:
      throw new Error(`Unknown action type: ${(action as any).type}`);
  }
}

// =============================================================================
// Builder Functions (ensure correct field order)
// =============================================================================

/**
 * Create a Create action with correct field ordering
 */
export function buildCreateAction(params: {
  author: AgentPubKey;
  timestamp: Timestamp;
  action_seq: number;
  prev_action: ActionHash;
  entry_type: EntryType;
  entry_hash: EntryHash;
  weight?: EntryRateWeight;
}): SerializableAction & { type: "Create" } {
  return {
    type: "Create",
    author: params.author,
    timestamp: params.timestamp,
    action_seq: params.action_seq,
    prev_action: params.prev_action,
    entry_type: params.entry_type,
    entry_hash: params.entry_hash,
    weight: params.weight ?? { bucket_id: 0, units: 0, rate_bytes: 0 },
  };
}

/**
 * Create a CreateLink action with correct field ordering
 */
export function buildCreateLinkAction(params: {
  author: AgentPubKey;
  timestamp: Timestamp;
  action_seq: number;
  prev_action: ActionHash;
  base_address: AnyLinkableHash;
  target_address: AnyLinkableHash;
  zome_index: ZomeIndex;
  link_type: LinkType;
  tag: LinkTag;
  weight?: RateWeight;
}): SerializableAction & { type: "CreateLink" } {
  return {
    type: "CreateLink",
    author: params.author,
    timestamp: params.timestamp,
    action_seq: params.action_seq,
    prev_action: params.prev_action,
    base_address: params.base_address,
    target_address: params.target_address,
    zome_index: params.zome_index,
    link_type: params.link_type,
    tag: params.tag,
    weight: params.weight ?? { bucket_id: 0, units: 0 },
  };
}

/**
 * Create an Update action with correct field ordering
 */
export function buildUpdateAction(params: {
  author: AgentPubKey;
  timestamp: Timestamp;
  action_seq: number;
  prev_action: ActionHash;
  original_action_address: ActionHash;
  original_entry_address: EntryHash;
  entry_type: EntryType;
  entry_hash: EntryHash;
  weight?: EntryRateWeight;
}): SerializableAction & { type: "Update" } {
  return {
    type: "Update",
    author: params.author,
    timestamp: params.timestamp,
    action_seq: params.action_seq,
    prev_action: params.prev_action,
    original_action_address: params.original_action_address,
    original_entry_address: params.original_entry_address,
    entry_type: params.entry_type,
    entry_hash: params.entry_hash,
    weight: params.weight ?? { bucket_id: 0, units: 0, rate_bytes: 0 },
  };
}

/**
 * Create a Delete action with correct field ordering
 */
export function buildDeleteAction(params: {
  author: AgentPubKey;
  timestamp: Timestamp;
  action_seq: number;
  prev_action: ActionHash;
  deletes_address: ActionHash;
  deletes_entry_address: EntryHash;
  weight?: RateWeight;
}): SerializableAction & { type: "Delete" } {
  return {
    type: "Delete",
    author: params.author,
    timestamp: params.timestamp,
    action_seq: params.action_seq,
    prev_action: params.prev_action,
    deletes_address: params.deletes_address,
    deletes_entry_address: params.deletes_entry_address,
    weight: params.weight ?? { bucket_id: 0, units: 0 },
  };
}

/**
 * Create a DeleteLink action with correct field ordering
 */
export function buildDeleteLinkAction(params: {
  author: AgentPubKey;
  timestamp: Timestamp;
  action_seq: number;
  prev_action: ActionHash;
  base_address: AnyLinkableHash;
  link_add_address: ActionHash;
}): SerializableAction & { type: "DeleteLink" } {
  return {
    type: "DeleteLink",
    author: params.author,
    timestamp: params.timestamp,
    action_seq: params.action_seq,
    prev_action: params.prev_action,
    base_address: params.base_address,
    link_add_address: params.link_add_address,
  };
}

/**
 * Create a Dna action with correct field ordering
 */
export function buildDnaAction(params: {
  author: AgentPubKey;
  timestamp: Timestamp;
  hash: DnaHash;
}): SerializableAction & { type: "Dna" } {
  return {
    type: "Dna",
    author: params.author,
    timestamp: params.timestamp,
    hash: params.hash,
  };
}

/**
 * Create an AgentValidationPkg action with correct field ordering
 */
export function buildAgentValidationPkgAction(params: {
  author: AgentPubKey;
  timestamp: Timestamp;
  action_seq: number;
  prev_action: ActionHash;
  membrane_proof?: Uint8Array;
}): SerializableAction & { type: "AgentValidationPkg" } {
  return {
    type: "AgentValidationPkg",
    author: params.author,
    timestamp: params.timestamp,
    action_seq: params.action_seq,
    prev_action: params.prev_action,
    membrane_proof: params.membrane_proof,
  };
}

/**
 * Create an InitZomesComplete action with correct field ordering
 */
export function buildInitZomesCompleteAction(params: {
  author: AgentPubKey;
  timestamp: Timestamp;
  action_seq: number;
  prev_action: ActionHash;
}): SerializableAction & { type: "InitZomesComplete" } {
  return {
    type: "InitZomesComplete",
    author: params.author,
    timestamp: params.timestamp,
    action_seq: params.action_seq,
    prev_action: params.prev_action,
  };
}

/**
 * Create an AppEntryDef for use in entry_type
 */
export function buildAppEntryType(params: {
  entry_index: EntryDefIndex;
  zome_index: ZomeIndex;
  visibility?: EntryVisibility;
}): EntryType {
  return {
    App: {
      entry_index: params.entry_index,
      zome_index: params.zome_index,
      visibility: params.visibility ?? "Public",
    },
  };
}
