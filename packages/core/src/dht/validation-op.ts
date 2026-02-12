/**
 * Validation Op Types
 *
 * The Op type for app validation callbacks, distinct from ChainOp used for
 * DHT publishing/gossip. These types match Holochain's
 * holochain_integrity_types/src/op.rs
 *
 * Key difference from ChainOp:
 * - ChainOp: tuple-variant format for DHT gossip (e.g., StoreRecord(sig, action, entry))
 * - Op: struct-variant format for WASM validation (e.g., StoreRecord { record: Record })
 *
 * Serialization: Op is externally tagged (serde default):
 *   { "StoreRecord": { "record": { ... } } }
 */

import type {
  Action,
  ActionHash,
  Create,
  CreateLink,
  Delete,
  DeleteLink,
  Entry,
  Record,
  Signature,
  SignedActionHashed,
  Update,
} from "@holochain/client";

import type { PendingRecord } from "../ribosome/call-context";
import { buildRecord } from "./record-converter";
import {
  ChainOpType,
  actionToOpTypes,
  isCreateAction,
  isCreateLinkAction,
  isDeleteAction,
  isDeleteLinkAction,
  isNewEntryAction,
  isUpdateAction,
} from "./dht-op-types";

// ============================================================================
// Generic SignedHashed<T>
// ============================================================================

/**
 * SignedHashed<T> - generic wrapper matching Holochain's SignedHashed.
 *
 * Structure: { hashed: { content: T, hash: ActionHash }, signature: Signature }
 */
export interface SignedHashed<T> {
  hashed: { content: T; hash: ActionHash };
  signature: Signature;
}

// ============================================================================
// EntryCreationAction
// ============================================================================

/**
 * EntryCreationAction - externally tagged enum.
 *
 * Matches Rust's EntryCreationAction which derives Serialize without
 * a serde(tag) attribute, so it serializes externally:
 *   { "Create": { author, timestamp, ... } }
 *   { "Update": { author, timestamp, ... } }
 *
 * The inner struct does NOT have a "type" field (that only exists in
 * the internally-tagged Action enum).
 */
export type EntryCreationAction =
  | { Create: Omit<Create, "type"> }
  | { Update: Omit<Update, "type"> };

// ============================================================================
// Op Variant Data Types
// ============================================================================

export interface StoreRecordData {
  record: Record;
}

export interface StoreEntryData {
  action: SignedHashed<EntryCreationAction>;
  entry: Entry;
}

export interface RegisterUpdateData {
  update: SignedHashed<Omit<Update, "type">>;
  new_entry: Entry | null;
}

export interface RegisterDeleteData {
  delete: SignedHashed<Omit<Delete, "type">>;
}

export interface RegisterAgentActivityData {
  action: SignedActionHashed;
  cached_entry: Entry | null;
}

export interface RegisterCreateLinkData {
  create_link: SignedHashed<Omit<CreateLink, "type">>;
}

export interface RegisterDeleteLinkData {
  delete_link: SignedHashed<Omit<DeleteLink, "type">>;
  create_link: Omit<CreateLink, "type">;
}

// ============================================================================
// Op - Externally Tagged Union
// ============================================================================

/**
 * Op - the app validation operation type.
 *
 * Externally tagged to match Rust's serde default:
 *   { "StoreRecord": { "record": Record } }
 *   { "StoreEntry": { "action": SignedHashed<EntryCreationAction>, "entry": Entry } }
 *   etc.
 *
 * Every Action produces StoreRecord + RegisterAgentActivity.
 * Create also produces StoreEntry.
 * Update also produces StoreEntry + RegisterUpdate.
 * Delete also produces RegisterDelete.
 * CreateLink also produces RegisterCreateLink.
 * DeleteLink also produces RegisterDeleteLink.
 */
export type Op =
  | { StoreRecord: StoreRecordData }
  | { StoreEntry: StoreEntryData }
  | { RegisterUpdate: RegisterUpdateData }
  | { RegisterDelete: RegisterDeleteData }
  | { RegisterAgentActivity: RegisterAgentActivityData }
  | { RegisterCreateLink: RegisterCreateLinkData }
  | { RegisterDeleteLink: RegisterDeleteLinkData };

// ============================================================================
// Op Construction Helpers
// ============================================================================

/**
 * Resolver function for fetching original CreateLink action.
 * Used by RegisterDeleteLink ops that need the original link data.
 */
export type CreateLinkResolver = (
  linkAddAddress: ActionHash
) => Omit<CreateLink, "type"> | null;

/**
 * Strip the "type" field from an action.
 *
 * Holochain's Action enum is internally tagged (#[serde(tag = "type")]),
 * so TypeScript Action types include a "type" field. But when actions
 * appear inside Op variants as plain structs (Update, Delete, CreateLink,
 * DeleteLink), the "type" field must be stripped.
 */
function stripType<T extends { type: string }>(
  action: T
): Omit<T, "type"> {
  const { type: _type, ...rest } = action;
  return rest as Omit<T, "type">;
}

/**
 * Build an EntryCreationAction from a Create or Update action.
 *
 * Wraps the action in externally-tagged format:
 *   Create action → { "Create": { author, timestamp, ... } }
 *   Update action → { "Update": { author, timestamp, ... } }
 */
function buildEntryCreationAction(
  action: Action
): EntryCreationAction {
  if (isCreateAction(action)) {
    return { Create: stripType(action) };
  }
  if (isUpdateAction(action)) {
    return { Update: stripType(action) };
  }
  throw new Error(
    `Cannot build EntryCreationAction from action type: ${action.type}`
  );
}

/**
 * Extract entry from a Record's RecordEntry field.
 */
