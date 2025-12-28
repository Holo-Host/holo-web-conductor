/**
 * Source Chain Storage Types
 * Based on Holochain's action model (holochain/crates/holochain_types/src/action/)
 */

import type { ActionHash, EntryHash, AgentPubKey, Timestamp } from '@holochain/client';

// ============================================================================
// Action Types (Chain Actions)
// ============================================================================

export type ActionType =
  | 'Dna'
  | 'AgentValidationPkg'
  | 'InitZomesComplete'
  | 'Create'
  | 'Update'
  | 'Delete'
  | 'CreateLink'
  | 'DeleteLink';

/**
 * Base action structure common to all action types
 */
export interface ActionBase {
  actionHash: Uint8Array;           // 39-byte hash
  actionSeq: number;                // Sequence number in chain
  author: Uint8Array;               // AgentPubKey
  timestamp: bigint;                // Microseconds since epoch
  prevActionHash: Uint8Array | null; // Previous action in chain (null for genesis)
  actionType: ActionType;
  signature: Uint8Array;            // Ed25519 signature (64 bytes)
}

/**
 * Entry-creating actions (Create, Update)
 */
export interface EntryAction extends ActionBase {
  actionType: 'Create' | 'Update';
  entryHash: Uint8Array;            // 39-byte entry hash
  entryType: AppEntryType | null;   // null for agent entry
}

export interface CreateAction extends EntryAction {
  actionType: 'Create';
}

export interface UpdateAction extends EntryAction {
  actionType: 'Update';
  originalActionHash: Uint8Array;   // Action being updated
  originalEntryHash: Uint8Array;    // Entry being updated
}

/**
 * Delete action
 */
export interface DeleteAction extends ActionBase {
  actionType: 'Delete';
  deletesActionHash: Uint8Array;    // Action being deleted
  deletesEntryHash: Uint8Array;     // Entry being deleted
}

/**
 * Link actions
 */
export interface CreateLinkAction extends ActionBase {
  actionType: 'CreateLink';
  baseAddress: Uint8Array;          // Base DHT address (39 bytes)
  targetAddress: Uint8Array;        // Target DHT address (39 bytes)
  zomeIndex: number;                // Zome ID
  linkType: number;                 // Link type ID
  tag: Uint8Array;                  // Link tag
}

export interface DeleteLinkAction extends ActionBase {
  actionType: 'DeleteLink';
  linkAddAddress: Uint8Array;       // CreateLink action hash being deleted
  baseAddress: Uint8Array;          // Base address (for indexing)
}

/**
 * Genesis actions (DNA instantiation)
 */
export interface DnaAction extends ActionBase {
  actionType: 'Dna';
  dnaHash: Uint8Array;
}

export interface AgentValidationPkgAction extends ActionBase {
  actionType: 'AgentValidationPkg';
  membraneProof?: Uint8Array;
}

export interface InitZomesCompleteAction extends ActionBase {
  actionType: 'InitZomesComplete';
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
// Entry Types
// ============================================================================

export interface AppEntryType {
  zome_id: number;      // Zome index
  entry_index: number;  // Entry def index within zome
}

/**
 * Stored entry with content
 */
export interface StoredEntry {
  entryHash: Uint8Array;
  entryContent: Uint8Array;         // MessagePack-serialized entry data
  entryType: AppEntryType | 'Agent' | 'CapClaim' | 'CapGrant';
}

// ============================================================================
// Record (Action + Entry)
// ============================================================================

/**
 * Record combines an action with its optional entry
 * Matches Holochain's Record structure
 */
export interface StoredRecord {
  actionHash: Uint8Array;
  action: Action;
  entry?: StoredEntry;
}

// ============================================================================
// Chain Head Tracking
// ============================================================================

export interface ChainHead {
  cellId: string;                   // Base64-encoded: `${dnaHash}:${agentPubKey}`
  actionSeq: number;                // Current sequence number
  actionHash: Uint8Array;           // Latest action hash
  timestamp: bigint;                // Last update time
}

// ============================================================================
// Link Storage
// ============================================================================

/**
 * Link record for get_links queries
 */
export interface Link {
  createLinkHash: Uint8Array;       // CreateLink action hash
  baseAddress: Uint8Array;
  targetAddress: Uint8Array;
  timestamp: bigint;
  zomeIndex: number;
  linkType: number;
  tag: Uint8Array;
  author: Uint8Array;
  deleted: boolean;                 // Set to true if DeleteLink exists
  deleteHash?: Uint8Array;          // DeleteLink action hash if deleted
}

// ============================================================================
// Details (for get_details)
// ============================================================================

/**
 * Details structure returned by get_details host function
 * Includes all CRUD history for an entry
 */
export interface RecordDetails {
  record: StoredRecord;
  validationStatus: 'Valid' | 'Rejected' | 'Abandoned';
  deletes: Array<{
    deleteHash: Uint8Array;
    deleteAction: DeleteAction;
  }>;
  updates: Array<{
    updateHash: Uint8Array;
    updateAction: UpdateAction;
  }>;
}

// ============================================================================
// IndexedDB Storable Types
// ============================================================================

/**
 * Serializable version of Action for IndexedDB storage
 * Converts Uint8Array to number[] for IDB compatibility
 */
export interface StorableAction {
  actionHash: number[];
  actionSeq: number;
  author: number[];
  timestamp: string;                // bigint as string
  prevActionHash: number[] | null;
  actionType: ActionType;
  signature: number[];

  // Entry-related fields (if applicable)
  entryHash?: number[];
  entryType?: AppEntryType | null;

  // Update-specific
  originalActionHash?: number[];
  originalEntryHash?: number[];

  // Delete-specific
  deletesActionHash?: number[];
  deletesEntryHash?: number[];

  // Link-specific
  baseAddress?: number[];
  targetAddress?: number[];
  zomeIndex?: number;
  linkType?: number;
  tag?: number[];
  linkAddAddress?: number[];

  // Genesis-specific
  dnaHash?: number[];
  membraneProof?: number[];

  // Storage metadata
  cellId: string;
}

export interface StorableEntry {
  entryHash: number[];
  entryContent: number[];
  entryType: AppEntryType | 'Agent' | 'CapClaim' | 'CapGrant';
  cellId: string;
}

export interface StorableLink {
  createLinkHash: number[];
  baseAddress: number[];
  targetAddress: number[];
  timestamp: string;
  zomeIndex: number;
  linkType: number;
  tag: number[];
  author: number[];
  deleted: boolean;
  deleteHash?: number[];
  cellId: string;
}

export interface StorableChainHead {
  cellId: string;
  actionSeq: number;
  actionHash: number[];
  timestamp: string;
}
