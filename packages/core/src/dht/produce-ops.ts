/**
 * Produce DhtOps from Records
 *
 * This module implements the logic for generating DhtOps from source chain records.
 * Based on Holochain's produce_ops_from_record function in:
 * https://github.com/holochain/holochain/blob/main/crates/holochain_types/src/dht_op.rs
 */

import type {
  Action,
  ActionHash,
  AgentPubKey,
  Create,
  CreateLink,
  Delete,
  DeleteLink,
  Entry,
  EntryHash,
  NewEntryAction,
  Record,
  Signature,
  SignedActionHashed,
  Update,
} from "@holochain/client";

import {
  type ChainOp,
  type ChainOpLite,
  ChainOpType,
  type OpBasis,
  type RecordEntry,
  actionToOpTypes,
  isCreateAction,
  isCreateLinkAction,
  isDeleteAction,
  isDeleteLinkAction,
  isNewEntryAction,
  isUpdateAction,
  recordEntryNA,
  recordEntryPresent,
} from "./dht-op-types";

// ============================================================================
// OpBasis Computation
// ============================================================================

/**
 * Compute the OpBasis for a given op type and action.
 *
 * The basis determines which DHT agents will receive the op.
 *
 * Source: ChainOpUniqueForm::basis() in dht_op.rs
 *
 * @param opType - The type of operation
 * @param action - The action data
 * @param actionHash - The computed action hash
 * @returns The basis hash for DHT routing
 */
export function computeOpBasis(
  opType: ChainOpType,
  action: Action,
  actionHash: ActionHash
): OpBasis {
  switch (opType) {
    case ChainOpType.StoreRecord:
      // Basis is the action hash itself
      return actionHash;

    case ChainOpType.StoreEntry:
      // Basis is the entry hash from the action
      if (isCreateAction(action)) {
        return action.entry_hash;
      } else if (isUpdateAction(action)) {
        return action.entry_hash;
      }
      throw new Error(
        `StoreEntry op requires Create or Update action, got ${action.type}`
      );

    case ChainOpType.RegisterAgentActivity:
      // Basis is the author's agent pub key
      return action.author;

    case ChainOpType.RegisterUpdatedContent:
      // Basis is the original entry address being updated
      if (isUpdateAction(action)) {
        return action.original_entry_address;
      }
      throw new Error(
        `RegisterUpdatedContent op requires Update action, got ${action.type}`
      );

    case ChainOpType.RegisterUpdatedRecord:
      // Basis is the original action address being updated
      if (isUpdateAction(action)) {
        return action.original_action_address;
      }
      throw new Error(
        `RegisterUpdatedRecord op requires Update action, got ${action.type}`
      );

    case ChainOpType.RegisterDeletedBy:
      // Basis is the action address being deleted
      if (isDeleteAction(action)) {
        return action.deletes_address;
      }
      throw new Error(
        `RegisterDeletedBy op requires Delete action, got ${action.type}`
      );

    case ChainOpType.RegisterDeletedEntryAction:
      // Basis is the entry address being deleted
      if (isDeleteAction(action)) {
        return action.deletes_entry_address;
      }
      throw new Error(
        `RegisterDeletedEntryAction op requires Delete action, got ${action.type}`
      );

    case ChainOpType.RegisterAddLink:
      // Basis is the base address of the link
      if (isCreateLinkAction(action)) {
        return action.base_address;
      }
      throw new Error(
        `RegisterAddLink op requires CreateLink action, got ${action.type}`
      );

    case ChainOpType.RegisterRemoveLink:
      // Basis is the base address of the link being removed
      if (isDeleteLinkAction(action)) {
        return action.base_address;
      }
      throw new Error(
        `RegisterRemoveLink op requires DeleteLink action, got ${action.type}`
      );

    default:
      throw new Error(`Unknown op type: ${opType}`);
  }
}

// ============================================================================
// RecordEntry Construction
// ============================================================================

/**
 * Create a RecordEntry from an optional entry based on action type.
 *
 * @param action - The action to check for entry data
 * @param entry - The optional entry data
 * @returns The appropriate RecordEntry variant
 */
function createRecordEntry(action: Action, entry: Entry | undefined): RecordEntry {
  // If action doesn't have entry data, return NA
  if (!isNewEntryAction(action)) {
    return recordEntryNA();
  }

  // If entry is present, return Present
  if (entry) {
    return recordEntryPresent(entry);
  }

  // Entry should be present but isn't - could be private or not stored
  // For now, return NA (caller should handle private entries separately)
  return recordEntryNA();
}

// ============================================================================
// Op Production
// ============================================================================

/**
 * Extract entry from a Record.
 *
 * Records can have entries in different states (Present, Hidden, NA, NotStored).
 * This function extracts the actual entry data if present.
 */
