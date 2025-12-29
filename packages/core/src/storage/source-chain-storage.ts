/**
 * Source Chain Storage
 *
 * Persistent storage for Holochain source chain data:
 * - Actions (Create, Update, Delete, CreateLink, DeleteLink, etc.)
 * - Entries (app entry content)
 * - Links (base → target relationships)
 * - Chain heads (per-cell sequence tracking)
 *
 * Supports atomic transactions for chain integrity.
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
  DnaAction,
  AgentValidationPkgAction,
  InitZomesCompleteAction,
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

  /**
   * Transaction context for batching operations
   */
  private pendingTransaction: {
    actions: Array<{ action: Action; dnaHash: Uint8Array; agentPubKey: Uint8Array }>;
    entries: Array<{ entry: StoredEntry; dnaHash: Uint8Array; agentPubKey: Uint8Array }>;
    links: Array<{ link: Link; dnaHash: Uint8Array; agentPubKey: Uint8Array }>;
    linkDeletes: Array<{ createLinkHash: Uint8Array; deleteHash: Uint8Array }>;
    chainHeadUpdate: {
      dnaHash: Uint8Array;
      agentPubKey: Uint8Array;
      actionSeq: number;
      actionHash: Uint8Array;
      timestamp: bigint;
    } | null;
  } | null = null;

  /**
   * Session cache for synchronous reads during transaction
   * Maps hash (as string) to data
   */
  private sessionCache: {
    actions: Map<string, Action>;
    entries: Map<string, StoredEntry>;
    links: Map<string, Link[]>; // Maps base address to array of links
    chainHeads: Map<string, ChainHead | null>; // Maps cellId to chain head (null for new cells)
  } = {
    actions: new Map(),
    entries: new Map(),
    links: new Map(),
    chainHeads: new Map(),
  };

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

  // ============================================================================
  // Transaction Support
  // ============================================================================

  /**
   * Begin a transaction for atomic chain updates
   *
   * NOTE: Session cache is NOT cleared here - it should be pre-loaded
   * with existing chain data before calling beginTransaction().
   * The cache will be augmented with new data during the transaction.
   */
  beginTransaction(): void {
    if (this.pendingTransaction) {
      throw new Error('Transaction already in progress');
    }

    this.pendingTransaction = {
      actions: [],
      entries: [],
      links: [],
      linkDeletes: [],
      chainHeadUpdate: null,
    };

    // DO NOT clear session cache here - it should already be pre-loaded
    // New writes during transaction will add to the cache

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

      // Delete links
      for (const { createLinkHash, deleteHash } of tx.linkDeletes) {
        const key = Array.from(createLinkHash);
        const getRequest = linksStore.get(key);

        getRequest.onsuccess = () => {
          const link = getRequest.result as StorableLink | undefined;
          if (link) {
            link.deleted = true;
            link.deleteHash = Array.from(deleteHash);
            linksStore.put(link);
          }
        };
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
          linkDeletes: tx.linkDeletes.length,
          chainHeadUpdated: !!tx.chainHeadUpdate,
        });

        // Clear session cache after successful commit
        // Next zome call will pre-load fresh data from DB
        this.sessionCache.actions.clear();
        this.sessionCache.entries.clear();
        this.sessionCache.links.clear();
        this.sessionCache.chainHeads.clear();

        console.log('[SourceChainStorage] Session cache cleared after commit');

        resolve();
      };

      idbTx.onerror = () => {
        console.error('[SourceChainStorage] Transaction failed:', idbTx.error);
        // Clear session cache on error
        this.sessionCache.actions.clear();
        this.sessionCache.entries.clear();
        this.sessionCache.links.clear();
        reject(idbTx.error);
      };

      idbTx.onabort = () => {
        console.error('[SourceChainStorage] Transaction aborted');
        // Clear session cache on abort
        this.sessionCache.actions.clear();
        this.sessionCache.entries.clear();
        this.sessionCache.links.clear();
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
      linkDeletes: this.pendingTransaction.linkDeletes.length,
    });

    this.pendingTransaction = null;

    // Clear session cache on rollback
    this.sessionCache.actions.clear();
    this.sessionCache.entries.clear();
    this.sessionCache.links.clear();
    this.sessionCache.chainHeads.clear();
  }

  /**
   * Check if transaction is in progress
   */
  isTransactionActive(): boolean {
    return this.pendingTransaction !== null;
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

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

      case 'Dna':
        return {
          ...base,
          actionType: 'Dna',
          dnaHash: new Uint8Array(storable.dnaHash!),
        } as DnaAction;

      case 'AgentValidationPkg':
        return {
          ...base,
          actionType: 'AgentValidationPkg',
          membraneProof: storable.membraneProof ? new Uint8Array(storable.membraneProof) : undefined,
        } as AgentValidationPkgAction;

      case 'InitZomesComplete':
        return {
          ...base,
          actionType: 'InitZomesComplete',
        } as InitZomesCompleteAction;

      default:
        return base as Action;
    }
  }

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
   * Convert hash to string for cache key
   */
  private hashToKey(hash: Uint8Array): string {
    return Array.from(hash).join(',');
  }

  // ============================================================================
  // Chain Head Operations
  // ============================================================================

  /**
   * Get current chain head for a cell
   *
   * Returns synchronously from cache if pre-loaded, otherwise async from DB.
   */
  getChainHead(dnaHash: Uint8Array, agentPubKey: Uint8Array): ChainHead | null | Promise<ChainHead | null> {
    const cellId = this.getCellId(dnaHash, agentPubKey);

    // Check session cache first (returns ChainHead or null if cached)
    if (this.sessionCache.chainHeads.has(cellId)) {
      const cached = this.sessionCache.chainHeads.get(cellId);
      return cached !== undefined ? cached : null;
    }

    // Fall back to async database read (not pre-loaded)
    return this.getChainHeadFromDB(dnaHash, agentPubKey);
  }

  private async getChainHeadFromDB(dnaHash: Uint8Array, agentPubKey: Uint8Array): Promise<ChainHead | null> {
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
    const cellId = this.getCellId(dnaHash, agentPubKey);

    if (this.pendingTransaction) {
      // Store for transaction commit (synchronous - just buffers in memory)
      this.pendingTransaction.chainHeadUpdate = {
        dnaHash,
        agentPubKey,
        actionSeq,
        actionHash,
        timestamp,
      };

      // Update session cache for synchronous reads
      this.sessionCache.chainHeads.set(cellId, {
        cellId,
        actionSeq,
        actionHash,
        timestamp,
      });
      return;
    }

    // Direct write (no transaction) - async, and update session cache
    await this.updateChainHeadDirect(dnaHash, agentPubKey, actionSeq, actionHash, timestamp);

    // CRITICAL: Also update session cache so subsequent reads are synchronous
    this.sessionCache.chainHeads.set(cellId, {
      cellId,
      actionSeq,
      actionHash,
      timestamp,
    });
  }

  private async updateChainHeadDirect(
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
    if (this.pendingTransaction) {
      // Add to transaction (synchronous - just buffers in memory)
      this.pendingTransaction.actions.push({ action, dnaHash, agentPubKey });
      // Add to session cache for synchronous reads
      const key = this.hashToKey(action.actionHash);
      this.sessionCache.actions.set(key, action);
      return;
    }

    // Direct write (no transaction) - async, and update session cache
    await this.putActionDirect(action, dnaHash, agentPubKey);

    // CRITICAL: Also update session cache so subsequent reads are synchronous
    const key = this.hashToKey(action.actionHash);
    this.sessionCache.actions.set(key, action);
  }

  private async putActionDirect(action: Action, dnaHash: Uint8Array, agentPubKey: Uint8Array): Promise<void> {
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
   * Get action by hash (synchronous if in cache)
   */
  getAction(actionHash: Uint8Array): Action | null | Promise<Action | null> {
    // Check session cache first (synchronous)
    const cacheKey = this.hashToKey(actionHash);
    if (this.sessionCache.actions.has(cacheKey)) {
      return this.sessionCache.actions.get(cacheKey)!;
    }

    // Fall back to async IndexedDB read
    return this.getActionFromDB(actionHash);
  }

  private async getActionFromDB(actionHash: Uint8Array): Promise<Action | null> {
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
   * Query actions from session cache (synchronous)
   * Returns actions if in cache, null if not cached
   */
  queryActionsFromCache(
    dnaHash: Uint8Array,
    agentPubKey: Uint8Array,
    filter?: { actionType?: string }
  ): Action[] | null {
    // Get all actions from session cache
    const actions: Action[] = Array.from(this.sessionCache.actions.values());

    if (actions.length === 0) {
      return null; // Not in cache
    }

    // Apply filter if provided
    if (filter?.actionType) {
      return actions.filter(a => a.actionType === filter.actionType);
    }

    return actions;
  }

  /**
   * Query actions by cell ID (async, from database)
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
    if (this.pendingTransaction) {
      // Add to transaction (synchronous - just buffers in memory)
      this.pendingTransaction.entries.push({ entry, dnaHash, agentPubKey });
      // Add to session cache for synchronous reads
      const key = this.hashToKey(entry.entryHash);
      this.sessionCache.entries.set(key, entry);
      return;
    }

    // Direct write (no transaction) - async, and update session cache
    await this.putEntryDirect(entry, dnaHash, agentPubKey);

    // CRITICAL: Also update session cache so subsequent reads are synchronous
    const key = this.hashToKey(entry.entryHash);
    this.sessionCache.entries.set(key, entry);
  }

  private async putEntryDirect(entry: StoredEntry, dnaHash: Uint8Array, agentPubKey: Uint8Array): Promise<void> {
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
   * Get entry by hash (synchronous if in cache)
   */
  getEntry(entryHash: Uint8Array): StoredEntry | null | Promise<StoredEntry | null> {
    // Check session cache first (synchronous)
    const cacheKey = this.hashToKey(entryHash);
    if (this.sessionCache.entries.has(cacheKey)) {
      return this.sessionCache.entries.get(cacheKey)!;
    }

    // Fall back to async IndexedDB read
    return this.getEntryFromDB(entryHash);
  }

  private async getEntryFromDB(entryHash: Uint8Array): Promise<StoredEntry | null> {
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
   * Get details for an entry (all CRUD history) from session cache
   * Returns null if not in cache
   */
  getDetailsFromCache(
    entryHash: Uint8Array,
    dnaHash: Uint8Array,
    agentPubKey: Uint8Array
  ): RecordDetails | null {
    // Get all actions from cache
    const actions = Array.from(this.sessionCache.actions.values());
    if (actions.length === 0) return null;

    // Find the Create action for this entry
    const createAction = actions.find(
      a => a.actionType === 'Create' &&
           'entryHash' in a &&
           this.hashesEqual(a.entryHash, entryHash)
    ) as CreateAction | undefined;

    if (!createAction) return null;

    // Get entry from cache
    const entryCacheKey = this.hashToKey(entryHash);
    const entry = this.sessionCache.entries.get(entryCacheKey);
    if (!entry) return null;

    // Find all updates and deletes
    const updates = actions
      .filter(a => a.actionType === 'Update' && this.hashesEqual((a as UpdateAction).originalEntryHash, entryHash))
      .map(a => ({
        updateHash: a.actionHash,
        updateAction: a as UpdateAction,
      }));

    const deletes = actions
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
  putLink(link: Link, dnaHash: Uint8Array, agentPubKey: Uint8Array): void | Promise<void> {
    if (this.pendingTransaction) {
      // Add to transaction (synchronous - just buffers in memory)
      this.pendingTransaction.links.push({ link, dnaHash, agentPubKey });

      // Add to session cache for synchronous reads
      const baseKey = this.hashToKey(link.baseAddress);
      const existing = this.sessionCache.links.get(baseKey) || [];
      this.sessionCache.links.set(baseKey, [...existing, link]);
      return;
    }

    // Direct write (no transaction) - async
    return this.putLinkDirect(link, dnaHash, agentPubKey);
  }

  private async putLinkDirect(link: Link, dnaHash: Uint8Array, agentPubKey: Uint8Array): Promise<void> {
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
   * Get links by base address (synchronous if in cache)
   */
  getLinks(
    baseAddress: Uint8Array,
    dnaHash: Uint8Array,
    agentPubKey: Uint8Array,
    linkType?: number
  ): Link[] | Promise<Link[]> {
    // Check session cache first (synchronous)
    const baseKey = this.hashToKey(baseAddress);
    if (this.sessionCache.links.has(baseKey)) {
      let links = this.sessionCache.links.get(baseKey)!;

      // Filter by link type if specified
      if (linkType !== undefined) {
        links = links.filter(l => l.linkType === linkType);
      }

      return links;
    }

    // Fall back to async IndexedDB read
    return this.getLinksFromDB(baseAddress, dnaHash, agentPubKey, linkType);
  }

  private async getLinksFromDB(
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
  deleteLink(
    createLinkHash: Uint8Array,
    deleteHash: Uint8Array
  ): void | Promise<void> {
    if (this.pendingTransaction) {
      // Add to transaction (synchronous - just buffers in memory)
      this.pendingTransaction.linkDeletes.push({ createLinkHash, deleteHash });
      return;
    }

    // Direct write (no transaction) - async
    return this.deleteLinkDirect(createLinkHash, deleteHash);
  }

  private async deleteLinkDirect(
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
  // Pre-loading for Synchronous Access
  // ============================================================================

  /**
   * Pre-load entire chain for a cell into session cache
   *
   * This enables synchronous reads during WASM execution by loading all
   * chain data into memory before the zome call begins.
   *
   * Call this before each zome call to ensure session cache is populated.
   */
  async preloadChainForCell(dnaHash: Uint8Array, agentPubKey: Uint8Array): Promise<void> {
    await this.init();
    const cellId = this.getCellId(dnaHash, agentPubKey);

    console.log('[SourceChainStorage] Pre-loading chain for cell', { cellId });

    // Load all actions for this cell
    const actions = await this.queryActions(dnaHash, agentPubKey);
    console.log(`[SourceChainStorage] Loaded ${actions.length} actions into cache`);

    for (const action of actions) {
      const key = this.hashToKey(action.actionHash);
      this.sessionCache.actions.set(key, action);
    }

    // Load all entries for this cell
    const entries = await this.getAllEntriesForCell(cellId);
    console.log(`[SourceChainStorage] Loaded ${entries.length} entries into cache`);

    for (const entry of entries) {
      const key = this.hashToKey(entry.entryHash);
      this.sessionCache.entries.set(key, entry);
    }

    // Load all links for this cell
    const links = await this.getAllLinksForCell(cellId);
    console.log(`[SourceChainStorage] Loaded ${links.length} links into cache`);

    // Group links by base address
    const linksByBase = new Map<string, Link[]>();
    for (const link of links) {
      const baseKey = this.hashToKey(link.baseAddress);
      const existing = linksByBase.get(baseKey) || [];
      existing.push(link);
      linksByBase.set(baseKey, existing);
    }
    this.sessionCache.links = linksByBase;

    // Load chain head (or null for new cells)
    const chainHead = await this.getChainHeadFromDB(dnaHash, agentPubKey);

    // IMPORTANT: Cache the result (even if null) so getChainHead() returns synchronously
    this.sessionCache.chainHeads.set(cellId, chainHead);

    if (chainHead) {
      console.log(`[SourceChainStorage] Loaded chain head: seq=${chainHead.actionSeq}`);
    } else {
      console.log(`[SourceChainStorage] No chain head found (new cell) - cached null`);
    }

    console.log('[SourceChainStorage] Pre-load complete', {
      actions: actions.length,
      entries: entries.length,
      links: links.length,
      hasChainHead: !!chainHead,
    });
  }

  /**
   * Get all entries for a cell (used during pre-load)
   */
  private async getAllEntriesForCell(cellId: string): Promise<StoredEntry[]> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORES.ENTRIES, 'readonly');
      const store = tx.objectStore(STORES.ENTRIES);
      const index = store.index('cellId');
      const request = index.getAll(cellId);

      request.onsuccess = () => {
        const results = request.result as StorableEntry[];
        resolve(results.map(s => ({
          entryHash: new Uint8Array(s.entryHash),
          entryContent: new Uint8Array(s.entryContent),
          entryType: s.entryType,
        })));
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get all links for a cell (used during pre-load)
   */
  private async getAllLinksForCell(cellId: string): Promise<Link[]> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORES.LINKS, 'readonly');
      const store = tx.objectStore(STORES.LINKS);

      // Get all links (we'll filter by cellId using cursor)
      const request = store.openCursor();
      const links: Link[] = [];

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          const storable = cursor.value as StorableLink;
          if (storable.cellId === cellId) {
            links.push({
              createLinkHash: new Uint8Array(storable.createLinkHash),
              baseAddress: new Uint8Array(storable.baseAddress),
              targetAddress: new Uint8Array(storable.targetAddress),
              timestamp: BigInt(storable.timestamp),
              zomeIndex: storable.zomeIndex,
              linkType: storable.linkType,
              tag: new Uint8Array(storable.tag),
              author: new Uint8Array(storable.author),
              deleted: storable.deleted,
              deleteHash: storable.deleteHash ? new Uint8Array(storable.deleteHash) : undefined,
            });
          }
          cursor.continue();
        } else {
          resolve(links);
        }
      };

      request.onerror = () => reject(request.error);
    });
  }

  // ============================================================================
  // Utilities
  // ============================================================================

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
