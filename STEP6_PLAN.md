# Plan: Step 6 & 6.5 - Local Chain Data Storage & Host Function Integration

## Overview

**Goal**: Implement persistent source chain storage for entries and links, then wire up host functions to use this storage so test-wasm.html returns real data instead of mocks.

**Current State**:
- All CRUD operations (create, get, update, delete, query) return mock data
- All link operations (create_link, get_links, delete_link, count_links) return empty/mock data
- get_details returns `[null]` stub
- agent_info returns genesis chain head (seq: 0, no real chain tracking)
- No persistent chain storage - only HappContextStorage exists (stores contexts + WASM)

**Target State**:
- Full source chain storage in IndexedDB with per-cell isolation
- Entry operations persist and retrieve real chain data
- Link operations persist and retrieve real link records
- get_details returns actual Details with validation status
- agent_info returns real chain head (current sequence + action hash)
- test-wasm.html demonstrates round-trip data persistence

## Split Into Two Steps

### Step 6: Storage Infrastructure
Build the data storage layer without touching host functions.
- IndexedDB schema for source chain, links, chain heads
- SourceChainStorage class with CRUD operations
- TypeScript types for chain entries, links, records
- Unit tests for storage layer

### Step 6.5: Host Function Integration
Wire existing host functions to use the new storage layer.
- Update entry operations (create, get, update, delete, query)
- Update link operations (create_link, get_links, delete_link, count_links)
- Update get_details to return real Details structures
- Update agent_info to return real chain head
- Integration tests and manual testing in test-wasm.html

---

# STEP 6: Storage Infrastructure

## Task 6.1: Define Data Types

**Create: `packages/core/src/storage/types.ts`**

Define TypeScript types for source chain data structures matching Holochain's Action/Entry model.

```typescript
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
```

**Files:**
- `packages/core/src/storage/types.ts` - Create (~350 lines)

---

## Task 6.2: Implement SourceChainStorage Class

**Create: `packages/core/src/storage/source-chain-storage.ts`**

Implement IndexedDB-backed storage for source chain entries, links, and chain heads.