function extractEntry(record: Record): Entry | undefined {
  const re = record.entry;
  if (re && "Present" in re) {
    return re.Present;
  }
  return undefined;
}

// ============================================================================
// Op Building
// ============================================================================

/**
 * Build an Op from a Record and a ChainOpType.
 *
 * Maps ChainOpType to the corresponding Op variant, matching Holochain's
 * record_to_op + chain_op_to_op pipeline from app_validation_workflow.rs.
 *
 * ChainOpType → Op mapping:
 * - StoreRecord → Op::StoreRecord
 * - StoreEntry → Op::StoreEntry
 * - RegisterAgentActivity → Op::RegisterAgentActivity
 * - RegisterUpdatedContent/RegisterUpdatedRecord → Op::RegisterUpdate
 * - RegisterDeletedBy/RegisterDeletedEntryAction → Op::RegisterDelete
 * - RegisterAddLink → Op::RegisterCreateLink
 * - RegisterRemoveLink → Op::RegisterDeleteLink (needs resolveCreateLink)
 *
 * @param record - The @holochain/client Record
 * @param opType - Which ChainOpType to build
 * @param resolveCreateLink - Optional resolver for RegisterDeleteLink ops
 * @returns The Op, or null if it cannot be built
 */
export function buildOpFromRecord(
  record: Record,
  opType: ChainOpType,
  resolveCreateLink?: CreateLinkResolver
): Op | null {
  const action = record.signed_action.hashed.content;
  const actionHash = record.signed_action.hashed.hash;
  const signature = record.signed_action.signature;
  const entry = extractEntry(record);

  switch (opType) {
    case ChainOpType.StoreRecord:
      return {
        StoreRecord: { record },
      };

    case ChainOpType.StoreEntry: {
      if (!isNewEntryAction(action) || !entry) return null;
      const entryCreationAction = buildEntryCreationAction(action);
      return {
        StoreEntry: {
          action: {
            hashed: { content: entryCreationAction, hash: actionHash },
            signature,
          },
          entry,
        },
      };
    }

    case ChainOpType.RegisterAgentActivity:
      return {
        RegisterAgentActivity: {
          action: record.signed_action,
          cached_entry: null,
        },
      };

    case ChainOpType.RegisterUpdatedContent:
    case ChainOpType.RegisterUpdatedRecord: {
      if (!isUpdateAction(action)) return null;
      return {
        RegisterUpdate: {
          update: {
            hashed: { content: stripType(action), hash: actionHash },
            signature,
          },
          new_entry: entry ?? null,
        },
      };
    }

    case ChainOpType.RegisterDeletedBy:
    case ChainOpType.RegisterDeletedEntryAction: {
      if (!isDeleteAction(action)) return null;
      return {
        RegisterDelete: {
          delete: {
            hashed: { content: stripType(action), hash: actionHash },
            signature,
          },
        },
      };
    }

    case ChainOpType.RegisterAddLink: {
      if (!isCreateLinkAction(action)) return null;
      return {
        RegisterCreateLink: {
          create_link: {
            hashed: { content: stripType(action), hash: actionHash },
            signature,
          },
        },
      };
    }

    case ChainOpType.RegisterRemoveLink: {
      if (!isDeleteLinkAction(action)) return null;
      if (!resolveCreateLink) return null;
      const originalCreateLink = resolveCreateLink(action.link_add_address);
      if (!originalCreateLink) return null;
      return {
        RegisterDeleteLink: {
          delete_link: {
            hashed: { content: stripType(action), hash: actionHash },
            signature,
          },
          create_link: originalCreateLink,
        },
      };
    }

    default:
      return null;
  }
}

/**
 * Convert a Record to all its validation Ops.
 *
 * Follows the same flow as Holochain's inline_validation:
 * 1. Get op types from actionToOpTypes()
 * 2. For each op type, build the corresponding Op
 *
 * @param record - The @holochain/client Record
 * @param resolveCreateLink - Optional resolver for RegisterDeleteLink ops
 * @returns Array of Ops for validation
 */
export function recordToOps(
  record: Record,
  resolveCreateLink?: CreateLinkResolver
): Op[] {
  const action = record.signed_action.hashed.content;
  const opTypes = actionToOpTypes(action);
  const ops: Op[] = [];

  for (const opType of opTypes) {
    const op = buildOpFromRecord(record, opType, resolveCreateLink);
    if (op) {
      ops.push(op);
    }
  }

  return ops;
}

/**
 * Convert a PendingRecord to all its validation Ops.
 *
 * Convenience wrapper that first converts PendingRecord to @holochain/client
 * Record format, then builds Ops.
 *
 * @param pendingRecord - The pending record from callContext
 * @param resolveCreateLink - Optional resolver for RegisterDeleteLink ops
 * @returns Array of Ops for validation
 */
export function pendingRecordToOps(
  pendingRecord: PendingRecord,
  resolveCreateLink?: CreateLinkResolver
): Op[] {
  const record = buildRecord(pendingRecord.action, pendingRecord.entry);
  return recordToOps(record, resolveCreateLink);
}

// ============================================================================
// Op Accessors
// ============================================================================

/**
 * Get the Op variant name (for logging/debugging).
 */
export function getOpVariant(op: Op): string {
  if ("StoreRecord" in op) return "StoreRecord";
  if ("StoreEntry" in op) return "StoreEntry";
  if ("RegisterUpdate" in op) return "RegisterUpdate";
  if ("RegisterDelete" in op) return "RegisterDelete";
  if ("RegisterAgentActivity" in op) return "RegisterAgentActivity";
  if ("RegisterCreateLink" in op) return "RegisterCreateLink";
  if ("RegisterDeleteLink" in op) return "RegisterDeleteLink";
  return "Unknown";
}
