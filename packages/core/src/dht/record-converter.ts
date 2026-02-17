/**
 * Record Converter
 *
 * Converts between storage format (StoredAction, StoredEntry) and
 * @holochain/client format (Record, SignedActionHashed) for publishing.
 */

import {
  ActionType,
  HoloHashType,
  hashFrom32AndType,
  type Action,
  type ActionHash,
  type AgentPubKey,
  type Create,
  type Update,
  type Delete,
  type CreateLink,
  type DeleteLink,
  type Dna,
  type AgentValidationPkg,
  type InitZomesComplete,
  type Entry,
  type Record,
  type SignedActionHashed,
  type ActionHashed,
  type Signature,
  type RecordEntry,
} from "@holochain/client";

import type {
  StoredAction,
  StoredEntry,
  CreateAction,
  UpdateAction,
  DeleteAction,
  CreateLinkAction,
  DeleteLinkAction,
  DnaAction,
  AgentValidationPkgAction,
  InitZomesCompleteAction,
} from "../storage/types";

/**
 * Ensure a hash is 39 bytes (3 prefix + 32 core + 4 location).
 * Storage may hold 32-byte raw keys; HoloHash deserialization requires 39.
 */
function ensureAgentPubKey(raw: Uint8Array): AgentPubKey {
  if (raw.length === 39) return raw as AgentPubKey;
  return hashFrom32AndType(raw.slice(0, 32), HoloHashType.Agent) as AgentPubKey;
}

/**
 * Convert a stored action to @holochain/client Action format
 *
 * This handles the transformation from storage format (actionType: "Create")
 * to wire format (type: "Create" with proper structure).
 */
export function storedActionToClientAction(stored: StoredAction): Action {
  // @holochain/client expects timestamp as number, our storage uses bigint
  const timestamp = typeof stored.timestamp === 'bigint'
    ? Number(stored.timestamp)
    : stored.timestamp;

  // Ensure author is 39-byte AgentPubKey (storage may have 32-byte raw keys)
  const author = ensureAgentPubKey(stored.author);

  // prev_action is non-null for all action types we handle here
  // (Dna action doesn't have prev_action and isn't handled by this function)
  const baseFields = {
    author,
    timestamp,
    action_seq: stored.actionSeq,
    prev_action: stored.prevActionHash!,  // Assert non-null for these action types
  };

  switch (stored.actionType) {
    case "Create": {
      const createStored = stored as CreateAction;
      // Use type assertion because @holochain/client types don't include "AgentPubKey" as valid EntryType
      const create = {
        type: ActionType.Create,
        ...baseFields,
        entry_type: createStored.entryType
          ? {
              App: {
                entry_index: createStored.entryType.entry_index,
                zome_index: createStored.entryType.zome_id,
                visibility: "Public" as const,
              },
            }
          : ("AgentPubKey" as const),
        entry_hash: createStored.entryHash,
        // Create uses EntryRateWeight (3 fields: bucket_id, units, rate_bytes)
        weight: { bucket_id: 0, units: 0, rate_bytes: 0 },
      } as unknown as Create;
      return create;
    }

    case "Update": {
      const updateStored = stored as UpdateAction;
      // Use type assertion because @holochain/client types don't include "AgentPubKey" as valid EntryType
      const update = {
        type: ActionType.Update,
        ...baseFields,
        entry_type: updateStored.entryType
          ? {
              App: {
                entry_index: updateStored.entryType.entry_index,
                zome_index: updateStored.entryType.zome_id,
                visibility: "Public" as const,
              },
            }
          : ("AgentPubKey" as const),
        entry_hash: updateStored.entryHash,
        original_action_address: updateStored.originalActionHash,
        original_entry_address: updateStored.originalEntryHash,
        // Update uses EntryRateWeight (3 fields: bucket_id, units, rate_bytes)
        weight: { bucket_id: 0, units: 0, rate_bytes: 0 },
      } as unknown as Update;
      return update;
    }

    case "Delete": {
      const deleteStored = stored as DeleteAction;
      // Use type assertion because @holochain/client Delete type doesn't include weight
      // but Holochain wire format requires it
      const del = {
        type: ActionType.Delete,
        ...baseFields,
        deletes_address: deleteStored.deletesActionHash,
        deletes_entry_address: deleteStored.deletesEntryHash,
        // Delete uses RateWeight (2 fields: bucket_id, units)
        weight: { bucket_id: 0, units: 0 },
      } as unknown as Delete;
      return del;
    }

    case "CreateLink": {
      const linkStored = stored as CreateLinkAction;
      const createLink: CreateLink = {
        type: ActionType.CreateLink,
        ...baseFields,
        base_address: linkStored.baseAddress,
        target_address: linkStored.targetAddress,
        zome_index: linkStored.zomeIndex,
        link_type: linkStored.linkType,
        tag: linkStored.tag,
        weight: { bucket_id: 0, units: 0 },
      };
      return createLink;
    }

    case "DeleteLink": {
      const deleteLinkStored = stored as DeleteLinkAction;
      const deleteLink: DeleteLink = {
        type: ActionType.DeleteLink,
        ...baseFields,
        base_address: deleteLinkStored.baseAddress,
        link_add_address: deleteLinkStored.linkAddAddress,
      };
      return deleteLink;
    }

    // Genesis action types
    case "Dna": {
      const dnaStored = stored as DnaAction;
      // Dna action doesn't have action_seq or prev_action
      const dna: Dna = {
        type: ActionType.Dna,
        author: ensureAgentPubKey(dnaStored.author),
        timestamp,
        hash: dnaStored.dnaHash,
      };
      return dna;
    }

    case "AgentValidationPkg": {
      const avpStored = stored as AgentValidationPkgAction;
      const avp: AgentValidationPkg = {
        type: ActionType.AgentValidationPkg,
        author,
        timestamp,
        action_seq: avpStored.actionSeq,
        prev_action: avpStored.prevActionHash!,
        membrane_proof: avpStored.membraneProof ?? null,
      };
      return avp;
    }

    case "InitZomesComplete": {
      const izcStored = stored as InitZomesCompleteAction;
      const izc: InitZomesComplete = {
        type: ActionType.InitZomesComplete,
        author,
        timestamp,
        action_seq: izcStored.actionSeq,
        prev_action: izcStored.prevActionHash!,
      };
      return izc;
    }

    default: {
      // TypeScript exhaustiveness check - should never reach here
      const _exhaustiveCheck: never = stored;
      throw new Error(`Unsupported action type for conversion: ${(_exhaustiveCheck as StoredAction).actionType}`);
    }
  }
}

