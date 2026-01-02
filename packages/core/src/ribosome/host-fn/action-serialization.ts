/**
 * Action Serialization Utilities
 *
 * Converts internal action representation to Holochain-compatible format
 * with internally tagged enums and snake_case field names.
 */

import { ActionType, type Action as HolochainAction } from '@holochain/client';
import type { Action as StorageAction } from '../../storage/types';

// We use HolochainAction as the return type to satisfy external consumers,
// but our implementation uses ActionType enum values with optional prev_action.
// The actual serialization format matches what Holochain expects at runtime.

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
export function toHolochainAction(act: StorageAction): HolochainAction {
  // Implementation builds objects matching Holochain's wire format.
  // TypeScript type assertions used because @holochain/client types don't perfectly
  // match serialization format (e.g., prev_action is optional in wire format but required in types).
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
  // Cast to unknown first then to HolochainAction because the @holochain/client
  // types don't exactly match our wire format (optional prev_action, etc.)
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
        type: ActionType.Dna,
        author: authorPrefixed,
        timestamp: Number(act.timestamp),
        hash: dnaHashPrefixed,
      } as unknown as HolochainAction;
    }

    case 'AgentValidationPkg':
      return {
        type: ActionType.AgentValidationPkg,
        ...common,
        ...(act.membraneProof && { membrane_proof: act.membraneProof }),
      } as unknown as HolochainAction;

    case 'InitZomesComplete':
      return {
        type: ActionType.InitZomesComplete,
        ...common,
      } as unknown as HolochainAction;

    case 'Create':
      return {
        type: ActionType.Create,
        ...common,
        entry_type: act.entryType
          ? { App: { entry_index: act.entryType.entry_index, zome_index: act.entryType.zome_id, visibility: "Public" as const } }
          : "AgentPubKey" as const,
        entry_hash: act.entryHash,
        weight: { bucket_id: 0, units: 0, rate_bytes: 0 },
      } as unknown as HolochainAction;

    case 'Update':
      return {
        type: ActionType.Update,
        ...common,
        entry_type: act.entryType
          ? { App: { entry_index: act.entryType.entry_index, zome_index: act.entryType.zome_id, visibility: "Public" as const } }
          : "AgentPubKey" as const,
        entry_hash: act.entryHash,
        weight: { bucket_id: 0, units: 0, rate_bytes: 0 },
        original_action_address: act.originalActionHash,
        original_entry_address: act.originalEntryHash,
      } as unknown as HolochainAction;

    case 'Delete':
      return {
        type: ActionType.Delete,
        ...common,
        deletes_address: act.deletesActionHash,
        deletes_entry_address: act.deletesEntryHash,
        weight: { bucket_id: 0, units: 0, rate_bytes: 0 },
      } as unknown as HolochainAction;

    case 'CreateLink':
      return {
        type: ActionType.CreateLink,
        ...common,
        base_address: act.baseAddress,
        target_address: act.targetAddress,
        zome_index: act.zomeIndex,
        link_type: act.linkType,
        tag: act.tag,
        weight: { bucket_id: 0, units: 0, rate_bytes: 0 },
      } as unknown as HolochainAction;

    case 'DeleteLink':
      return {
        type: ActionType.DeleteLink,
        ...common,
        link_add_address: act.linkAddAddress,
        base_address: act.baseAddress,
      } as unknown as HolochainAction;

    default:
      throw new Error(`Unknown action type: ${(act as any).actionType}`);
  }
}