```typescript
/**
 * Source Chain Storage
 *
 * Persistent storage for Holochain source chain data:
 * - Actions (Create, Update, Delete, CreateLink, DeleteLink, etc.)
 * - Entries (app entry content)
 * - Links (base → target relationships)
 * - Chain heads (per-cell sequence tracking)
 */

import type {
  Action,
  StoredEntry,
  StoredRecord,
  ChainHead,
  Link,
  RecordDetails,
  StorableAction,
  StorableEntry,
  StorableLink,
  StorableChainHead,
  CreateAction,
  UpdateAction,
  DeleteAction,
  CreateLinkAction,
  DeleteLinkAction,
} from './types';

const DB_NAME = 'fishy_source_chain';
const DB_VERSION = 1;

const STORES = {
  ACTIONS: 'actions',
  ENTRIES: 'entries',
  LINKS: 'links',
  CHAIN_HEADS: 'chainHeads',
} as const;

export class SourceChainStorage {
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;
  private static instance: SourceChainStorage | null = null;

  private constructor() {}

  /**
   * Singleton instance
   */
  static getInstance(): SourceChainStorage {
    if (!SourceChainStorage.instance) {
      SourceChainStorage.instance = new SourceChainStorage();
    }
    return SourceChainStorage.instance;
  }

  /**
   * Initialize IndexedDB database
   */
  async init(): Promise<void> {
    if (this.db) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        console.log('[SourceChainStorage] Initialized');
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Actions store (source chain actions)
        if (!db.objectStoreNames.contains(STORES.ACTIONS)) {
          const actionsStore = db.createObjectStore(STORES.ACTIONS, {
            keyPath: 'actionHash',
          });
          actionsStore.createIndex('cellId_actionSeq', ['cellId', 'actionSeq'], { unique: true });
          actionsStore.createIndex('cellId', 'cellId', { unique: false });
          actionsStore.createIndex('actionType', 'actionType', { unique: false });
          actionsStore.createIndex('entryHash', 'entryHash', { unique: false });
        }

        // Entries store (entry content)
        if (!db.objectStoreNames.contains(STORES.ENTRIES)) {
          const entriesStore = db.createObjectStore(STORES.ENTRIES, {
            keyPath: 'entryHash',
          });
          entriesStore.createIndex('cellId', 'cellId', { unique: false });
        }

        // Links store
        if (!db.objectStoreNames.contains(STORES.LINKS)) {
          const linksStore = db.createObjectStore(STORES.LINKS, {
            keyPath: 'createLinkHash',
          });
          linksStore.createIndex('cellId_baseAddress', ['cellId', 'baseAddress'], { unique: false });
          linksStore.createIndex('cellId_baseAddress_linkType', ['cellId', 'baseAddress', 'linkType'], { unique: false });
          linksStore.createIndex('targetAddress', 'targetAddress', { unique: false });
        }

        // Chain heads store (one per cell)
        if (!db.objectStoreNames.contains(STORES.CHAIN_HEADS)) {
          db.createObjectStore(STORES.CHAIN_HEADS, { keyPath: 'cellId' });
        }

        console.log('[SourceChainStorage] Database upgraded to version', DB_VERSION);
      };
    });

    return this.initPromise;
  }

  /**
   * Create cell ID string from DNA hash and agent pub key
   */
  private getCellId(dnaHash: Uint8Array, agentPubKey: Uint8Array): string {
    const dnaB64 = btoa(String.fromCharCode(...dnaHash));
    const agentB64 = btoa(String.fromCharCode(...agentPubKey));
    return `${dnaB64}:${agentB64}`;
  }

  /**
   * Convert Uint8Array fields to number[] for IDB storage
   */
  private actionToStorable(action: Action, cellId: string): StorableAction {
    const base: StorableAction = {
      actionHash: Array.from(action.actionHash),
      actionSeq: action.actionSeq,
      author: Array.from(action.author),
      timestamp: action.timestamp.toString(),
      prevActionHash: action.prevActionHash ? Array.from(action.prevActionHash) : null,
      actionType: action.actionType,
      signature: Array.from(action.signature),
      cellId,
    };

    // Add type-specific fields
    if (action.actionType === 'Create' || action.actionType === 'Update') {
      base.entryHash = Array.from(action.entryHash);
      base.entryType = action.entryType;
    }

    if (action.actionType === 'Update') {
      base.originalActionHash = Array.from(action.originalActionHash);
      base.originalEntryHash = Array.from(action.originalEntryHash);
    }

    if (action.actionType === 'Delete') {
      base.deletesActionHash = Array.from(action.deletesActionHash);
      base.deletesEntryHash = Array.from(action.deletesEntryHash);
    }

    if (action.actionType === 'CreateLink') {
      base.baseAddress = Array.from(action.baseAddress);
      base.targetAddress = Array.from(action.targetAddress);
      base.zomeIndex = action.zomeIndex;
      base.linkType = action.linkType;
      base.tag = Array.from(action.tag);
    }

    if (action.actionType === 'DeleteLink') {
      base.linkAddAddress = Array.from(action.linkAddAddress);
      base.baseAddress = Array.from(action.baseAddress);
    }

    if (action.actionType === 'Dna') {
      base.dnaHash = Array.from(action.dnaHash);
    }

    if (action.actionType === 'AgentValidationPkg' && action.membraneProof) {
      base.membraneProof = Array.from(action.membraneProof);
    }

    return base;
  }

  /**
   * Convert storable action back to Action type
   */
  private storableToAction(storable: StorableAction): Action {
    const base = {
      actionHash: new Uint8Array(storable.actionHash),
      actionSeq: storable.actionSeq,
      author: new Uint8Array(storable.author),
      timestamp: BigInt(storable.timestamp),
      prevActionHash: storable.prevActionHash ? new Uint8Array(storable.prevActionHash) : null,
      actionType: storable.actionType,
      signature: new Uint8Array(storable.signature),
    };

    // Reconstruct based on action type
    switch (storable.actionType) {
      case 'Create':
        return {
          ...base,
          actionType: 'Create',
          entryHash: new Uint8Array(storable.entryHash!),
          entryType: storable.entryType!,
        } as CreateAction;

      case 'Update':
        return {
          ...base,
          actionType: 'Update',
          entryHash: new Uint8Array(storable.entryHash!),
          entryType: storable.entryType!,
          originalActionHash: new Uint8Array(storable.originalActionHash!),
          originalEntryHash: new Uint8Array(storable.originalEntryHash!),
        } as UpdateAction;

      case 'Delete':
        return {
          ...base,
          actionType: 'Delete',
          deletesActionHash: new Uint8Array(storable.deletesActionHash!),
          deletesEntryHash: new Uint8Array(storable.deletesEntryHash!),
        } as DeleteAction;

      case 'CreateLink':
        return {
          ...base,
          actionType: 'CreateLink',
          baseAddress: new Uint8Array(storable.baseAddress!),
          targetAddress: new Uint8Array(storable.targetAddress!),
          zomeIndex: storable.zomeIndex!,
          linkType: storable.linkType!,
          tag: new Uint8Array(storable.tag!),
        } as CreateLinkAction;

      case 'DeleteLink':
        return {
          ...base,
          actionType: 'DeleteLink',
          linkAddAddress: new Uint8Array(storable.linkAddAddress!),
          baseAddress: new Uint8Array(storable.baseAddress!),
        } as DeleteLinkAction;

      default:
        return base as Action;
    }
  }

  // ============================================================================
  // Chain Head Operations
  // ============================================================================

  /**
   * Get current chain head for a cell
   */
  async getChainHead(dnaHash: Uint8Array, agentPubKey: Uint8Array): Promise<ChainHead | null> {
    await this.init();
    const cellId = this.getCellId(dnaHash, agentPubKey);

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORES.CHAIN_HEADS, 'readonly');
      const request = tx.objectStore(STORES.CHAIN_HEADS).get(cellId);

      request.onsuccess = () => {
        const storable = request.result as StorableChainHead | undefined;
        if (!storable) {
          resolve(null);
          return;
        }

        resolve({
          cellId: storable.cellId,
          actionSeq: storable.actionSeq,
          actionHash: new Uint8Array(storable.actionHash),
          timestamp: BigInt(storable.timestamp),
        });
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Update chain head after adding action
   */
  async updateChainHead(
    dnaHash: Uint8Array,
    agentPubKey: Uint8Array,
    actionSeq: number,
    actionHash: Uint8Array,
    timestamp: bigint
  ): Promise<void> {
    await this.init();
    const cellId = this.getCellId(dnaHash, agentPubKey);

    const storable: StorableChainHead = {
      cellId,
      actionSeq,
      actionHash: Array.from(actionHash),
      timestamp: timestamp.toString(),
    };

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORES.CHAIN_HEADS, 'readwrite');
      const request = tx.objectStore(STORES.CHAIN_HEADS).put(storable);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  // ============================================================================
  // Action Operations
  // ============================================================================

  /**
   * Add action to source chain
   */
  async putAction(action: Action, dnaHash: Uint8Array, agentPubKey: Uint8Array): Promise<void> {
    await this.init();
    const cellId = this.getCellId(dnaHash, agentPubKey);
    const storable = this.actionToStorable(action, cellId);

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORES.ACTIONS, 'readwrite');
      const request = tx.objectStore(STORES.ACTIONS).put(storable);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get action by hash
   */
  async getAction(actionHash: Uint8Array): Promise<Action | null> {
    await this.init();
    const key = Array.from(actionHash);

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORES.ACTIONS, 'readonly');
      const request = tx.objectStore(STORES.ACTIONS).get(key);

      request.onsuccess = () => {
        const storable = request.result as StorableAction | undefined;
        resolve(storable ? this.storableToAction(storable) : null);
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Query actions by cell ID
   */
  async queryActions(
    dnaHash: Uint8Array,
    agentPubKey: Uint8Array,
    filter?: { actionType?: string }
  ): Promise<Action[]> {
    await this.init();
    const cellId = this.getCellId(dnaHash, agentPubKey);

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORES.ACTIONS, 'readonly');
      const store = tx.objectStore(STORES.ACTIONS);

      const index = store.index('cellId');
      const request = index.getAll(cellId);

      request.onsuccess = () => {
        let results = request.result as StorableAction[];

        if (filter?.actionType) {
          results = results.filter(a => a.actionType === filter.actionType);
        }

        resolve(results.map(s => this.storableToAction(s)));
      };

      request.onerror = () => reject(request.error);
    });
  }

  // ============================================================================
  // Entry Operations
  // ============================================================================

  /**
   * Store entry content
   */
  async putEntry(entry: StoredEntry, dnaHash: Uint8Array, agentPubKey: Uint8Array): Promise<void> {
    await this.init();
    const cellId = this.getCellId(dnaHash, agentPubKey);

    const storable: StorableEntry = {
      entryHash: Array.from(entry.entryHash),
      entryContent: Array.from(entry.entryContent),
      entryType: entry.entryType,
      cellId,
    };

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORES.ENTRIES, 'readwrite');
      const request = tx.objectStore(STORES.ENTRIES).put(storable);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get entry by hash
   */
  async getEntry(entryHash: Uint8Array): Promise<StoredEntry | null> {
    await this.init();
    const key = Array.from(entryHash);

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORES.ENTRIES, 'readonly');
      const request = tx.objectStore(STORES.ENTRIES).get(key);

      request.onsuccess = () => {
        const storable = request.result as StorableEntry | undefined;
        if (!storable) {
          resolve(null);
          return;
        }

        resolve({
          entryHash: new Uint8Array(storable.entryHash),
          entryContent: new Uint8Array(storable.entryContent),
          entryType: storable.entryType,
        });
      };

      request.onerror = () => reject(request.error);
    });
  }

  // ============================================================================
  // Record Operations (Action + Entry)
  // ============================================================================

  /**
   * Get full record by action hash
   */
  async getRecord(actionHash: Uint8Array): Promise<StoredRecord | null> {
    const action = await this.getAction(actionHash);
    if (!action) return null;

    let entry: StoredEntry | undefined;

    // Fetch entry if action has one
    if ('entryHash' in action && action.entryHash) {
      entry = (await this.getEntry(action.entryHash)) || undefined;
    }

    return {
      actionHash,
      action,
      entry,
    };
  }

  /**
   * Get details for an entry (all CRUD history)
   */
  async getDetails(
    entryHash: Uint8Array,
    dnaHash: Uint8Array,
    agentPubKey: Uint8Array
  ): Promise<RecordDetails | null> {
    // Find the Create action for this entry
    const allActions = await this.queryActions(dnaHash, agentPubKey);
    const createAction = allActions.find(
      a => a.actionType === 'Create' &&
           'entryHash' in a &&
           this.hashesEqual(a.entryHash, entryHash)
    ) as CreateAction | undefined;

    if (!createAction) return null;

    const entry = await this.getEntry(entryHash);
    if (!entry) return null;

    // Find all updates and deletes
    const updates = allActions
      .filter(a => a.actionType === 'Update' && this.hashesEqual((a as UpdateAction).originalEntryHash, entryHash))
      .map(a => ({
        updateHash: a.actionHash,
        updateAction: a as UpdateAction,
      }));

    const deletes = allActions
      .filter(a => a.actionType === 'Delete' && this.hashesEqual((a as DeleteAction).deletesEntryHash, entryHash))
      .map(a => ({
        deleteHash: a.actionHash,
        deleteAction: a as DeleteAction,
      }));

    return {
      record: {
        actionHash: createAction.actionHash,
        action: createAction,
        entry,
      },
      validationStatus: 'Valid',
      deletes,
      updates,
    };
  }

  // ============================================================================
  // Link Operations
  // ============================================================================

  /**
   * Store a link
   */
  async putLink(link: Link, dnaHash: Uint8Array, agentPubKey: Uint8Array): Promise<void> {
    await this.init();
    const cellId = this.getCellId(dnaHash, agentPubKey);

    const storable: StorableLink = {
      createLinkHash: Array.from(link.createLinkHash),
      baseAddress: Array.from(link.baseAddress),
      targetAddress: Array.from(link.targetAddress),
      timestamp: link.timestamp.toString(),
      zomeIndex: link.zomeIndex,
      linkType: link.linkType,
      tag: Array.from(link.tag),
      author: Array.from(link.author),
      deleted: link.deleted,
      deleteHash: link.deleteHash ? Array.from(link.deleteHash) : undefined,
      cellId,
    };

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORES.LINKS, 'readwrite');
      const request = tx.objectStore(STORES.LINKS).put(storable);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get links by base address
   */
  async getLinks(
    baseAddress: Uint8Array,
    dnaHash: Uint8Array,
    agentPubKey: Uint8Array,
    linkType?: number
  ): Promise<Link[]> {
    await this.init();
    const cellId = this.getCellId(dnaHash, agentPubKey);

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORES.LINKS, 'readonly');
      const store = tx.objectStore(STORES.LINKS);

      const indexName = linkType !== undefined
        ? 'cellId_baseAddress_linkType'
        : 'cellId_baseAddress';

      const key = linkType !== undefined
        ? [cellId, Array.from(baseAddress), linkType]
        : [cellId, Array.from(baseAddress)];

      const index = store.index(indexName);
      const request = index.getAll(key);

      request.onsuccess = () => {
        const results = request.result as StorableLink[];
        resolve(results.map(s => ({
          createLinkHash: new Uint8Array(s.createLinkHash),
          baseAddress: new Uint8Array(s.baseAddress),
          targetAddress: new Uint8Array(s.targetAddress),
          timestamp: BigInt(s.timestamp),
          zomeIndex: s.zomeIndex,
          linkType: s.linkType,
          tag: new Uint8Array(s.tag),
          author: new Uint8Array(s.author),
          deleted: s.deleted,
          deleteHash: s.deleteHash ? new Uint8Array(s.deleteHash) : undefined,
        })));
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Mark a link as deleted
   */
  async deleteLink(
    createLinkHash: Uint8Array,
    deleteHash: Uint8Array
  ): Promise<void> {
    await this.init();
    const key = Array.from(createLinkHash);

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORES.LINKS, 'readwrite');
      const store = tx.objectStore(STORES.LINKS);
      const getRequest = store.get(key);

      getRequest.onsuccess = () => {
        const link = getRequest.result as StorableLink | undefined;
        if (!link) {
          resolve();
          return;
        }

        link.deleted = true;
        link.deleteHash = Array.from(deleteHash);

        const putRequest = store.put(link);
        putRequest.onsuccess = () => resolve();
        putRequest.onerror = () => reject(putRequest.error);
      };

      getRequest.onerror = () => reject(getRequest.error);
    });
  }

  // ============================================================================
  // Utilities
  // ============================================================================

  /**
   * Compare two hash Uint8Arrays for equality
   */
  private hashesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  /**
   * Clear all data (for testing)
   */
  async clear(): Promise<void> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(
        [STORES.ACTIONS, STORES.ENTRIES, STORES.LINKS, STORES.CHAIN_HEADS],
        'readwrite'
      );

      tx.objectStore(STORES.ACTIONS).clear();
      tx.objectStore(STORES.ENTRIES).clear();
      tx.objectStore(STORES.LINKS).clear();
      tx.objectStore(STORES.CHAIN_HEADS).clear();

      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
```