/**
 * Convert a stored entry to @holochain/client Entry format
 *
 * Entries are stored as raw msgpack bytes; convert to Entry union type.
 *
 * Rust Entry enum uses internal tagging (#[serde(tag = "entry_type", content = "entry")]):
 * - Agent(AgentPubKey) -> { "entry_type": "Agent", "entry": <agent_pubkey> }
 * - App(AppEntryBytes) -> { "entry_type": "App", "entry": <bytes> }
 */
export function storedEntryToClientEntry(stored: StoredEntry): Entry {
  // StoredEntry has entryType that tells us what kind of entry
  if (stored.entryType === "Agent") {
    // Agent entry - internally tagged format
    return { entry_type: "Agent", entry: stored.entryContent } as Entry;
  }

  // App entries - internally tagged format
  return { entry_type: "App", entry: stored.entryContent } as Entry;
}

/**
 * Convert a stored entry to RecordEntry format for DhtOps
 */
export function storedEntryToRecordEntry(stored: StoredEntry | undefined): RecordEntry {
  if (!stored) {
    // Rust RecordEntry::NA - unit variant serializes as string "NA" in msgpack
    return "NA" as unknown as RecordEntry;
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

/**
 * Build SignedActionHashed array from stored actions
 *
 * This is used for post_commit callback which receives Vec<SignedActionHashed>
 *
 * @param actions - Array of stored actions
 * @returns Array of SignedActionHashed
 */
export function buildSignedActionHashedArray(
  actions: Array<{ action: StoredAction; entry?: StoredEntry }>
): SignedActionHashed[] {
  return actions.map(({ action }) => {
    const clientAction = storedActionToClientAction(action);
    return {
      hashed: {
        hash: action.actionHash as ActionHash,
        content: clientAction,
      },
      signature: action.signature as Signature,
    };
  });
}
