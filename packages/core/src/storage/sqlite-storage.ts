/**
 * SQLite Storage
 *
 * Synchronous storage layer that communicates with the SQLite worker
 * via SharedArrayBuffer + Atomics for blocking calls.
 *
 * This class runs in the offscreen document and provides a synchronous
 * interface for storage operations that host functions need.
 *
 * Key Design:
 * - All public methods are SYNCHRONOUS (no Promises)
 * - Uses Atomics.wait() to block until worker completes operation
 * - Worker runs SQLite with OPFS for durable persistence
 * - COMMIT blocks until data is durably persisted to OPFS
 */

import type {
  Action,
  StoredEntry,
  StoredRecord,
  ChainHead,
  Link,
  RecordDetails,
  CreateAction,
  UpdateAction,
  DeleteAction,
} from './types';
import { STATEMENTS } from './sqlite-schema';
import { encodeHashToBase64 } from '../types/holochain-types';

// Signal buffer layout: [requestId: i32, success: i32]
const SIGNAL_BUFFER_SIZE = 8;
// Result buffer for small results (64KB)
const RESULT_BUFFER_SIZE = 64 * 1024;

export class SQLiteStorage {
  private worker: Worker | null = null;
  private signalBuffer: SharedArrayBuffer;
  private signalView: Int32Array;
  private resultBuffer: SharedArrayBuffer;
  private resultView: Uint8Array;
  private nextRequestId = 1;
  private pendingResolves = new Map<number, (result: any) => void>();
  private pendingRejects = new Map<number, (error: Error) => void>();
  private initialized = false;
  private useAsyncFallback = false;

  private static instance: SQLiteStorage | null = null;

  private constructor() {
    // Check if SharedArrayBuffer is available
    if (typeof SharedArrayBuffer === 'undefined') {
      console.warn('[SQLiteStorage] SharedArrayBuffer not available, using async fallback');
      this.useAsyncFallback = true;
      this.signalBuffer = new ArrayBuffer(SIGNAL_BUFFER_SIZE) as unknown as SharedArrayBuffer;
      this.resultBuffer = new ArrayBuffer(RESULT_BUFFER_SIZE) as unknown as SharedArrayBuffer;
    } else {
      this.signalBuffer = new SharedArrayBuffer(SIGNAL_BUFFER_SIZE);
      this.resultBuffer = new SharedArrayBuffer(RESULT_BUFFER_SIZE);
    }
    this.signalView = new Int32Array(this.signalBuffer);
    this.resultView = new Uint8Array(this.resultBuffer);
  }

  /**
   * Get singleton instance
   */
  static getInstance(): SQLiteStorage {
    if (!SQLiteStorage.instance) {
      SQLiteStorage.instance = new SQLiteStorage();
    }
    return SQLiteStorage.instance;
  }

  /**
   * Initialize the SQLite worker
   * This MUST be called before any other operations.
   * Unlike other methods, this is async because worker creation is async.
   */
  async init(workerUrl: string): Promise<void> {
    if (this.initialized) return;

    console.log('[SQLiteStorage] Initializing worker...');

    // Create worker
    this.worker = new Worker(workerUrl);

    // Setup message handler for async fallback
    this.worker.onmessage = (event) => {
      const { id, success, result, error } = event.data;

      if (id === 0 && result?.type === 'READY') {
        console.log('[SQLiteStorage] Worker ready');
        return;
      }

      const resolve = this.pendingResolves.get(id);
      const reject = this.pendingRejects.get(id);

      this.pendingResolves.delete(id);
      this.pendingRejects.delete(id);

      if (success && resolve) {
        resolve(result);
      } else if (reject) {
        reject(new Error(error || 'Unknown worker error'));
      }
    };

    this.worker.onerror = (error) => {
      console.error('[SQLiteStorage] Worker error:', error);
    };

    // Setup shared buffers if available
    if (!this.useAsyncFallback) {
      await this.sendMessageAsync({
        type: 'SETUP_BUFFERS',
        signalBuffer: this.signalBuffer,
        resultBuffer: this.resultBuffer,
      } as any);
    }

    // Initialize the database
    await this.sendMessageAsync({ id: this.nextRequestId++, type: 'INIT' });

    this.initialized = true;
    console.log('[SQLiteStorage] Initialized');
  }