**Files:**
- `packages/core/src/storage/source-chain-storage.ts` - Create (~600 lines)

---

## Task 6.3: Create Storage Module Exports

**Create: `packages/core/src/storage/index.ts`**

```typescript
export * from './types';
export * from './source-chain-storage';
```

**Update: `packages/core/src/index.ts`**

Add export for storage module:

```typescript
export * from './storage';
```

**Files:**
- `packages/core/src/storage/index.ts` - Create
- `packages/core/src/index.ts` - Add export

---

## Task 6.4: Add Transaction Support for Atomic Chain Updates

**CRITICAL REQUIREMENT**: All chain operations within a single zome call must be atomic. If any operation fails, the entire transaction must roll back.

**Update: `packages/core/src/storage/source-chain-storage.ts`**

Add transaction support using IndexedDB transactions:

```typescript
export class SourceChainStorage {
  // ... existing code ...

  /**
   * Transaction context for batching operations
   */
  private pendingTransaction: {
    actions: Array<{ action: Action; dnaHash: Uint8Array; agentPubKey: Uint8Array }>;
    entries: Array<{ entry: StoredEntry; dnaHash: Uint8Array; agentPubKey: Uint8Array }>;
    links: Array<{ link: Link; dnaHash: Uint8Array; agentPubKey: Uint8Array }>;
    chainHeadUpdate: {
      dnaHash: Uint8Array;
      agentPubKey: Uint8Array;
      actionSeq: number;
      actionHash: Uint8Array;
      timestamp: bigint;
    } | null;
  } | null = null;

  /**
   * Begin a transaction for atomic chain updates
   */
  beginTransaction(): void {
    if (this.pendingTransaction) {
      throw new Error('Transaction already in progress');
    }

    this.pendingTransaction = {
      actions: [],
      entries: [],
      links: [],
      chainHeadUpdate: null,
    };

    console.log('[SourceChainStorage] Transaction started');
  }

  /**
   * Commit all pending operations atomically
   */
  async commitTransaction(): Promise<void> {
    if (!this.pendingTransaction) {
      throw new Error('No transaction in progress');
    }

    await this.init();

    const tx = this.pendingTransaction;
    this.pendingTransaction = null;

    return new Promise((resolve, reject) => {
      // Create a single IDBTransaction for all stores
      const idbTx = this.db!.transaction(
        [STORES.ACTIONS, STORES.ENTRIES, STORES.LINKS, STORES.CHAIN_HEADS],
        'readwrite'
      );

      // Queue all operations
      const actionsStore = idbTx.objectStore(STORES.ACTIONS);
      const entriesStore = idbTx.objectStore(STORES.ENTRIES);
      const linksStore = idbTx.objectStore(STORES.LINKS);
      const chainHeadsStore = idbTx.objectStore(STORES.CHAIN_HEADS);

      // Add actions
      for (const { action, dnaHash, agentPubKey } of tx.actions) {
        const cellId = this.getCellId(dnaHash, agentPubKey);
        const storable = this.actionToStorable(action, cellId);
        actionsStore.put(storable);
      }

      // Add entries
      for (const { entry, dnaHash, agentPubKey } of tx.entries) {
        const cellId = this.getCellId(dnaHash, agentPubKey);
        const storable: StorableEntry = {
          entryHash: Array.from(entry.entryHash),
          entryContent: Array.from(entry.entryContent),
          entryType: entry.entryType,
          cellId,
        };
        entriesStore.put(storable);
      }

      // Add links
      for (const { link, dnaHash, agentPubKey } of tx.links) {
        const cellId = this.getCellId(dnaHash, agentPubKey);
        const storable: StorableLink = {
          createLinkHash: Array.from(link.createLinkHash),
          baseAddress: Array.from(link.baseAddress),
          targetAddress: Array.from(link.targetAddress),
          timestamp: link.timestamp.toString(),
          zomeIndex: link.zomeIndex,
          linkType: link.linkType,
          tag: Array.from(link.tag),
          author: Array.from(link.author),
          deleted: link.deleted,
          deleteHash: link.deleteHash ? Array.from(link.deleteHash) : undefined,
          cellId,
        };
        linksStore.put(storable);
      }

      // Update chain head
      if (tx.chainHeadUpdate) {
        const { dnaHash, agentPubKey, actionSeq, actionHash, timestamp } = tx.chainHeadUpdate;
        const cellId = this.getCellId(dnaHash, agentPubKey);
        const storable: StorableChainHead = {
          cellId,
          actionSeq,
          actionHash: Array.from(actionHash),
          timestamp: timestamp.toString(),
        };
        chainHeadsStore.put(storable);
      }

      // Handle transaction completion
      idbTx.oncomplete = () => {
        console.log('[SourceChainStorage] Transaction committed', {
          actions: tx.actions.length,
          entries: tx.entries.length,
          links: tx.links.length,
          chainHeadUpdated: !!tx.chainHeadUpdate,
        });
        resolve();
      };

      idbTx.onerror = () => {
        console.error('[SourceChainStorage] Transaction failed:', idbTx.error);
        reject(idbTx.error);
      };

      idbTx.onabort = () => {
        console.error('[SourceChainStorage] Transaction aborted');
        reject(new Error('Transaction aborted'));
      };
    });
  }

  /**
   * Rollback transaction (discard pending operations)
   */
  rollbackTransaction(): void {
    if (!this.pendingTransaction) {
      throw new Error('No transaction in progress');
    }

    console.log('[SourceChainStorage] Transaction rolled back', {
      actions: this.pendingTransaction.actions.length,
      entries: this.pendingTransaction.entries.length,
      links: this.pendingTransaction.links.length,
    });

    this.pendingTransaction = null;
  }

  /**
   * Check if transaction is in progress
   */
  isTransactionActive(): boolean {
    return this.pendingTransaction !== null;
  }

  // Update existing methods to use transactions

  async putAction(action: Action, dnaHash: Uint8Array, agentPubKey: Uint8Array): Promise<void> {
    if (this.pendingTransaction) {
      // Add to transaction
      this.pendingTransaction.actions.push({ action, dnaHash, agentPubKey });
      return;
    }

    // Direct write (no transaction)
    await this.init();
    const cellId = this.getCellId(dnaHash, agentPubKey);
    const storable = this.actionToStorable(action, cellId);

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORES.ACTIONS, 'readwrite');
      const request = tx.objectStore(STORES.ACTIONS).put(storable);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async putEntry(entry: StoredEntry, dnaHash: Uint8Array, agentPubKey: Uint8Array): Promise<void> {
    if (this.pendingTransaction) {
      // Add to transaction
      this.pendingTransaction.entries.push({ entry, dnaHash, agentPubKey });
      return;
    }

    // Direct write (no transaction)
    // ... existing implementation ...
  }

  async putLink(link: Link, dnaHash: Uint8Array, agentPubKey: Uint8Array): Promise<void> {
    if (this.pendingTransaction) {
      // Add to transaction
      this.pendingTransaction.links.push({ link, dnaHash, agentPubKey });
      return;
    }

    // Direct write (no transaction)
    // ... existing implementation ...
  }

  async updateChainHead(
    dnaHash: Uint8Array,
    agentPubKey: Uint8Array,
    actionSeq: number,
    actionHash: Uint8Array,
    timestamp: bigint
  ): Promise<void> {
    if (this.pendingTransaction) {
      // Store for transaction commit
      this.pendingTransaction.chainHeadUpdate = {
        dnaHash,
        agentPubKey,
        actionSeq,
        actionHash,
        timestamp,
      };
      return;
    }

    // Direct write (no transaction)
    // ... existing implementation ...
  }
}
```

