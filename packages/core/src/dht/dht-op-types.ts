/**
 * DhtOp Types for DHT Publishing
 *
 * These types represent the DHT operations generated from source chain records.
 * Based on Holochain's dht_op.rs:
 * https://github.com/holochain/holochain/blob/main/crates/holochain_types/src/dht_op.rs
 *
 * DhtOps are the unit of DHT gossip - they notify authorities of new data.
 */

import type {
  Action,
  ActionHash,
  AgentPubKey,
  AnyLinkableHash,
  Create,
  CreateLink,
  Delete,
  DeleteLink,
  Entry,
  EntryHash,
  NewEntryAction,
  Signature,
  Update,
} from "@holochain/client";

// ============================================================================
// OpBasis - The basis hash for DHT authority determination
// ============================================================================

/**
 * OpBasis determines which agents will receive a DhtOp.
 * It's the hash that maps to DHT space locations.
 *
 * In Holochain, this is `AnyLinkableHash` which can be:
 * - EntryHash
 * - ActionHash
 * - AgentPubKey (treated as EntryHash)
 * - ExternalHash
 */
export type OpBasis = AnyLinkableHash;

// ============================================================================
// ChainOpType - Unit enum for op type identification
// ============================================================================

/**
 * ChainOpType identifies the type of chain operation without the data.
 *
 * Source: holochain/crates/holochain_zome_types/src/op.rs
 */
export enum ChainOpType {
  /** Store the full record (action + optional entry) at the action hash location */
  StoreRecord = "StoreRecord",
  /** Store the entry at the entry hash location */
  StoreEntry = "StoreEntry",
  /** Register this action in the agent's activity chain */
  RegisterAgentActivity = "RegisterAgentActivity",
  /** Register that an entry was updated (sent to original entry address) */
  RegisterUpdatedContent = "RegisterUpdatedContent",
  /** Register that a record was updated (sent to original action address) */
  RegisterUpdatedRecord = "RegisterUpdatedRecord",
  /** Register that an action was deleted (sent to deleted action address) */
  RegisterDeletedBy = "RegisterDeletedBy",
  /** Register that an entry's action was deleted (sent to entry address) */
  RegisterDeletedEntryAction = "RegisterDeletedEntryAction",
  /** Register a new link (sent to base address) */
  RegisterAddLink = "RegisterAddLink",
  /** Register link removal (sent to base address) */
  RegisterRemoveLink = "RegisterRemoveLink",
}

// ============================================================================
// RecordEntry - Entry state within a record/op
// ============================================================================

/**
 * RecordEntry represents the different ways an entry can be present in a record/op.
 *
 * Source: holochain/crates/holochain_integrity_types/src/record.rs
 *
 * Wire format: Unit variants (Hidden, NA, NotStored) serialize as strings in msgpack
 * via rmp_serde's externally-tagged enum representation. Present is a newtype variant
 * and serializes as a map { "Present": entry }.
 */
export type RecordEntry =
  | { Present: Entry }
  | "Hidden"
  | "NA"
  | "NotStored";

/**
 * Helper to create Present variant
 */
export function recordEntryPresent(entry: Entry): RecordEntry {
  return { Present: entry };
}

/**
 * Helper to create NA variant (no entry for this action type)
 */
export function recordEntryNA(): RecordEntry {
  return "NA";
}

/**
 * Helper to create Hidden variant (private entry)
 */
export function recordEntryHidden(): RecordEntry {
  return "Hidden";
}

/**
 * Check if RecordEntry has a present entry
 */
export function isRecordEntryPresent(
  entry: RecordEntry
): entry is { Present: Entry } {
  return typeof entry === "object" && "Present" in entry;
}

/**
 * Extract entry from RecordEntry if present
 */
export function getRecordEntry(entry: RecordEntry): Entry | null {
  if (isRecordEntryPresent(entry)) {
    return entry.Present;
  }
  return null;
}

// ============================================================================
// ChainOp - Full chain operation with data
// ============================================================================

/**
 * StoreRecord op - stores the full record at action hash location.
 * All action types produce this op.
 */
export interface StoreRecordOp {
  type: ChainOpType.StoreRecord;
  signature: Signature;
  action: Action;
  entry: RecordEntry;
}