function extractEntryFromRecord(record: Record): Entry | undefined {
  const recordEntry = record.entry;

  // RecordEntry wire format: "NA" | "Hidden" | "NotStored" (strings) or { Present: Entry } (map)
  if (recordEntry && typeof recordEntry === "object" && "Present" in recordEntry) {
    return recordEntry.Present;
  }
  return undefined;
}

/**
 * Get the action hash from a SignedActionHashed.
 *
 * The hash should be computed by the caller, but we can get it from the
 * hashed property if available.
 */
function getActionHashFromRecord(record: Record): ActionHash {
  const signedHashed = record.signed_action;
  // ActionHashed has: hash, content
  return signedHashed.hashed.hash;
}

/**
 * Get the signature from a SignedActionHashed.
 */
function getSignatureFromRecord(record: Record): Signature {
  return record.signed_action.signature;
}

/**
 * Get the action from a SignedActionHashed.
 */
function getActionFromRecord(record: Record): Action {
  return record.signed_action.hashed.content;
}

/**
 * Produce all DhtOps for a Record.
 *
 * This is the main function that converts a source chain record into
 * the DhtOps that need to be published to the DHT.
 *
 * Based on: holochain/crates/holochain_types/src/dht_op.rs::produce_ops_from_record
 *
 * @param record - The source chain record to produce ops from
 * @returns Array of ChainOps to publish
 */
export function produceOpsFromRecord(record: Record): ChainOp[] {
  const action = getActionFromRecord(record);
  const signature = getSignatureFromRecord(record);
  const actionHash = getActionHashFromRecord(record);
  const entry = extractEntryFromRecord(record);

  // Get the op types for this action
  const opTypes = actionToOpTypes(action);

  const ops: ChainOp[] = [];

  for (const opType of opTypes) {
    const op = createOpFromType(opType, action, signature, entry, actionHash);
    if (op) {
      ops.push(op);
    }
  }

  return ops;
}

/**
 * Create a single ChainOp from its type and data.
 *
 * @param opType - The type of op to create
 * @param action - The action data
 * @param signature - The action signature
 * @param entry - The optional entry data
 * @param actionHash - The action hash (for basis computation)
 * @returns The ChainOp, or null if the op can't be created (e.g., private entry for StoreEntry)
 */
function createOpFromType(
  opType: ChainOpType,
  action: Action,
  signature: Signature,
  entry: Entry | undefined,
  actionHash: ActionHash
): ChainOp | null {
  switch (opType) {
    case ChainOpType.StoreRecord:
      return {
        type: ChainOpType.StoreRecord,
        signature,
        action,
        entry: createRecordEntry(action, entry),
      };

    case ChainOpType.StoreEntry:
      // StoreEntry requires the entry to be present
      // If entry is private (not provided), skip this op
      if (!isNewEntryAction(action)) {
        return null;
      }
      if (!entry) {
        // Entry is private, skip StoreEntry
        return null;
      }
      return {
        type: ChainOpType.StoreEntry,
        signature,
        action: action as NewEntryAction,
        entry,
      };

    case ChainOpType.RegisterAgentActivity:
      return {
        type: ChainOpType.RegisterAgentActivity,
        signature,
        action,
      };

    case ChainOpType.RegisterUpdatedContent:
      if (!isUpdateAction(action)) {
        return null;
      }
      return {
        type: ChainOpType.RegisterUpdatedContent,
        signature,
        action: action as Update,
        entry: createRecordEntry(action, entry),
      };

    case ChainOpType.RegisterUpdatedRecord:
      if (!isUpdateAction(action)) {
        return null;
      }
      return {
        type: ChainOpType.RegisterUpdatedRecord,
        signature,
        action: action as Update,
        entry: createRecordEntry(action, entry),
      };

    case ChainOpType.RegisterDeletedBy:
      if (!isDeleteAction(action)) {
        return null;
      }
      return {
        type: ChainOpType.RegisterDeletedBy,
        signature,
        action: action as Delete,
      };

    case ChainOpType.RegisterDeletedEntryAction:
      if (!isDeleteAction(action)) {
        return null;
      }
      return {
        type: ChainOpType.RegisterDeletedEntryAction,
        signature,
        action: action as Delete,
      };

    case ChainOpType.RegisterAddLink:
      if (!isCreateLinkAction(action)) {
        return null;
      }
      return {
        type: ChainOpType.RegisterAddLink,
        signature,
        action: action as CreateLink,
      };

    case ChainOpType.RegisterRemoveLink:
      if (!isDeleteLinkAction(action)) {
        return null;
      }
      return {
        type: ChainOpType.RegisterRemoveLink,
        signature,
        action: action as DeleteLink,
      };

    default:
      return null;
  }
}