**Files Modified:**
- `packages/core/src/storage/source-chain-storage.ts` - Add transaction support (~150 lines)

---

## Task 6.5: Add Unit Tests for Storage Layer

**Create: `packages/core/src/storage/source-chain-storage.test.ts`**

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { SourceChainStorage } from './source-chain-storage';
import type { CreateAction, Link, ChainHead } from './types';

describe('SourceChainStorage', () => {
  let storage: SourceChainStorage;
  const dnaHash = new Uint8Array(32).fill(1);
  const agentPubKey = new Uint8Array(32).fill(2);

  beforeEach(async () => {
    storage = SourceChainStorage.getInstance();
    await storage.init();
    await storage.clear();
  });

  describe('Chain Head Operations', () => {
    it('should return null for uninitialized chain head', async () => {
      const head = await storage.getChainHead(dnaHash, agentPubKey);
      expect(head).toBeNull();
    });

    it('should update and retrieve chain head', async () => {
      const actionHash = new Uint8Array(39).fill(5);
      await storage.updateChainHead(dnaHash, agentPubKey, 3, actionHash, 1000n);

      const head = await storage.getChainHead(dnaHash, agentPubKey);
      expect(head).not.toBeNull();
      expect(head!.actionSeq).toBe(3);
      expect(Array.from(head!.actionHash)).toEqual(Array.from(actionHash));
    });
  });

  describe('Action Operations', () => {
    it('should store and retrieve a Create action', async () => {
      const action: CreateAction = {
        actionHash: new Uint8Array(39).fill(10),
        actionSeq: 1,
        author: agentPubKey,
        timestamp: 5000n,
        prevActionHash: new Uint8Array(39).fill(9),
        actionType: 'Create',
        signature: new Uint8Array(64).fill(20),
        entryHash: new Uint8Array(39).fill(11),
        entryType: { zome_id: 0, entry_index: 0 },
      };

      await storage.putAction(action, dnaHash, agentPubKey);

      const retrieved = await storage.getAction(action.actionHash);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.actionType).toBe('Create');
      expect(retrieved!.actionSeq).toBe(1);
    });

    it('should query actions by cell ID', async () => {
      const action1: CreateAction = {
        actionHash: new Uint8Array(39).fill(10),
        actionSeq: 1,
        author: agentPubKey,
        timestamp: 5000n,
        prevActionHash: null,
        actionType: 'Create',
        signature: new Uint8Array(64).fill(20),
        entryHash: new Uint8Array(39).fill(11),
        entryType: { zome_id: 0, entry_index: 0 },
      };

      await storage.putAction(action1, dnaHash, agentPubKey);

      const actions = await storage.queryActions(dnaHash, agentPubKey);
      expect(actions).toHaveLength(1);
      expect(actions[0].actionSeq).toBe(1);
    });
  });

  describe('Link Operations', () => {
    it('should store and retrieve links', async () => {
      const link: Link = {
        createLinkHash: new Uint8Array(39).fill(30),
        baseAddress: new Uint8Array(39).fill(31),
        targetAddress: new Uint8Array(39).fill(32),
        timestamp: 7000n,
        zomeIndex: 0,
        linkType: 0,
        tag: new Uint8Array([1, 2, 3]),
        author: agentPubKey,
        deleted: false,
      };

      await storage.putLink(link, dnaHash, agentPubKey);

      const links = await storage.getLinks(link.baseAddress, dnaHash, agentPubKey);
      expect(links).toHaveLength(1);
      expect(Array.from(links[0].targetAddress)).toEqual(Array.from(link.targetAddress));
    });

    it('should mark link as deleted', async () => {
      const link: Link = {
        createLinkHash: new Uint8Array(39).fill(30),
        baseAddress: new Uint8Array(39).fill(31),
        targetAddress: new Uint8Array(39).fill(32),
        timestamp: 7000n,
        zomeIndex: 0,
        linkType: 0,
        tag: new Uint8Array([1, 2, 3]),
        author: agentPubKey,
        deleted: false,
      };

      await storage.putLink(link, dnaHash, agentPubKey);

      const deleteHash = new Uint8Array(39).fill(40);
      await storage.deleteLink(link.createLinkHash, deleteHash);

      const links = await storage.getLinks(link.baseAddress, dnaHash, agentPubKey);
      expect(links[0].deleted).toBe(true);
      expect(links[0].deleteHash).toBeDefined();
    });
  });
});
```

**Files:**
- `packages/core/src/storage/source-chain-storage.test.ts` - Create (~100 lines)

---

## Step 6 Summary

**New Files Created:**
- `packages/core/src/storage/types.ts` (~350 lines)
- `packages/core/src/storage/source-chain-storage.ts` (~600 lines)
- `packages/core/src/storage/index.ts` (~2 lines)
- `packages/core/src/storage/source-chain-storage.test.ts` (~100 lines)

**Modified Files:**
- `packages/core/src/index.ts` - Add storage export

**Total New Code**: ~1,050 lines

**Testing**: Unit tests for chain heads, actions, entries, links

---

# STEP 6.5: Host Function Integration

## Task 6.5.0: Wrap Zome Calls in Transactions

**CRITICAL**: Update the ribosome to wrap all zome calls in storage transactions for atomic chain updates.

**Update: `packages/core/src/ribosome/index.ts`**

Wrap zome calls in transaction begin/commit/rollback:

```typescript
export async function callZome(request: ZomeCallRequest): Promise<ZomeCallResult> {
  const storage = SourceChainStorage.getInstance();

  // Begin transaction for atomic chain updates
  storage.beginTransaction();

  try {
    // ... existing ribosome setup ...

    // Execute WASM function
    const resultPtr = wasmFunction(inputPtr, inputLen);

    // Deserialize result
    const result = deserializeFromWasm(instance, resultPtr);

    // Commit transaction if execution succeeded
    await storage.commitTransaction();

    console.log('[callZome] Transaction committed successfully');

    return {
      success: true,
      result,
      emittedSignals: context.emittedSignals || [],
    };

  } catch (error) {
    // Rollback transaction on any error
    if (storage.isTransactionActive()) {
      storage.rollbackTransaction();
      console.error('[callZome] Transaction rolled back due to error:', error);
    }

    return {
      success: false,
      error: error.message,
      emittedSignals: context.emittedSignals || [],
    };
  }
}
```

**Files Modified:**
- `packages/core/src/ribosome/index.ts` - Add transaction wrapping

---

## Task 6.5.1: Wire Up Entry Operations (create, get, update, delete)

**Update: `packages/core/src/ribosome/host-fn/create.ts`**

Replace mock implementation with real storage:

```typescript
import { SourceChainStorage } from '../../storage/source-chain-storage';
import type { CreateAction, StoredEntry } from '../../storage/types';
import { hash } from './hash';

