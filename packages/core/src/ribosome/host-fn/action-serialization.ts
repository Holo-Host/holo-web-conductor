/**
 * Action Serialization Utilities
 *
 * Converts internal action representation to Holochain-compatible format
 * with internally tagged enums and snake_case field names.
 */

import type { Action } from '../holochain-types';
import type { Action as StorageAction } from '../../storage/types';

/**
 * Convert action to Holochain format with internally tagged enum
 *
 * Holochain uses #[serde(tag = "type")] which produces:
 * { "type": "Create", author, timestamp, ... } with fields flattened
 *
 * Also converts:
 * - BigInt timestamps to Number for MessagePack
 * - 32-byte author to 39-byte prefixed AgentPubKey
 * - Omits null fields like prev_action (Holochain expects Option<T> to be omitted when None)
 */
export function toHolochainAction(act: StorageAction): Action {
  // Convert 32-byte agentPubKey to 39-byte prefixed version
  const authorPrefixed = new Uint8Array(39);
  if (act.author.length === 32) {
    authorPrefixed.set([0x84, 0x20, 0x24], 0); // AGENT_PREFIX
    authorPrefixed.set(act.author, 3);
    authorPrefixed.set([0, 0, 0, 0], 35);
  } else {
    authorPrefixed.set(act.author);
  }

  // Build common fields (NOTE: prev_action is optional, omit if null)
  const common = {
    author: authorPrefixed,
    timestamp: Number(act.timestamp),
    action_seq: act.actionSeq,
    ...(act.prevActionHash && { prev_action: act.prevActionHash }),
  };

  // Build type-specific action based on actionType
  switch (act.actionType) {
    case 'Dna': {
      // Convert 32-byte raw DNA hash to 39-byte prefixed DnaHash
      const dnaHashPrefixed = new Uint8Array(39);
      dnaHashPrefixed.set([0x84, 0x2D, 0x24], 0); // DNA_PREFIX
      dnaHashPrefixed.set(act.dnaHash, 3);
      dnaHashPrefixed.set([0, 0, 0, 0], 35); // location (all zeros)

      // Note: Dna action does NOT have action_seq or prev_action fields
      // (they are implicitly 0 and None respectively)
      return {
        type: 'Dna',
        author: authorPrefixed,
        timestamp: Number(act.timestamp),
        hash: dnaHashPrefixed,
      };
    }

    case 'AgentValidationPkg':
      return {
        type: 'AgentValidationPkg',
        ...common,
        ...(act.membraneProof && { membrane_proof: act.membraneProof }),
      };

    case 'InitZomesComplete':
      return {
        type: 'InitZomesComplete',
        ...common,
      };

    case 'Create':
      return {
        type: 'Create',
        ...common,
        entry_type: act.entryType
          ? { App: { entry_index: act.entryType.entry_index, zome_index: act.entryType.zome_id, visibility: "Public" as const } }
          : "AgentPubKey" as const,
        entry_hash: act.entryHash,
        weight: { bucket_id: 0, units: 0, rate_bytes: 0 },
      };

    case 'Update':
      return {
        type: 'Update',
        ...common,
        entry_type: act.entryType
          ? { App: { entry_index: act.entryType.entry_index, zome_index: act.entryType.zome_id, visibility: "Public" as const } }
          : "AgentPubKey" as const,
        entry_hash: act.entryHash,
        weight: { bucket_id: 0, units: 0, rate_bytes: 0 },
        original_action_address: act.originalActionHash,
        original_entry_address: act.originalEntryHash,
      };

    case 'Delete':
      return {
        type: 'Delete',
        ...common,
        deletes_address: act.deletesActionHash,
        deletes_entry_address: act.deletesEntryHash,
        weight: { bucket_id: 0, units: 0, rate_bytes: 0 },
      };

    case 'CreateLink':
      return {
        type: 'CreateLink',
        ...common,
        base_address: act.baseAddress,
        target_address: act.targetAddress,
        zome_index: act.zomeIndex,
        link_type: act.linkType,
        tag: act.tag,
        weight: { bucket_id: 0, units: 0, rate_bytes: 0 },
      };

    case 'DeleteLink':
      return {
        type: 'DeleteLink',
        ...common,
        link_add_address: act.linkAddAddress,
        base_address: act.baseAddress,
      };

    default:
      throw new Error(`Unknown action type: ${(act as any).actionType}`);
  }
}
