/**
 * Action Serialization Utilities
 *
 * Converts internal action representation to Holochain-compatible format
 * with internally tagged enums and snake_case field names.
 */

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
export function toHolochainAction(act: any): any {
  // Convert 32-byte agentPubKey to 39-byte prefixed version
  const authorPrefixed = new Uint8Array(39);
  if (act.author.length === 32) {
    authorPrefixed.set([0x84, 0x20, 0x24], 0); // AGENT_PREFIX
    authorPrefixed.set(act.author, 3);
    authorPrefixed.set([0, 0, 0, 0], 35);
  } else {
    authorPrefixed.set(act.author);
  }

  const base: any = {
    type: act.actionType,
    author: authorPrefixed,
    timestamp: Number(act.timestamp),
    action_seq: act.actionSeq,
    // Only include prev_action if not null (Holochain expects field omitted for None)
    ...(act.prevActionHash ? { prev_action: act.prevActionHash } : {}),
  };

  // Add type-specific fields
  if (act.actionType === 'Create' || act.actionType === 'Update') {
    base.entry_type = act.entryType
      ? { App: { entry_index: act.entryType.entry_index, zome_index: act.entryType.zome_id, visibility: "Public" } }
      : { Agent: null };
    base.entry_hash = act.entryHash;
    base.weight = { bucket_id: 0, units: 0, rate_bytes: 0 };
  }

  if (act.actionType === 'Update') {
    base.original_action_address = act.originalActionHash;
    base.original_entry_address = act.originalEntryHash;
  }

  if (act.actionType === 'Delete') {
    base.deletes_address = act.deletesActionHash;
    base.deletes_entry_address = act.deletesEntryHash;
  }

  if (act.actionType === 'CreateLink') {
    base.base_address = act.baseAddress;
    base.target_address = act.targetAddress;
    base.zome_index = act.zomeIndex;
    base.link_type = act.linkType;
    base.tag = act.tag;
  }

  if (act.actionType === 'DeleteLink') {
    base.link_add_address = act.linkAddAddress;
    base.base_address = act.baseAddress;
  }

  return base;
}