export const create: HostFunctionImpl = async (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;
  const storage = SourceChainStorage.getInstance();

  // Deserialize create input
  const input = deserializeFromWasm(instance, inputPtr, inputLen) as {
    entry_type: { App: { zome_id: number; entry_index: number } } | string;
    entry: Uint8Array;  // Already MessagePack-serialized
  };

  console.log('[create] Creating entry', {
    entryType: input.entry_type,
    entrySize: input.entry.length,
  });

  // Hash the entry content
  const entryHashPtr = hash(context, inputPtr + 8, inputLen - 8); // Skip entry_type field
  const entryHash = deserializeFromWasm(instance, entryHashPtr) as Uint8Array;

  // Get current chain head
  const [dnaHash, agentPubKey] = callContext.cellId;
  const chainHead = await storage.getChainHead(dnaHash, agentPubKey);

  const actionSeq = chainHead ? chainHead.actionSeq + 1 : 3; // Start at 3 (after Dna, AgentValidationPkg, InitZomesComplete)
  const prevActionHash = chainHead ? chainHead.actionHash : null;
  const timestamp = BigInt(Date.now()) * 1000n; // Microseconds

  // Create action hash (simplified - should use proper hash in production)
  const actionHash = new Uint8Array(39);
  crypto.getRandomValues(actionHash);
  actionHash[0] = 0x84;
  actionHash[1] = 0x29;
  actionHash[2] = 0x24;

  // Create signature (mock - should use Lair in production)
  const signature = new Uint8Array(64);
  crypto.getRandomValues(signature);

  // Build Create action
  const action: CreateAction = {
    actionHash,
    actionSeq,
    author: agentPubKey,
    timestamp,
    prevActionHash,
    actionType: 'Create',
    signature,
    entryHash,
    entryType: typeof input.entry_type === 'string' ? null : input.entry_type.App,
  };

  // Store entry content
  const entry: StoredEntry = {
    entryHash,
    entryContent: input.entry,
    entryType: typeof input.entry_type === 'string' ? input.entry_type : input.entry_type.App,
  };

  await storage.putEntry(entry, dnaHash, agentPubKey);
  await storage.putAction(action, dnaHash, agentPubKey);
  await storage.updateChainHead(dnaHash, agentPubKey, actionSeq, actionHash, timestamp);

  console.log('[create] Created entry', {
    actionHash: actionHash.slice(0, 8),
    actionSeq,
    entryHash: entryHash.slice(0, 8),
  });

  return serializeResult(instance, actionHash);
};
```

**Update: `packages/core/src/ribosome/host-fn/get.ts`**

```typescript
import { SourceChainStorage } from '../../storage/source-chain-storage';

export const get: HostFunctionImpl = async (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;
  const storage = SourceChainStorage.getInstance();

  // Deserialize get input (action hash)
  const input = deserializeFromWasm(instance, inputPtr, inputLen) as {
    hash: Uint8Array;
    options: unknown;
  };

  const actionHash = input.hash;

  console.log('[get] Getting record', {
    hash: actionHash.slice(0, 8),
  });

  // Retrieve from storage
  const record = await storage.getRecord(actionHash);

  if (!record) {
    console.log('[get] Record not found');
    return serializeResult(instance, null);
  }

  // Build Record structure
  const recordResult = {
    signed_action: {
      hashed: {
        content: record.action,
        hash: actionHash,
      },
      signature: record.action.signature,
    },
    entry: record.entry ? {
      content: record.entry.entryContent,
      hash: record.entry.entryHash,
    } : null,
  };

  console.log('[get] Found record', {
    actionType: record.action.actionType,
    hasEntry: !!record.entry,
  });

  return serializeResult(instance, recordResult);
};
```

**Update: `packages/core/src/ribosome/host-fn/update.ts`**

```typescript
import { SourceChainStorage } from '../../storage/source-chain-storage';
import type { UpdateAction, StoredEntry } from '../../storage/types';
import { hash } from './hash';

export const update: HostFunctionImpl = async (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;
  const storage = SourceChainStorage.getInstance();

  const input = deserializeFromWasm(instance, inputPtr, inputLen) as {
    original_action_hash: Uint8Array;
    entry_type: { App: { zome_id: number; entry_index: number } };
    entry: Uint8Array;
  };

  // Hash new entry
  const entryHashPtr = hash(context, inputPtr + 48, inputLen - 48); // Skip original_action_hash + entry_type
  const entryHash = deserializeFromWasm(instance, entryHashPtr) as Uint8Array;

  // Get original action to retrieve original entry hash
  const originalAction = await storage.getAction(input.original_action_hash);
  if (!originalAction || (originalAction.actionType !== 'Create' && originalAction.actionType !== 'Update')) {
    throw new Error('Original action not found or not an entry-creating action');
  }

  const [dnaHash, agentPubKey] = callContext.cellId;
  const chainHead = await storage.getChainHead(dnaHash, agentPubKey);

  const actionSeq = chainHead ? chainHead.actionSeq + 1 : 3;
  const prevActionHash = chainHead ? chainHead.actionHash : null;
  const timestamp = BigInt(Date.now()) * 1000n;

  const actionHash = new Uint8Array(39);
  crypto.getRandomValues(actionHash);
  actionHash[0] = 0x84;
  actionHash[1] = 0x29;
  actionHash[2] = 0x24;

  const signature = new Uint8Array(64);
  crypto.getRandomValues(signature);

  const action: UpdateAction = {
    actionHash,
    actionSeq,
    author: agentPubKey,
    timestamp,
    prevActionHash,
    actionType: 'Update',
    signature,
    entryHash,
    entryType: input.entry_type.App,
    originalActionHash: input.original_action_hash,
    originalEntryHash: (originalAction as any).entryHash,
  };

  const entry: StoredEntry = {
    entryHash,
    entryContent: input.entry,
    entryType: input.entry_type.App,
  };

  await storage.putEntry(entry, dnaHash, agentPubKey);
  await storage.putAction(action, dnaHash, agentPubKey);
  await storage.updateChainHead(dnaHash, agentPubKey, actionSeq, actionHash, timestamp);

  console.log('[update] Updated entry', { actionHash: actionHash.slice(0, 8), actionSeq });

  return serializeResult(instance, actionHash);
};
```

**Update: `packages/core/src/ribosome/host-fn/delete.ts`**

```typescript
import { SourceChainStorage } from '../../storage/source-chain-storage';
import type { DeleteAction } from '../../storage/types';

export const deleteEntry: HostFunctionImpl = async (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;
  const storage = SourceChainStorage.getInstance();

  const input = deserializeFromWasm(instance, inputPtr, inputLen) as {
    deletes_action_hash: Uint8Array;
  };

  // Get action being deleted
  const deletesAction = await storage.getAction(input.deletes_action_hash);
  if (!deletesAction || (deletesAction.actionType !== 'Create' && deletesAction.actionType !== 'Update')) {
    throw new Error('Action to delete not found or not an entry-creating action');
  }

  const [dnaHash, agentPubKey] = callContext.cellId;
  const chainHead = await storage.getChainHead(dnaHash, agentPubKey);

  const actionSeq = chainHead ? chainHead.actionSeq + 1 : 3;
  const prevActionHash = chainHead ? chainHead.actionHash : null;
  const timestamp = BigInt(Date.now()) * 1000n;

  const actionHash = new Uint8Array(39);
  crypto.getRandomValues(actionHash);
  actionHash[0] = 0x84;
  actionHash[1] = 0x29;
  actionHash[2] = 0x24;

  const signature = new Uint8Array(64);
  crypto.getRandomValues(signature);

  const action: DeleteAction = {
    actionHash,
    actionSeq,
    author: agentPubKey,
    timestamp,
    prevActionHash,
    actionType: 'Delete',
    signature,
    deletesActionHash: input.deletes_action_hash,
    deletesEntryHash: (deletesAction as any).entryHash,
  };

  await storage.putAction(action, dnaHash, agentPubKey);
  await storage.updateChainHead(dnaHash, agentPubKey, actionSeq, actionHash, timestamp);

  console.log('[delete] Deleted entry', { actionHash: actionHash.slice(0, 8), actionSeq });

  return serializeResult(instance, actionHash);
};
```

**Update: `packages/core/src/ribosome/host-fn/query.ts`**

```typescript
import { SourceChainStorage } from '../../storage/source-chain-storage';