/**
 * StoreEntry op - stores entry at entry hash location.
 * Only Create and Update actions produce this op.
 */
export interface StoreEntryOp {
  type: ChainOpType.StoreEntry;
  signature: Signature;
  action: NewEntryAction;
  entry: Entry;
}

/**
 * RegisterAgentActivity op - registers action in agent's activity.
 * All action types produce this op.
 */
export interface RegisterAgentActivityOp {
  type: ChainOpType.RegisterAgentActivity;
  signature: Signature;
  action: Action;
}

/**
 * RegisterUpdatedContent op - notifies original entry of update.
 * Only Update actions produce this op.
 */
export interface RegisterUpdatedContentOp {
  type: ChainOpType.RegisterUpdatedContent;
  signature: Signature;
  action: Update;
  entry: RecordEntry;
}

/**
 * RegisterUpdatedRecord op - notifies original action of update.
 * Only Update actions produce this op.
 */
export interface RegisterUpdatedRecordOp {
  type: ChainOpType.RegisterUpdatedRecord;
  signature: Signature;
  action: Update;
  entry: RecordEntry;
}

/**
 * RegisterDeletedBy op - notifies deleted action.
 * Only Delete actions produce this op.
 */
export interface RegisterDeletedByOp {
  type: ChainOpType.RegisterDeletedBy;
  signature: Signature;
  action: Delete;
}

/**
 * RegisterDeletedEntryAction op - notifies deleted entry.
 * Only Delete actions produce this op.
 */
export interface RegisterDeletedEntryActionOp {
  type: ChainOpType.RegisterDeletedEntryAction;
  signature: Signature;
  action: Delete;
}

/**
 * RegisterAddLink op - registers new link at base address.
 * Only CreateLink actions produce this op.
 */
export interface RegisterAddLinkOp {
  type: ChainOpType.RegisterAddLink;
  signature: Signature;
  action: CreateLink;
}

/**
 * RegisterRemoveLink op - registers link removal at base address.
 * Only DeleteLink actions produce this op.
 */
export interface RegisterRemoveLinkOp {
  type: ChainOpType.RegisterRemoveLink;
  signature: Signature;
  action: DeleteLink;
}

/**
 * ChainOp - A unit of DHT gossip concerning source chain data.
 *
 * This is the discriminated union of all chain operation types.
 */
export type ChainOp =
  | StoreRecordOp
  | StoreEntryOp
  | RegisterAgentActivityOp
  | RegisterUpdatedContentOp
  | RegisterUpdatedRecordOp
  | RegisterDeletedByOp
  | RegisterDeletedEntryActionOp
  | RegisterAddLinkOp
  | RegisterRemoveLinkOp;

// ============================================================================
// ChainOpLite - Lightweight version with just hashes
// ============================================================================

/**
 * ChainOpLite is a lightweight version of ChainOp that only contains hashes.
 * Used for database storage and gossip efficiency.
 */
export type ChainOpLite =
  | {
      type: ChainOpType.StoreRecord;
      actionHash: ActionHash;
      entryHash: EntryHash | null;
      basis: OpBasis;
    }
  | {
      type: ChainOpType.StoreEntry;
      actionHash: ActionHash;
      entryHash: EntryHash;
      basis: OpBasis;
    }
  | {
      type: ChainOpType.RegisterAgentActivity;
      actionHash: ActionHash;
      basis: OpBasis;
    }
  | {
      type: ChainOpType.RegisterUpdatedContent;
      actionHash: ActionHash;
      entryHash: EntryHash;
      basis: OpBasis;
    }
  | {
      type: ChainOpType.RegisterUpdatedRecord;
      actionHash: ActionHash;
      entryHash: EntryHash;
      basis: OpBasis;
    }
  | {
      type: ChainOpType.RegisterDeletedBy;
      actionHash: ActionHash;
      basis: OpBasis;
    }
  | {
      type: ChainOpType.RegisterDeletedEntryAction;
      actionHash: ActionHash;
      basis: OpBasis;
    }
  | {
      type: ChainOpType.RegisterAddLink;
      actionHash: ActionHash;
      basis: OpBasis;
    }
  | {
      type: ChainOpType.RegisterRemoveLink;
      actionHash: ActionHash;
      basis: OpBasis;
    };

