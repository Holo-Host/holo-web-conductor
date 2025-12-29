/**
 * TypeScript types matching Holochain's Rust types
 * Based on holochain_integrity_types and holochain_zome_types
 */

// ============================================================================
// EntryType (from holochain_integrity_types/src/action.rs)
// ============================================================================

export interface AppEntryDef {
  entry_index: number;  // u8
  zome_index: number;   // u8
  visibility: EntryVisibility;
}

export type EntryVisibility = "Public" | "Private";

export type EntryType =
  | "AgentPubKey"              // Unit variant
  | "CapClaim"                 // Unit variant
  | "CapGrant"                 // Unit variant
  | { App: AppEntryDef };      // Newtype variant

// ============================================================================
// Entry (from holochain_integrity_types/src/entry.rs)
//
// Source: holochain/crates/holochain_integrity_types/src/entry.rs
// Rust definition:
//   #[serde(tag = "entry_type", content = "entry")]
//   pub enum Entry {
//       Agent(AgentPubKey),
//       App(AppEntryBytes),
//       CounterSign(Box<CounterSigningSessionData>, AppEntryBytes),
//       CapClaim(CapClaimEntry),
//       CapGrant(CapGrantEntry),
//   }
//
// This uses serde's internally tagged enum format, which serializes as:
//   { "entry_type": "Agent", "entry": <AgentPubKey> }
//   { "entry_type": "App", "entry": <AppEntryBytes> }
// ============================================================================

export type Entry =
  | { entry_type: "Agent"; entry: Uint8Array }              // Agent(AgentPubKey)
  | { entry_type: "App"; entry: Uint8Array }                // App(AppEntryBytes)
  | { entry_type: "CapClaim"; entry: any }                  // CapClaim(CapClaimEntry)
  | { entry_type: "CapGrant"; entry: any };                 // CapGrant(CapGrantEntry)

// ============================================================================
// RecordEntry (from holochain_integrity_types/src/record.rs)
// ============================================================================

export type RecordEntry =
  | { Present: Entry }
  | "Hidden"
  | "NA"
  | "NotStored";

// ============================================================================
// Action types (from holochain_integrity_types/src/action.rs)
// ============================================================================

/**
 * Weight for rate limiting
 */
export interface RateWeight {
  bucket_id: number;
  units: number;
  rate_bytes: number;
}

/**
 * Common fields for all actions
 */
export interface ActionCommon {
  type: string;
  author: Uint8Array;          // AgentPubKey (39 bytes)
  timestamp: number;           // Timestamp (microseconds as i64)
  action_seq: number;          // u32
  // NOTE: When serializing to MessagePack, this field should be OMITTED (not included)
  // when the value is null/undefined. Rust's Option<T> serializes as omitted field, not null.
  prev_action?: Uint8Array;    // Option<ActionHash> (39 bytes) - omit when None
}

/**
 * Dna action (first action in chain)
 *
 * Source: holochain/crates/holochain_integrity_types/src/action.rs
 * Note: Dna action does NOT have action_seq or prev_action fields
 * (action_seq is implicitly 0, prev_action is implicitly None)
 */
export interface DnaAction {
  type: "Dna";
  author: Uint8Array;          // AgentPubKey (39 bytes)
  timestamp: number;           // Timestamp (microseconds as i64)
  hash: Uint8Array;            // DnaHash (39 bytes)
}

/**
 * AgentValidationPkg action
 */
export interface AgentValidationPkgAction extends ActionCommon {
  type: "AgentValidationPkg";
  membrane_proof?: Uint8Array;  // Option<MembraneProof>
}

/**
 * InitZomesComplete action
 */
export interface InitZomesCompleteAction extends ActionCommon {
  type: "InitZomesComplete";
}

/**
 * Create action
 */
export interface CreateAction extends ActionCommon {
  type: "Create";
  entry_type: EntryType;
  entry_hash: Uint8Array;      // EntryHash (39 bytes)
  weight: RateWeight;
}

/**
 * Update action
 */
export interface UpdateAction extends ActionCommon {
  type: "Update";
  entry_type: EntryType;
  entry_hash: Uint8Array;
  weight: RateWeight;
  original_action_address: Uint8Array;  // ActionHash
  original_entry_address: Uint8Array;   // EntryHash
}

/**
 * Delete action
 */
export interface DeleteAction extends ActionCommon {
  type: "Delete";
  deletes_address: Uint8Array;        // ActionHash
  deletes_entry_address: Uint8Array;  // EntryHash
}

/**
 * CreateLink action
 */
export interface CreateLinkAction extends ActionCommon {
  type: "CreateLink";
  base_address: Uint8Array;    // AnyLinkableHash (39 bytes)
  target_address: Uint8Array;  // AnyLinkableHash (39 bytes)
  zome_index: number;          // ZomeIndex (u8)
  link_type: number;           // LinkType (u8)
  tag: Uint8Array;             // LinkTag (bytes)
  weight: RateWeight;
}

/**
 * DeleteLink action
 */
export interface DeleteLinkAction extends ActionCommon {
  type: "DeleteLink";
  link_add_address: Uint8Array;  // ActionHash
  base_address: Uint8Array;      // AnyLinkableHash
}

/**
 * Union type for all actions
 */
export type Action =
  | DnaAction
  | AgentValidationPkgAction
  | InitZomesCompleteAction
  | CreateAction
  | UpdateAction
  | DeleteAction
  | CreateLinkAction
  | DeleteLinkAction;

// ============================================================================
// Record structures (from holochain_integrity_types/src/record.rs)
// ============================================================================

/**
 * ActionHashed
 */
export interface ActionHashed {
  content: Action;
  hash: Uint8Array;  // ActionHash (39 bytes)
}

/**
 * SignedActionHashed
 */
export interface SignedActionHashed {
  hashed: ActionHashed;
  signature: Uint8Array;  // Signature (64 bytes)
}

/**
 * Record (the main structure returned by query, get, etc.)
 */
export interface Record {
  signed_action: SignedActionHashed;
  entry: RecordEntry;
}