export const query: HostFunctionImpl = async (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;
  const storage = SourceChainStorage.getInstance();

  const input = deserializeFromWasm(instance, inputPtr, inputLen) as {
    filter: unknown;
  };

  console.log('[query] Querying source chain', { filter: input.filter });

  const [dnaHash, agentPubKey] = callContext.cellId;
  const actions = await storage.queryActions(dnaHash, agentPubKey);

  // Build records from actions
  const records = await Promise.all(
    actions.map(async (action) => {
      let entry = undefined;
      if ('entryHash' in action && action.entryHash) {
        entry = await storage.getEntry(action.entryHash);
      }

      return {
        signed_action: {
          hashed: {
            content: action,
            hash: action.actionHash,
          },
          signature: action.signature,
        },
        entry: entry ? {
          content: entry.entryContent,
          hash: entry.entryHash,
        } : null,
      };
    })
  );

  console.log('[query] Found records:', records.length);

  return serializeResult(instance, records);
};
```

**Files Modified:**
- `packages/core/src/ribosome/host-fn/create.ts`
- `packages/core/src/ribosome/host-fn/get.ts`
- `packages/core/src/ribosome/host-fn/update.ts`
- `packages/core/src/ribosome/host-fn/delete.ts`
- `packages/core/src/ribosome/host-fn/query.ts`

---

## Task 6.5.2: Wire Up Link Operations

**Update: `packages/core/src/ribosome/host-fn/create_link.ts`**

```typescript
import { SourceChainStorage } from '../../storage/source-chain-storage';
import type { CreateLinkAction, Link } from '../../storage/types';

export const createLink: HostFunctionImpl = async (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;
  const storage = SourceChainStorage.getInstance();

  const input = deserializeFromWasm(instance, inputPtr, inputLen) as {
    base_address: Uint8Array;
    target_address: Uint8Array;
    zome_index: number;
    link_type: number;
    tag: Uint8Array;
  };

  console.log('[create_link] Creating link', {
    base: input.base_address.slice(0, 8),
    target: input.target_address.slice(0, 8),
    linkType: input.link_type,
  });

  const [dnaHash, agentPubKey] = callContext.cellId;
  const chainHead = await storage.getChainHead(dnaHash, agentPubKey);

  const actionSeq = chainHead ? chainHead.actionSeq + 1 : 3;
  const prevActionHash = chainHead ? chainHead.actionHash : null;
  const timestamp = BigInt(Date.now()) * 1000n;

  const actionHash = new Uint8Array(39);
  crypto.getRandomValues(actionHash);
  actionHash[0] = 0x84;
  actionHash[1] = 0x29;
  actionHash[2] = 0x24;

  const signature = new Uint8Array(64);
  crypto.getRandomValues(signature);

  const action: CreateLinkAction = {
    actionHash,
    actionSeq,
    author: agentPubKey,
    timestamp,
    prevActionHash,
    actionType: 'CreateLink',
    signature,
    baseAddress: input.base_address,
    targetAddress: input.target_address,
    zomeIndex: input.zome_index,
    linkType: input.link_type,
    tag: input.tag,
  };

  const link: Link = {
    createLinkHash: actionHash,
    baseAddress: input.base_address,
    targetAddress: input.target_address,
    timestamp,
    zomeIndex: input.zome_index,
    linkType: input.link_type,
    tag: input.tag,
    author: agentPubKey,
    deleted: false,
  };

  await storage.putAction(action, dnaHash, agentPubKey);
  await storage.putLink(link, dnaHash, agentPubKey);
  await storage.updateChainHead(dnaHash, agentPubKey, actionSeq, actionHash, timestamp);

  console.log('[create_link] Created link', { actionHash: actionHash.slice(0, 8), actionSeq });

  return serializeResult(instance, actionHash);
};
```

**Update: `packages/core/src/ribosome/host-fn/get_links.ts`**

```typescript
import { SourceChainStorage } from '../../storage/source-chain-storage';

export const getLinks: HostFunctionImpl = async (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;
  const storage = SourceChainStorage.getInstance();

  const input = deserializeFromWasm(instance, inputPtr, inputLen) as {
    base_address: Uint8Array;
    link_type?: number;
    tag?: Uint8Array;
  };

  console.log('[get_links] Getting links', {
    base: input.base_address.slice(0, 8),
    linkType: input.link_type,
  });

  const [dnaHash, agentPubKey] = callContext.cellId;
  let links = await storage.getLinks(input.base_address, dnaHash, agentPubKey, input.link_type);

  // Filter out deleted links
  links = links.filter(link => !link.deleted);

  // Filter by tag if provided
  if (input.tag) {
    links = links.filter(link =>
      link.tag.length === input.tag!.length &&
      link.tag.every((byte, i) => byte === input.tag![i])
    );
  }

  console.log('[get_links] Found links:', links.length);

  return serializeResult(instance, links);
};
```

**Update: `packages/core/src/ribosome/host-fn/delete_link.ts`**

```typescript
import { SourceChainStorage } from '../../storage/source-chain-storage';
import type { DeleteLinkAction } from '../../storage/types';

export const deleteLink: HostFunctionImpl = async (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;
  const storage = SourceChainStorage.getInstance();

  const input = deserializeFromWasm(instance, inputPtr, inputLen) as {
    link_add_address: Uint8Array;
  };

  console.log('[delete_link] Deleting link', {
    linkAddHash: input.link_add_address.slice(0, 8),
  });

  // Get the CreateLink action
  const createLinkAction = await storage.getAction(input.link_add_address);
  if (!createLinkAction || createLinkAction.actionType !== 'CreateLink') {
    throw new Error('Link to delete not found');
  }

  const [dnaHash, agentPubKey] = callContext.cellId;
  const chainHead = await storage.getChainHead(dnaHash, agentPubKey);

  const actionSeq = chainHead ? chainHead.actionSeq + 1 : 3;
  const prevActionHash = chainHead ? chainHead.actionHash : null;
  const timestamp = BigInt(Date.now()) * 1000n;

  const actionHash = new Uint8Array(39);
  crypto.getRandomValues(actionHash);
  actionHash[0] = 0x84;
  actionHash[1] = 0x29;
  actionHash[2] = 0x24;

  const signature = new Uint8Array(64);
  crypto.getRandomValues(signature);

  const action: DeleteLinkAction = {
    actionHash,
    actionSeq,
    author: agentPubKey,
    timestamp,
    prevActionHash,
    actionType: 'DeleteLink',
    signature,
    linkAddAddress: input.link_add_address,
    baseAddress: createLinkAction.baseAddress,
  };

  await storage.putAction(action, dnaHash, agentPubKey);
  await storage.deleteLink(input.link_add_address, actionHash);
  await storage.updateChainHead(dnaHash, agentPubKey, actionSeq, actionHash, timestamp);

  console.log('[delete_link] Deleted link', { actionHash: actionHash.slice(0, 8), actionSeq });

  return serializeResult(instance, actionHash);
};
```

**Update: `packages/core/src/ribosome/host-fn/count_links.ts`**

```typescript
import { SourceChainStorage } from '../../storage/source-chain-storage';

export const countLinks: HostFunctionImpl = async (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;
  const storage = SourceChainStorage.getInstance();

  const input = deserializeFromWasm(instance, inputPtr, inputLen) as {
    base_address: Uint8Array;
    link_type?: number;
  };

  const [dnaHash, agentPubKey] = callContext.cellId;
  const links = await storage.getLinks(input.base_address, dnaHash, agentPubKey, input.link_type);

  // Count non-deleted links
  const count = links.filter(link => !link.deleted).length;

  console.log('[count_links] Counted links:', count);

  return serializeResult(instance, count);
};
```

**Files Modified:**
- `packages/core/src/ribosome/host-fn/create_link.ts`
- `packages/core/src/ribosome/host-fn/get_links.ts`
- `packages/core/src/ribosome/host-fn/delete_link.ts`
- `packages/core/src/ribosome/host-fn/count_links.ts`

---

## Task 6.5.3: Wire Up get_details

**Update: `packages/core/src/ribosome/host-fn/stubs.ts`**

Replace get_details stub with real implementation:

```typescript
// Remove old stub:
// export const getDetails = createEmptyArrayStub("get_details");