  /**
   * Send async message (for init and fallback)
   */
  private sendMessageAsync(message: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = message.id ?? this.nextRequestId++;
      this.pendingResolves.set(id, resolve);
      this.pendingRejects.set(id, reject);
      this.worker!.postMessage({ ...message, id });
    });
  }

  /**
   * Send synchronous message using Atomics.wait()
   */
  private callSync(type: string, payload?: any): any {
    if (!this.worker) {
      throw new Error('SQLiteStorage not initialized');
    }

    if (this.useAsyncFallback) {
      // This shouldn't happen in practice - sync methods shouldn't be called
      // if we're in async fallback mode
      throw new Error('Synchronous operations not available without SharedArrayBuffer');
    }

    const id = this.nextRequestId++;

    // Reset signal
    Atomics.store(this.signalView, 0, 0);

    // Send request
    this.worker.postMessage({ id, type, payload });

    // Wait for response (blocks until worker calls Atomics.notify)
    const waitResult = Atomics.wait(this.signalView, 0, 0, 30000); // 30s timeout

    if (waitResult === 'timed-out') {
      throw new Error(`SQLite operation timed out: ${type}`);
    }

    const responseId = Atomics.load(this.signalView, 0);
    const success = Atomics.load(this.signalView, 1) === 1;

    if (responseId !== id) {
      console.warn('[SQLiteStorage] Response ID mismatch:', responseId, 'expected:', id);
    }

    // Try to read result from shared buffer
    const dv = new DataView(this.resultBuffer);
    const resultLength = dv.getUint32(0);

    if (resultLength > 0 && resultLength < RESULT_BUFFER_SIZE - 4) {
      // Copy from SharedArrayBuffer into a plain ArrayBuffer for TextDecoder
      // (TextDecoder.decode rejects views backed by SharedArrayBuffer)
      const shared = this.resultView.subarray(4, 4 + resultLength);
      const resultBytes = new Uint8Array(shared.length);
      resultBytes.set(shared);
      const resultJson = new TextDecoder().decode(resultBytes);
      const result = JSON.parse(resultJson);

      if (!success && result.error) {
        throw new Error(result.error);
      }

      return result;
    }

    // Result too large or not available - throw for now
    // In practice, most results should fit in 64KB
    if (!success) {
      throw new Error('Operation failed (result not available)');
    }

    return { success: true };
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /**
   * Create cell ID string from DNA hash and agent pub key
   */
  private getCellId(dnaHash: Uint8Array, agentPubKey: Uint8Array): string {
    const dnaB64 = encodeHashToBase64(dnaHash);
    const agentB64 = encodeHashToBase64(agentPubKey);
    return `${dnaB64}:${agentB64}`;
  }

  /**
   * Convert hash to blob for storage
   */
  private hashToBlob(hash: Uint8Array): number[] {
    return Array.from(hash);
  }

  /**
   * Convert blob to hash
   */
  private blobToHash(blob: number[] | Uint8Array): Uint8Array {
    return new Uint8Array(blob);
  }

  /**
   * Compare two hashes for equality
   */
  private hashesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  // ============================================================================
  // Transaction Support
  // ============================================================================

  /**
   * Begin a transaction
   */
  beginTransaction(): void {
    this.callSync('BEGIN');
    console.log('[SQLiteStorage] Transaction started');
  }

  /**
   * Commit transaction - blocks until durably persisted
   */
  commitTransaction(): void {
    this.callSync('COMMIT');
    console.log('[SQLiteStorage] Transaction committed (durable)');
  }

  /**
   * Rollback transaction
   */
  rollbackTransaction(): void {
    this.callSync('ROLLBACK');
    console.log('[SQLiteStorage] Transaction rolled back');
  }

  /**
   * Check if transaction is active (simplified - always false after commit/rollback)
   */
  isTransactionActive(): boolean {
    // SQLite doesn't have a direct way to check this
    // In practice, we track this in the caller
    return false;
  }

  // ============================================================================
  // Chain Head Operations
  // ============================================================================

  /**
   * Get current chain head for a cell (SYNCHRONOUS)
   */
  getChainHead(dnaHash: Uint8Array, agentPubKey: Uint8Array): ChainHead | null {
    const cellId = this.getCellId(dnaHash, agentPubKey);

    const result = this.callSync('QUERY', {
      sql: STATEMENTS.GET_CHAIN_HEAD,
      params: [cellId],
    });

    if (!result || result.length === 0) {
      return null;
    }

    const row = result[0];
    return {
      cellId: row.cell_id,
      actionSeq: row.action_seq,
      actionHash: this.blobToHash(row.action_hash),
      timestamp: BigInt(row.timestamp),
    };
  }

  /**
   * Update chain head (SYNCHRONOUS)
   */
  updateChainHead(
    dnaHash: Uint8Array,
    agentPubKey: Uint8Array,
    actionSeq: number,
    actionHash: Uint8Array,
    timestamp: bigint
  ): void {
    const cellId = this.getCellId(dnaHash, agentPubKey);

    this.callSync('EXEC', {
      sql: STATEMENTS.SET_CHAIN_HEAD,
      params: [cellId, actionSeq, this.hashToBlob(actionHash), timestamp.toString()],
    });
  }

  // ============================================================================
  // Action Operations
  // ============================================================================

  /**
   * Store an action (SYNCHRONOUS)
   */
  putAction(action: Action, dnaHash: Uint8Array, agentPubKey: Uint8Array): void {
    const cellId = this.getCellId(dnaHash, agentPubKey);

    // Build params array matching INSERT_ACTION column order
    const params = [
      this.hashToBlob(action.actionHash),
      cellId,
      action.actionSeq,
      this.hashToBlob(action.author),
      action.timestamp.toString(),
      action.prevActionHash ? this.hashToBlob(action.prevActionHash) : null,
      action.actionType,
      this.hashToBlob(action.signature),
      // Entry fields
      'entryHash' in action ? this.hashToBlob((action as CreateAction).entryHash) : null,
      'entryType' in action ? (action as CreateAction).entryType : null,
      // Update fields
      'originalActionHash' in action ? this.hashToBlob((action as UpdateAction).originalActionHash) : null,
      'originalEntryHash' in action ? this.hashToBlob((action as UpdateAction).originalEntryHash) : null,
      // Delete fields
      'deletesActionHash' in action ? this.hashToBlob((action as DeleteAction).deletesActionHash) : null,
      'deletesEntryHash' in action ? this.hashToBlob((action as DeleteAction).deletesEntryHash) : null,
      // Link fields
      'baseAddress' in action ? this.hashToBlob((action as any).baseAddress) : null,
      'targetAddress' in action ? this.hashToBlob((action as any).targetAddress) : null,
      'zomeIndex' in action ? (action as any).zomeIndex : null,
      'linkType' in action ? (action as any).linkType : null,
      'tag' in action ? this.hashToBlob((action as any).tag) : null,
      // DeleteLink fields
      'linkAddAddress' in action ? this.hashToBlob((action as any).linkAddAddress) : null,
      // Dna fields
      'dnaHash' in action && action.actionType === 'Dna' ? this.hashToBlob((action as any).dnaHash) : null,
      // AgentValidationPkg fields
      'membraneProof' in action ? this.hashToBlob((action as any).membraneProof) : null,
    ];

    this.callSync('EXEC', {
      sql: STATEMENTS.INSERT_ACTION,
      params,
    });
  }

  /**
   * Get action by hash (SYNCHRONOUS)
   */
  getAction(actionHash: Uint8Array): Action | null {
    const result = this.callSync('QUERY', {
      sql: STATEMENTS.GET_ACTION,
      params: [this.hashToBlob(actionHash)],
    });

    if (!result || result.length === 0) {
      return null;
    }

    return this.rowToAction(result[0]);
  }

  /**
   * Query actions by cell (SYNCHRONOUS)
   */
  queryActions(
    dnaHash: Uint8Array,
    agentPubKey: Uint8Array,
    filter?: { actionType?: string }
  ): Action[] {
    const cellId = this.getCellId(dnaHash, agentPubKey);

    let sql: string = STATEMENTS.GET_ACTIONS_BY_CELL;
    let params: any[] = [cellId];

    if (filter?.actionType) {
      sql = STATEMENTS.GET_ACTIONS_BY_CELL_TYPE;
      params = [cellId, filter.actionType];
    }

    const result = this.callSync('QUERY', { sql, params });

    if (!result || result.length === 0) {
      return [];
    }

    return result.map((row: any) => this.rowToAction(row));
  }

  /**
   * Query actions from cache (same as queryActions for SQLite - no separate cache)
   */
  queryActionsFromCache(
    dnaHash: Uint8Array,
    agentPubKey: Uint8Array,
    filter?: { actionType?: string }
  ): Action[] | null {
    // With SQLite, we don't have a separate cache - just query directly
    return this.queryActions(dnaHash, agentPubKey, filter);
  }

  /**
   * Find action by entry hash
   */
  getActionByEntryHash(entryHash: Uint8Array): Action | null {
    const result = this.callSync('QUERY', {
      sql: STATEMENTS.GET_ACTIONS_BY_ENTRY_HASH,
      params: [this.hashToBlob(entryHash)],
    });

    if (!result || result.length === 0) {
      return null;
    }

    return this.rowToAction(result[0]);
  }

  /**
   * Convert database row to Action type
   */
  private rowToAction(row: any): Action {
    const base = {
      actionHash: this.blobToHash(row.action_hash),
      actionSeq: row.action_seq,
      author: this.blobToHash(row.author),
      timestamp: BigInt(row.timestamp),
      prevActionHash: row.prev_action_hash ? this.blobToHash(row.prev_action_hash) : null,
      actionType: row.action_type,
      signature: this.blobToHash(row.signature),
    };

    switch (row.action_type) {
      case 'Create':
        return {
          ...base,
          actionType: 'Create',
          entryHash: this.blobToHash(row.entry_hash),
          entryType: row.entry_type,
        } as CreateAction;

      case 'Update':
        return {
          ...base,
          actionType: 'Update',
          entryHash: this.blobToHash(row.entry_hash),
          entryType: row.entry_type,
          originalActionHash: this.blobToHash(row.original_action_hash),
          originalEntryHash: this.blobToHash(row.original_entry_hash),
        } as UpdateAction;

      case 'Delete':
        return {
          ...base,
          actionType: 'Delete',
          deletesActionHash: this.blobToHash(row.deletes_action_hash),
          deletesEntryHash: this.blobToHash(row.deletes_entry_hash),
        } as DeleteAction;

      case 'CreateLink':
        return {
          ...base,
          actionType: 'CreateLink',
          baseAddress: this.blobToHash(row.base_address),
          targetAddress: this.blobToHash(row.target_address),
          zomeIndex: row.zome_index,
          linkType: row.link_type,
          tag: this.blobToHash(row.tag),
        } as any;

      case 'DeleteLink':
        return {
          ...base,
          actionType: 'DeleteLink',
          linkAddAddress: this.blobToHash(row.link_add_address),
          baseAddress: this.blobToHash(row.base_address),
        } as any;

      case 'Dna':
        return {
          ...base,
          actionType: 'Dna',
          dnaHash: this.blobToHash(row.dna_hash),
        } as any;

      case 'AgentValidationPkg':
        return {
          ...base,
          actionType: 'AgentValidationPkg',
          membraneProof: row.membrane_proof ? this.blobToHash(row.membrane_proof) : undefined,
        } as any;

      case 'InitZomesComplete':
        return {
          ...base,
          actionType: 'InitZomesComplete',
        } as any;

      default:
        return base as Action;
    }
  }

  // ============================================================================
  // Entry Operations
  // ============================================================================

  /**
   * Store an entry (SYNCHRONOUS)
   */
  putEntry(entry: StoredEntry, dnaHash: Uint8Array, agentPubKey: Uint8Array): void {
    const cellId = this.getCellId(dnaHash, agentPubKey);

    this.callSync('EXEC', {
      sql: STATEMENTS.INSERT_ENTRY,
      params: [
        this.hashToBlob(entry.entryHash),
        cellId,
        this.hashToBlob(entry.entryContent),
        entry.entryType,
      ],
    });
  }

  /**
   * Get entry by hash (SYNCHRONOUS)
   */
  getEntry(entryHash: Uint8Array): StoredEntry | null {
    const result = this.callSync('QUERY', {
      sql: STATEMENTS.GET_ENTRY,
      params: [this.hashToBlob(entryHash)],
    });

    if (!result || result.length === 0) {
      return null;
    }

    const row = result[0];
    return {
      entryHash: this.blobToHash(row.entry_hash),
      entryContent: this.blobToHash(row.entry_content),
      entryType: row.entry_type,
    };
  }

  // ============================================================================
  // Record Operations
  // ============================================================================

  /**
   * Get full record (action + entry) by action hash (SYNCHRONOUS)
   */
  getRecord(actionHash: Uint8Array): StoredRecord | null {
    const action = this.getAction(actionHash);
    if (!action) return null;

    let entry: StoredEntry | undefined;

    if ('entryHash' in action && action.entryHash) {
      entry = this.getEntry((action as CreateAction).entryHash) || undefined;
    }

    return {
      actionHash,
      action,
      entry,
    };
  }

  /**
   * Get details for an entry (SYNCHRONOUS)
   */
  getDetails(
    entryHash: Uint8Array,
    dnaHash: Uint8Array,
    agentPubKey: Uint8Array
  ): RecordDetails | null {
    console.log('[SQLiteStorage.getDetails] Looking up entry', {
      entryHash: Array.from(entryHash.slice(0, 8)),
    });

    const allActions = this.queryActions(dnaHash, agentPubKey);
    console.log('[SQLiteStorage.getDetails] Found actions count:', allActions.length);

    // Find action that created/updated this entry
    let originatingAction = allActions.find(
      a => a.actionType === 'Create' &&
           'entryHash' in a &&
           this.hashesEqual((a as CreateAction).entryHash, entryHash)
    ) as CreateAction | UpdateAction | undefined;

    if (originatingAction) {
      console.log('[SQLiteStorage.getDetails] Found Create action', {
        actionHash: Array.from(originatingAction.actionHash.slice(0, 8)),
      });
    }

    if (!originatingAction) {
      originatingAction = allActions.find(
        a => a.actionType === 'Update' &&
             'entryHash' in a &&
             this.hashesEqual((a as UpdateAction).entryHash, entryHash)
      ) as UpdateAction | undefined;

      if (originatingAction) {
        console.log('[SQLiteStorage.getDetails] Found Update action', {
          actionHash: Array.from(originatingAction.actionHash.slice(0, 8)),
        });
      }
    }

    if (!originatingAction) {
      console.log('[SQLiteStorage.getDetails] No originating action found for entryHash');
      // Log all Create/Update actions to see what we have
      allActions.filter(a => a.actionType === 'Create' || a.actionType === 'Update').forEach(a => {
        if ('entryHash' in a) {
          console.log('[SQLiteStorage.getDetails] Existing action:', {
            type: a.actionType,
            entryHash: Array.from((a as CreateAction).entryHash.slice(0, 8)),
          });
        }
      });
      return null;
    }

    const entry = this.getEntry(entryHash);
    if (!entry) {
      console.log('[SQLiteStorage.getDetails] Entry not found in storage');
      return null;
    }

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
        actionHash: originatingAction.actionHash,
        action: originatingAction,
        entry,
      },
      validationStatus: 'Valid',
      deletes,
      updates,
    };
  }

  /**
   * Get details from cache (same as getDetails for SQLite)
   */
  getDetailsFromCache(
    entryHash: Uint8Array,
    dnaHash: Uint8Array,
    agentPubKey: Uint8Array
  ): RecordDetails | null {
    return this.getDetails(entryHash, dnaHash, agentPubKey);
  }

  // ============================================================================
  // Link Operations
  // ============================================================================

  /**
   * Store a link (SYNCHRONOUS)
   */
  putLink(link: Link, dnaHash: Uint8Array, agentPubKey: Uint8Array): void {
    const cellId = this.getCellId(dnaHash, agentPubKey);

    this.callSync('EXEC', {
      sql: STATEMENTS.INSERT_LINK,
      params: [
        this.hashToBlob(link.createLinkHash),
        cellId,
        this.hashToBlob(link.baseAddress),
        this.hashToBlob(link.targetAddress),
        link.timestamp.toString(),
        link.zomeIndex,
        link.linkType,
        this.hashToBlob(link.tag),
        this.hashToBlob(link.author),
        link.deleted ? 1 : 0,
        link.deleteHash ? this.hashToBlob(link.deleteHash) : null,
      ],
    });
  }

  /**
   * Get links by base address (SYNCHRONOUS)
   */
  getLinks(
    baseAddress: Uint8Array,
    dnaHash: Uint8Array,
    agentPubKey: Uint8Array,
    linkType?: number
  ): Link[] {
    const cellId = this.getCellId(dnaHash, agentPubKey);

    let sql: string = STATEMENTS.GET_LINKS_BY_BASE;
    let params: any[] = [cellId, this.hashToBlob(baseAddress)];

    if (linkType !== undefined) {
      sql = STATEMENTS.GET_LINKS_BY_BASE_TYPE;
      params = [cellId, this.hashToBlob(baseAddress), linkType];
    }

    const result = this.callSync('QUERY', { sql, params });

    if (!result || result.length === 0) {
      return [];
    }

    return result.map((row: any) => ({
      createLinkHash: this.blobToHash(row.create_link_hash),
      baseAddress: this.blobToHash(row.base_address),
      targetAddress: this.blobToHash(row.target_address),
      timestamp: BigInt(row.timestamp),
      zomeIndex: row.zome_index,
      linkType: row.link_type,
      tag: this.blobToHash(row.tag),
      author: this.blobToHash(row.author),
      deleted: row.deleted === 1,
      deleteHash: row.delete_hash ? this.blobToHash(row.delete_hash) : undefined,
    }));
  }

  /**
   * Delete a link (SYNCHRONOUS)
   */
  deleteLink(createLinkHash: Uint8Array, deleteHash: Uint8Array): void {
    this.callSync('EXEC', {
      sql: STATEMENTS.DELETE_LINK,
      params: [this.hashToBlob(deleteHash), this.hashToBlob(createLinkHash)],
    });
  }

  // ============================================================================
  // No-op Methods (compatibility with SourceChainStorage interface)
  // ============================================================================

  /**
   * Pre-load is a no-op for SQLite (data is always queried on demand)
   */
  async preloadChainForCell(_dnaHash: Uint8Array, _agentPubKey: Uint8Array): Promise<void> {
    // No-op - SQLite queries on demand, no pre-loading needed
    console.log('[SQLiteStorage] preloadChainForCell called (no-op)');
  }

  /**
   * Clear all data (for testing)
   */
  clear(): void {
    this.callSync('EXEC', { sql: STATEMENTS.CLEAR_ACTIONS });
    this.callSync('EXEC', { sql: STATEMENTS.CLEAR_ENTRIES });
    this.callSync('EXEC', { sql: STATEMENTS.CLEAR_LINKS });
    this.callSync('EXEC', { sql: STATEMENTS.CLEAR_CHAIN_HEADS });
    console.log('[SQLiteStorage] All data cleared');
  }

  /**
   * Close the database connection
   */
  async close(): Promise<void> {
    if (this.worker) {
      await this.sendMessageAsync({ id: this.nextRequestId++, type: 'CLOSE' });
      this.worker.terminate();
      this.worker = null;
      this.initialized = false;
      console.log('[SQLiteStorage] Closed');
    }
  }
}