// ============================================================================
// Action to OpTypes Mapping
// ============================================================================

/**
 * Get the op types that should be produced for a given action type.
 *
 * Source: holochain/crates/holochain_types/src/dht_op.rs (action_to_op_types)
 */
export function actionToOpTypes(action: Action): ChainOpType[] {
  switch (action.type) {
    // Genesis and chain management actions - only StoreRecord + RegisterAgentActivity
    case "Dna":
    case "OpenChain":
    case "CloseChain":
    case "AgentValidationPkg":
    case "InitZomesComplete":
      return [ChainOpType.StoreRecord, ChainOpType.RegisterAgentActivity];

    // Create entry - adds StoreEntry
    case "Create":
      return [
        ChainOpType.StoreRecord,
        ChainOpType.RegisterAgentActivity,
        ChainOpType.StoreEntry,
      ];

    // Update entry - adds StoreEntry + RegisterUpdatedContent + RegisterUpdatedRecord
    case "Update":
      return [
        ChainOpType.StoreRecord,
        ChainOpType.RegisterAgentActivity,
        ChainOpType.StoreEntry,
        ChainOpType.RegisterUpdatedContent,
        ChainOpType.RegisterUpdatedRecord,
      ];

    // Delete entry - adds RegisterDeletedBy + RegisterDeletedEntryAction
    case "Delete":
      return [
        ChainOpType.StoreRecord,
        ChainOpType.RegisterAgentActivity,
        ChainOpType.RegisterDeletedBy,
        ChainOpType.RegisterDeletedEntryAction,
      ];

    // Create link - adds RegisterAddLink
    case "CreateLink":
      return [
        ChainOpType.StoreRecord,
        ChainOpType.RegisterAgentActivity,
        ChainOpType.RegisterAddLink,
      ];

    // Delete link - adds RegisterRemoveLink
    case "DeleteLink":
      return [
        ChainOpType.StoreRecord,
        ChainOpType.RegisterAgentActivity,
        ChainOpType.RegisterRemoveLink,
      ];

    default:
      // Unknown action type - just the basics
      return [ChainOpType.StoreRecord, ChainOpType.RegisterAgentActivity];
  }
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard for Create action
 */
export function isCreateAction(action: Action): action is Create {
  return action.type === "Create";
}

/**
 * Type guard for Update action
 */
export function isUpdateAction(action: Action): action is Update {
  return action.type === "Update";
}

/**
 * Type guard for Delete action
 */
export function isDeleteAction(action: Action): action is Delete {
  return action.type === "Delete";
}

/**
 * Type guard for CreateLink action
 */
export function isCreateLinkAction(action: Action): action is CreateLink {
  return action.type === "CreateLink";
}

/**
 * Type guard for DeleteLink action
 */
export function isDeleteLinkAction(action: Action): action is DeleteLink {
  return action.type === "DeleteLink";
}

/**
 * Type guard for NewEntryAction (Create or Update)
 */
export function isNewEntryAction(action: Action): action is NewEntryAction {
  return action.type === "Create" || action.type === "Update";
}

// ============================================================================
// Publish Status Tracking
// ============================================================================

/**
 * Status of a DhtOp publication attempt
 */
export enum PublishStatus {
  /** Op created but not yet sent to linker */
  Pending = "Pending",
  /** Op sent to linker, awaiting confirmation */
  InFlight = "InFlight",
  /** Linker confirmed receipt and forwarding to DHT */
  Published = "Published",
  /** Publication failed (will retry) */
  Failed = "Failed",
}

/**
 * A pending publish record for tracking op publication
 */
export interface PendingPublish {
  /** Unique ID for this publish attempt */
  id: string;
  /** The operation to publish */
  op: ChainOp;
  /** The op's basis hash for DHT routing */
  basis: OpBasis;
  /** Current status */
  status: PublishStatus;
  /** Number of retry attempts */
  retryCount: number;
  /** Timestamp of last attempt */
  lastAttempt: number;
  /** Error message if failed */
  error?: string;
}