// Add real implementation:
import { SourceChainStorage } from '../../storage/source-chain-storage';

export const getDetails: HostFunctionImpl = async (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;
  const storage = SourceChainStorage.getInstance();

  const input = deserializeFromWasm(instance, inputPtr, inputLen) as {
    hash: Uint8Array;
    options: unknown;
  };

  console.log('[get_details] Getting details for hash', {
    hash: input.hash.slice(0, 8),
  });

  const [dnaHash, agentPubKey] = callContext.cellId;

  // Try to get as action hash first
  const action = await storage.getAction(input.hash);

  if (action && 'entryHash' in action && action.entryHash) {
    // Get full details for this entry
    const details = await storage.getDetails(action.entryHash, dnaHash, agentPubKey);

    if (details) {
      const result = {
        record: {
          signed_action: {
            hashed: {
              content: details.record.action,
              hash: details.record.actionHash,
            },
            signature: details.record.action.signature,
          },
          entry: details.record.entry ? {
            content: details.record.entry.entryContent,
            hash: details.record.entry.entryHash,
          } : null,
        },
        validation_status: details.validationStatus,
        deletes: details.deletes.map(d => ({
          signed_action: {
            hashed: {
              content: d.deleteAction,
              hash: d.deleteHash,
            },
            signature: d.deleteAction.signature,
          },
        })),
        updates: details.updates.map(u => ({
          signed_action: {
            hashed: {
              content: u.updateAction,
              hash: u.updateHash,
            },
            signature: u.updateAction.signature,
          },
        })),
      };

      console.log('[get_details] Found details', {
        deletes: details.deletes.length,
        updates: details.updates.length,
      });

      return serializeResult(instance, [result]);
    }
  }

  // Not found
  console.log('[get_details] No details found');
  return serializeResult(instance, [null]);
};
```

**Files Modified:**
- `packages/core/src/ribosome/host-fn/stubs.ts`

---

## Task 6.5.4: Wire Up agent_info to Return Real Chain Head

**Update: `packages/core/src/ribosome/host-fn/agent_info.ts`**

```typescript
import { SourceChainStorage } from '../../storage/source-chain-storage';

export const agentInfo: HostFunctionImpl = async (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;
  const storage = SourceChainStorage.getInstance();

  const [dnaHash, agentPubKey] = callContext.cellId;

  // Get real chain head
  const chainHead = await storage.getChainHead(dnaHash, agentPubKey);

  const agentInfoData = {
    agent_initial_pubkey: agentPubKey,
    agent_latest_pubkey: agentPubKey,
    chain_head: chainHead
      ? {
          action_seq: chainHead.actionSeq,
          hash: chainHead.actionHash,
          timestamp: chainHead.timestamp,
        }
      : {
          action_seq: 0,
          hash: new Uint8Array(39).fill(0),
          timestamp: 0n,
        },
  };

  console.log('[agent_info] Returning agent info', {
    chainSeq: chainHead?.actionSeq ?? 0,
    hasChainHead: !!chainHead,
  });

  return serializeResult(instance, agentInfoData);
};
```

**Files Modified:**
- `packages/core/src/ribosome/host-fn/agent_info.ts`

---

## Task 6.5.5: Update Host Function Signatures to Support Async

All host functions that now use storage need to be async. Update the base type:

**Update: `packages/core/src/ribosome/host-fn/base.ts`**

```typescript
export type HostFunctionImpl = (
  context: HostFunctionContext,
  inputPtr: number,
  inputLen: number
) => number | Promise<number>;
```

**Update: `packages/core/src/ribosome/index.ts`**

Wrap host function calls to handle async:

```typescript
// In createHostFunction helper
function createHostFunction(impl: HostFunctionImpl, name: string) {
  return (inputPtr: number, inputLen: number): number => {
    const result = impl(hostContext, inputPtr, inputLen);

    // If async, we need to handle promises
    if (result instanceof Promise) {
      // Store promise and return placeholder
      // WASM will need to wait or use callback pattern
      throw new Error('Async host functions not yet supported in synchronous WASM context');
    }

    return result;
  };
}
```

**NOTE**: Holochain's ribosome uses Tokio async runtime. For browser compatibility, we'll need to either:
1. Make WASM calls async-aware (complex)
2. Pre-load all needed data before WASM execution (simpler)

**Recommended Approach for Step 6.5**: Pre-initialize chain data before zome call.

**Files Modified:**
- `packages/core/src/ribosome/host-fn/base.ts`
- `packages/core/src/ribosome/index.ts`

---

## Task 6.5.6: Add Test Zome Function for Atomic Operations

**Create test function in test-zome that creates entry + link atomically**

**Update: `packages/test-zome/src/lib.rs`**

Add function that creates entry and link in one call:

```rust
/// Test atomic operations: create entry + link in single zome call
/// If link creation fails, entry should not be persisted
#[hdk_extern]
fn create_entry_with_link(target_hash: ActionHash) -> ExternResult<(ActionHash, ActionHash)> {
    // Create entry
    let entry = TestEntry {
        content: "Entry with link".to_string(),
        timestamp: sys_time()?,
    };

    let entry_hash = create_entry(&EntryTypes::TestEntry(entry))?;

    // Create link to target
    let link_hash = create_link(
        entry_hash.clone(),
        target_hash,
        LinkTypes::Placeholder,
        (),
    )?;

    Ok((entry_hash, link_hash))
}

/// Test function that INTENTIONALLY fails after creating entry
/// Used to test rollback behavior
#[hdk_extern]
fn create_entry_then_fail(_: ()) -> ExternResult<ActionHash> {
    // Create entry
    let entry = TestEntry {
        content: "This should roll back".to_string(),
        timestamp: sys_time()?,
    };

    let entry_hash = create_entry(&EntryTypes::TestEntry(entry))?;

    // Intentionally fail
    Err(wasm_error!(WasmErrorInner::Guest(
        "Intentional failure for rollback test".to_string()
    )))
}
```

**Files Modified:**
- `packages/test-zome/src/lib.rs` - Add atomic operation test functions

---

## Task 6.5.7: Integration Testing

**Update: `packages/extension/test/wasm-test.html`**

Add tests to verify persistence AND atomic rollback:

```javascript
// Test create → get round-trip
async function testCreateAndGet() {
  log('=== Testing Create → Get Persistence ===');

  const createResult = await window.holochain.callZome({
    zome: 'test_zome',
    fn: 'create_test_entry',
    payload: 'Test entry content',
  });

  const actionHash = createResult.result;
  log(`Created entry with hash: ${encodeHashToBase64(actionHash)}`);

  // Retrieve the same entry
  const getResult = await window.holochain.callZome({
    zome: 'test_zome',
    fn: 'get_test_entry',
    payload: actionHash,
  });

  if (getResult.result && getResult.result.entry) {
    log('✓ Successfully retrieved created entry!');
    return true;
  } else {
    log('✗ Failed to retrieve entry');
    return false;
  }
}

// Test link persistence
async function testLinkPersistence() {
  log('=== Testing Link Persistence ===');

  // Create two entries
  const entry1Hash = (await window.holochain.callZome({
    zome: 'test_zome',
    fn: 'create_test_entry',
    payload: 'Entry 1',
  })).result;

  const entry2Hash = (await window.holochain.callZome({
    zome: 'test_zome',
    fn: 'create_test_entry',
    payload: 'Entry 2',
  })).result;

  // Create link
  await window.holochain.callZome({
    zome: 'test_zome',
    fn: 'create_test_link',
    payload: { base: entry1Hash, target: entry2Hash },
  });

  // Get links
  const links = (await window.holochain.callZome({
    zome: 'test_zome',
    fn: 'get_test_links',
    payload: entry1Hash,
  })).result;

  if (links && links.length > 0) {
    log(`✓ Found ${links.length} link(s)!`);
    return true;
  } else {
    log('✗ No links found');
    return false;
  }
}