/**
 * Produce lightweight op representations for a Record.
 *
 * This is useful for storage where we don't need the full action/entry data,
 * just the hashes and basis.
 *
 * @param record - The source chain record
 * @returns Array of ChainOpLite for storage
 */
export function produceOpLitesFromRecord(record: Record): ChainOpLite[] {
  const action = getActionFromRecord(record);
  const actionHash = getActionHashFromRecord(record);
  const entry = extractEntryFromRecord(record);

  // Get the op types for this action
  const opTypes = actionToOpTypes(action);

  const opLites: ChainOpLite[] = [];

  for (const opType of opTypes) {
    try {
      const basis = computeOpBasis(opType, action, actionHash);
      const opLite = createOpLiteFromType(opType, action, actionHash, basis);
      if (opLite) {
        opLites.push(opLite);
      }
    } catch {
      // Skip ops that can't be created for this action type
      continue;
    }
  }

  return opLites;
}

/**
 * Create a ChainOpLite from its type and hashes.
 */
function createOpLiteFromType(
  opType: ChainOpType,
  action: Action,
  actionHash: ActionHash,
  basis: OpBasis
): ChainOpLite | null {
  // Get entry hash if action has one
  let entryHash: EntryHash | null = null;
  if (isNewEntryAction(action)) {
    entryHash = action.entry_hash;
  }

  switch (opType) {
    case ChainOpType.StoreRecord:
      return {
        type: ChainOpType.StoreRecord,
        actionHash,
        entryHash,
        basis,
      };

    case ChainOpType.StoreEntry:
      if (!entryHash) {
        return null;
      }
      return {
        type: ChainOpType.StoreEntry,
        actionHash,
        entryHash,
        basis,
      };

    case ChainOpType.RegisterAgentActivity:
      return {
        type: ChainOpType.RegisterAgentActivity,
        actionHash,
        basis,
      };

    case ChainOpType.RegisterUpdatedContent:
      if (!entryHash || !isUpdateAction(action)) {
        return null;
      }
      return {
        type: ChainOpType.RegisterUpdatedContent,
        actionHash,
        entryHash,
        basis,
      };

    case ChainOpType.RegisterUpdatedRecord:
      if (!entryHash || !isUpdateAction(action)) {
        return null;
      }
      return {
        type: ChainOpType.RegisterUpdatedRecord,
        actionHash,
        entryHash,
        basis,
      };

    case ChainOpType.RegisterDeletedBy:
      return {
        type: ChainOpType.RegisterDeletedBy,
        actionHash,
        basis,
      };

    case ChainOpType.RegisterDeletedEntryAction:
      return {
        type: ChainOpType.RegisterDeletedEntryAction,
        actionHash,
        basis,
      };

    case ChainOpType.RegisterAddLink:
      return {
        type: ChainOpType.RegisterAddLink,
        actionHash,
        basis,
      };

    case ChainOpType.RegisterRemoveLink:
      return {
        type: ChainOpType.RegisterRemoveLink,
        actionHash,
        basis,
      };

    default:
      return null;
  }
}

/**
 * Get the basis for a ChainOp.
 *
 * This extracts the basis hash from a full ChainOp.
 */
export function getOpBasis(op: ChainOp): OpBasis {
  // Get the action and action hash from the op
  const action = getOpAction(op);

  // For computing the basis, we need the action hash
  // This is a bit inefficient since we're recomputing, but ensures correctness
  // In practice, callers should cache the action hash
  throw new Error(
    "getOpBasis requires action hash - use computeOpBasis directly with the action hash"
  );
}

/**
 * Get the action from a ChainOp.
 */
export function getOpAction(op: ChainOp): Action {
  switch (op.type) {
    case ChainOpType.StoreRecord:
    case ChainOpType.RegisterAgentActivity:
      return op.action;

    case ChainOpType.StoreEntry:
      // NewEntryAction is Create | Update, both are Actions
      return op.action as unknown as Action;

    case ChainOpType.RegisterUpdatedContent:
    case ChainOpType.RegisterUpdatedRecord:
      return op.action as unknown as Action;

    case ChainOpType.RegisterDeletedBy:
    case ChainOpType.RegisterDeletedEntryAction:
      return op.action as unknown as Action;

    case ChainOpType.RegisterAddLink:
      return op.action as unknown as Action;

    case ChainOpType.RegisterRemoveLink:
      return op.action as unknown as Action;

    default:
      throw new Error(`Unknown op type`);
  }
}

/**
 * Get the signature from a ChainOp.
 */
export function getOpSignature(op: ChainOp): Signature {
  return op.signature;
}
