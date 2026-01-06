/**
 * Record Converter
 *
 * Converts between storage format (StoredAction, StoredEntry) and
 * @holochain/client format (Record, SignedActionHashed) for publishing.
 */

import type {
  Action,
  ActionHash,
  Create,
  Update,
  Delete,
  CreateLink,
  DeleteLink,
  Entry,
  Record,
  SignedActionHashed,
  ActionHashed,
  Signature,
  RecordEntry,
} from "@holochain/client";

import type {
  StoredAction,
  StoredEntry,
  CreateAction,
  UpdateAction,
  DeleteAction,
  CreateLinkAction,
  DeleteLinkAction,
} from "../storage/types";

/**
 * Convert a stored action to @holochain/client Action format
 *
 * This handles the transformation from storage format (actionType: "Create")
 * to wire format (type: "Create" with proper structure).
 */
export function storedActionToClientAction(stored: StoredAction): Action {
  const baseFields = {
    author: stored.author,
    timestamp: stored.timestamp,
    action_seq: stored.actionSeq,
    prev_action: stored.prevActionHash,
  };

  switch (stored.actionType) {
    case "Create": {
      const createStored = stored as CreateAction;
      const create: Create = {
        type: "Create",
        ...baseFields,
        entry_type: createStored.entryType
          ? {
              App: {
                entry_index: createStored.entryType.entry_index,
                zome_index: createStored.entryType.zome_id,
                visibility: "Public",
              },
            }
          : { Agent: null },
        entry_hash: createStored.entryHash,
        weight: { bucket_id: 0, units: 0, rate_bytes: 0 },
      };
      return create;
    }

    case "Update": {
      const updateStored = stored as UpdateAction;
      const update: Update = {
        type: "Update",
        ...baseFields,
        entry_type: updateStored.entryType
          ? {
              App: {
                entry_index: updateStored.entryType.entry_index,
                zome_index: updateStored.entryType.zome_id,
                visibility: "Public",
              },
            }
          : { Agent: null },
        entry_hash: updateStored.entryHash,
        original_action_address: updateStored.originalActionHash,
        original_entry_address: updateStored.originalEntryHash,
        weight: { bucket_id: 0, units: 0, rate_bytes: 0 },
      };
      return update;
    }

    case "Delete": {
      const deleteStored = stored as DeleteAction;
      const del: Delete = {
        type: "Delete",
        ...baseFields,
        deletes_address: deleteStored.deletesActionHash,
        deletes_entry_address: deleteStored.deletesEntryHash,
        weight: { bucket_id: 0, units: 0, rate_bytes: 0 },
      };
      return del;
    }

    case "CreateLink": {
      const linkStored = stored as CreateLinkAction;
      const createLink: CreateLink = {
        type: "CreateLink",
        ...baseFields,
        base_address: linkStored.baseAddress,
        target_address: linkStored.targetAddress,
        zome_index: linkStored.zomeIndex,
        link_type: linkStored.linkType,
        tag: linkStored.tag,
        weight: { bucket_id: 0, units: 0, rate_bytes: 0 },
      };
      return createLink;
    }

    case "DeleteLink": {
      const deleteLinkStored = stored as DeleteLinkAction;
      const deleteLink: DeleteLink = {
        type: "DeleteLink",
        ...baseFields,
        base_address: deleteLinkStored.baseAddress,
        link_add_address: deleteLinkStored.linkAddAddress,
      };
      return deleteLink;
    }

    default:
      throw new Error(`Unsupported action type for conversion: ${stored.actionType}`);
  }
}

/**
 * Convert a stored entry to @holochain/client Entry format
 *
 * Entries are stored as raw msgpack bytes; convert to Entry union type.
 */
export function storedEntryToClientEntry(stored: StoredEntry): Entry {
  // StoredEntry has entryType that tells us what kind of entry
  if (stored.entryType === "Agent") {
    // Agent entry - the content is the agent pub key
    return { Agent: stored.entryContent };
  }

  // App entries are wrapped in { App: bytes }
  return { App: stored.entryContent };
}

/**
 * Convert a stored entry to RecordEntry format for DhtOps
 */
export function storedEntryToRecordEntry(stored: StoredEntry | undefined): RecordEntry {
  if (!stored) {
    return { NA: null };
  }

  const entry = storedEntryToClientEntry(stored);
  return { Present: entry };
}

/**
 * Build a @holochain/client Record from stored action and entry
 *
 * This is the format required by produceOpsFromRecord.
 */
export function buildRecord(
  storedAction: StoredAction,
  storedEntry: StoredEntry | undefined
): Record {
  const action = storedActionToClientAction(storedAction);

  const actionHashed: ActionHashed = {
    hash: storedAction.actionHash as ActionHash,
    content: action,
  };

  const signedActionHashed: SignedActionHashed = {
    hashed: actionHashed,
    signature: storedAction.signature as Signature,
  };

  const recordEntry = storedEntryToRecordEntry(storedEntry);

  return {
    signed_action: signedActionHashed,
    entry: recordEntry,
  };
}

/**
 * Build records for a batch of stored actions
 *
 * @param actions - Array of stored actions with their entries
 * @returns Array of Records ready for publishing
 */
export function buildRecords(
  actions: Array<{ action: StoredAction; entry?: StoredEntry }>
): Record[] {
  return actions.map(({ action, entry }) => buildRecord(action, entry));
}