// Test atomic transaction rollback
async function testAtomicRollback() {
  log('=== Testing Atomic Transaction Rollback ===');

  // Get chain head before test
  const agentInfoBefore = (await window.holochain.callZome({
    zome: 'test_zome',
    fn: 'get_agent_info',
    payload: null,
  })).result;

  const chainSeqBefore = agentInfoBefore.chain_head.action_seq;
  log(`Chain sequence before: ${chainSeqBefore}`);

  // Call function that creates entry then fails
  const failResult = await window.holochain.callZome({
    zome: 'test_zome',
    fn: 'create_entry_then_fail',
    payload: null,
  });

  // Should fail
  if (failResult.success === false) {
    log('✓ Zome call failed as expected');
  } else {
    log('✗ Zome call should have failed');
    return false;
  }

  // Get chain head after failed call
  const agentInfoAfter = (await window.holochain.callZome({
    zome: 'test_zome',
    fn: 'get_agent_info',
    payload: null,
  })).result;

  const chainSeqAfter = agentInfoAfter.chain_head.action_seq;
  log(`Chain sequence after: ${chainSeqAfter}`);

  // Chain should NOT have advanced
  if (chainSeqBefore === chainSeqAfter) {
    log('✓ Chain did not advance - transaction rolled back!');
    return true;
  } else {
    log(`✗ Chain advanced from ${chainSeqBefore} to ${chainSeqAfter} - rollback failed!`);
    return false;
  }
}

// Test atomic entry + link creation
async function testAtomicEntryAndLink() {
  log('=== Testing Atomic Entry + Link Creation ===');

  // Create target entry
  const targetHash = (await window.holochain.callZome({
    zome: 'test_zome',
    fn: 'create_test_entry',
    payload: 'Target entry',
  })).result;

  log(`Created target entry: ${encodeHashToBase64(targetHash)}`);

  // Get chain head before atomic operation
  const agentInfoBefore = (await window.holochain.callZome({
    zome: 'test_zome',
    fn: 'get_agent_info',
    payload: null,
  })).result;

  const chainSeqBefore = agentInfoBefore.chain_head.action_seq;

  // Create entry with link (atomic operation)
  const result = await window.holochain.callZome({
    zome: 'test_zome',
    fn: 'create_entry_with_link',
    payload: targetHash,
  });

  if (!result.success) {
    log('✗ Atomic operation failed');
    return false;
  }

  const [entryHash, linkHash] = result.result;
  log(`Created entry: ${encodeHashToBase64(entryHash)}`);
  log(`Created link: ${encodeHashToBase64(linkHash)}`);

  // Get chain head after atomic operation
  const agentInfoAfter = (await window.holochain.callZome({
    zome: 'test_zome',
    fn: 'get_agent_info',
    payload: null,
  })).result;

  const chainSeqAfter = agentInfoAfter.chain_head.action_seq;

  // Chain should have advanced by 2 (create entry + create link)
  if (chainSeqAfter === chainSeqBefore + 2) {
    log(`✓ Chain advanced by 2 (${chainSeqBefore} → ${chainSeqAfter})`);
  } else {
    log(`✗ Chain advanced by ${chainSeqAfter - chainSeqBefore}, expected 2`);
    return false;
  }

  // Verify entry exists
  const getResult = await window.holochain.callZome({
    zome: 'test_zome',
    fn: 'get_test_entry',
    payload: entryHash,
  });

  if (!getResult.result) {
    log('✗ Entry not found');
    return false;
  }

  // Verify link exists
  const links = (await window.holochain.callZome({
    zome: 'test_zome',
    fn: 'get_test_links',
    payload: entryHash,
  })).result;

  if (links && links.length === 1) {
    log('✓ Both entry and link persisted atomically!');
    return true;
  } else {
    log(`✗ Expected 1 link, found ${links?.length || 0}`);
    return false;
  }
}
```

**Files Modified:**
- `packages/extension/test/wasm-test.html` - Add atomic transaction tests

---

## Step 6.5 Summary

**Modified Files:**
- `packages/core/src/ribosome/index.ts` - Transaction wrapping for atomic updates
- `packages/core/src/ribosome/host-fn/create.ts` - Use storage
- `packages/core/src/ribosome/host-fn/get.ts` - Use storage
- `packages/core/src/ribosome/host-fn/update.ts` - Use storage
- `packages/core/src/ribosome/host-fn/delete.ts` - Use storage
- `packages/core/src/ribosome/host-fn/query.ts` - Use storage
- `packages/core/src/ribosome/host-fn/create_link.ts` - Use storage
- `packages/core/src/ribosome/host-fn/get_links.ts` - Use storage
- `packages/core/src/ribosome/host-fn/delete_link.ts` - Use storage
- `packages/core/src/ribosome/host-fn/count_links.ts` - Use storage
- `packages/core/src/ribosome/host-fn/stubs.ts` - Real get_details
- `packages/core/src/ribosome/host-fn/agent_info.ts` - Real chain head
- `packages/core/src/ribosome/host-fn/base.ts` - Support async
- `packages/test-zome/src/lib.rs` - Atomic operation test functions
- `packages/extension/test/wasm-test.html` - Add persistence + atomic tests

**Total Modified Code**: ~600 lines

---

# Overall Summary

## Step 6: Storage Infrastructure
- Created IndexedDB-based source chain storage
- Defined types for actions, entries, links, chain heads
- Implemented SourceChainStorage class with full CRUD
- **Added transaction support for atomic chain updates**
- Unit tests for storage layer
- **~1,200 lines of new code**

## Step 6.5: Host Function Integration
- **Wrapped all zome calls in transactions for atomic updates**
- Wired up all entry operations to use storage
- Wired up all link operations to use storage
- Implemented real get_details with CRUD history
- Updated agent_info to return real chain head
- **Added test zome functions for atomic operations and rollback**
- Added persistence + atomic transaction integration tests
- **~600 lines modified**

## Testing Strategy

1. **Unit Tests** (Step 6)
   - Chain head operations
   - Action storage and retrieval
   - Entry storage
   - Link storage and deletion

2. **Integration Tests** (Step 6.5)
   - Create → Get round-trip
   - Update → Get verification
   - Delete verification
   - Link persistence
   - Query across multiple entries
   - get_details returns full history
   - **Atomic transaction rollback** - verify failed zome calls don't corrupt chain
   - **Atomic entry + link creation** - verify both persist or both fail

3. **Manual Testing** (test-wasm.html)
   - Create entries and verify retrieval
   - Create links and query
   - Update entries and verify history
   - Delete entries and check get_details
   - Verify chain head increments
   - **Test atomic rollback** - create_entry_then_fail leaves chain unchanged
   - **Test atomic operations** - create_entry_with_link succeeds or fails atomically

## Success Criteria

- [ ] SourceChainStorage class created with IndexedDB backend
- [ ] All storage unit tests pass
- [ ] Entry operations (create, get, update, delete, query) use storage
- [ ] Link operations (create_link, get_links, delete_link, count_links) use storage
- [ ] get_details returns real Details with CRUD history
- [ ] agent_info returns real chain head (not genesis mock)
- [ ] **CRITICAL: Atomic chain updates** - All chain operations within a zome call are committed atomically:
  - If a zome call creates an entry AND a link, both must succeed or both fail
  - Partial failures do not corrupt the chain
  - Chain head only updates if all operations succeed
  - Test with a zome function that creates entry + link and verify rollback on failure
- [ ] Integration tests pass
- [ ] Manual test UI demonstrates full persistence:
  - Create entry → reload page → entry still exists
  - Create link → reload page → link still exists
  - Chain head persists across page reloads

## Known Limitations & Future Work

**Deferred to Later Steps:**
- Genesis action initialization (Dna, AgentValidationPkg, InitZomesComplete)
- Real Lair keystore integration for signatures (currently mock)
- Proper action hash computation (currently random)
- Proper entry hash computation (currently using hash host function)
- Async/await integration with WASM (may need worker pattern)
- Multi-agent testing (currently single agent per cell)
- Validation receipts and DHT metadata
- Network sync (currently local-only)

**After Step 6.5:**
- Source chain is fully functional locally
- All CRUD operations persist
- Links persist and can be queried
- Ready for Step 7: Network integration or advanced validation

## Critical Files

**New Files:**
- `packages/core/src/storage/types.ts`
- `packages/core/src/storage/source-chain-storage.ts`
- `packages/core/src/storage/source-chain-storage.test.ts`
- `packages/core/src/storage/index.ts`

**Modified Files:**
- All host function implementations in `packages/core/src/ribosome/host-fn/`
- `packages/core/src/ribosome/host-fn/base.ts`
- `packages/core/src/ribosome/index.ts`
- `packages/extension/test/wasm-test.html`
