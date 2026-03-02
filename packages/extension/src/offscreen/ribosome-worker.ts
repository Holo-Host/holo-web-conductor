/**
 * Ribosome Worker
 *
 * Dedicated worker that runs WASM + SQLite together for synchronous storage access.
 * Network calls are proxied back to the offscreen document which can do sync XHR.
 *
 * Architecture:
 * - WASM execution happens here (callZome)
 * - SQLite runs directly in this worker (synchronous OPFS access)
 * - Network requests use Atomics.wait to block while offscreen does sync XHR
 */

// ============================================================================
// Worker Log Filter
// ============================================================================
// Control logging via SET_LOG_FILTER message from offscreen
// Filter: '*' = all, '' = none, 'Ribosome,PERF' = only matching prefixes

let workerLogFilter = '*'; // Default: show all

// Save original console methods
const originalConsoleLog = console.log.bind(console);
const originalConsoleWarn = console.warn.bind(console);
const originalConsoleError = console.error.bind(console);

function shouldWorkerLog(args: any[]): boolean {
  if (workerLogFilter === '*') return true;
  if (workerLogFilter === '') return false;

  // Check if first arg is a string with a bracket prefix like [Ribosome]
  const firstArg = args[0];
  if (typeof firstArg === 'string') {
    const match = firstArg.match(/^\[([^\]]+)\]/);
    if (match) {
      const prefix = match[1].toLowerCase();
      const allowed = workerLogFilter.toLowerCase().split(',').map(p => p.trim());
      return allowed.some(a => prefix.includes(a) || a.includes(prefix));
    }
    // Also check for emoji prefixes like "⏱️ [PERF]"
    const perfMatch = firstArg.match(/\[PERF\]/i);
    if (perfMatch) {
      const allowed = workerLogFilter.toLowerCase().split(',').map(p => p.trim());
      return allowed.some(a => a.includes('perf'));
    }
  }
  return true; // Allow logs without recognized prefix
}

// Override console.log to filter
console.log = (...args: any[]) => {
  if (shouldWorkerLog(args)) {
    originalConsoleLog(...args);
  }
};

// Warnings and errors always show (like the main logger)
// console.warn and console.error are kept as-is

// Polyfill document for sqlite-wasm which tries to access it during module init in workers
if (typeof document === 'undefined') {
  const workerUrl = (self as any).location?.href || 'chrome-extension://placeholder/offscreen/ribosome-worker.js';
  const extensionRoot = workerUrl.replace(/\/offscreen\/ribosome-worker\.js.*$/, '/');
  (self as any).document = {
    currentScript: { src: workerUrl, tagName: 'SCRIPT' },
    baseURI: extensionRoot,
    querySelector: () => null,
    createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
    head: { appendChild: () => {} },
    body: { appendChild: () => {} },
  };
}

import { callZome, type ZomeCallRequest } from '@hwc/core/ribosome';
import { encode, decode } from '@msgpack/msgpack';
import { SCHEMA_SQL } from '@hwc/core/storage/sqlite-schema';
import { setStorageProvider, type StorageProvider } from '@hwc/core/storage';
import { setNetworkService, type NetworkService, type NetworkRecord, type NetworkEntry, type NetworkLink, type AgentActivityResponse, type MustGetAgentActivityResponse } from '@hwc/core/network';
import { setLairClient } from '@hwc/core/signing';
import type { ILairClient, Ed25519PubKey, Ed25519Signature, NewSeedResult } from '@holo-host/lair';
import { recoverChainFromDHT, storeRecoveredRecords } from '@hwc/core/recovery';
import { isEntryAction, type Action, type StoredEntry, type StoredRecord, type ChainHead, type Link, type RecordDetails, type EntryDetails, type EntryDhtStatus, type CreateAction, type UpdateAction, type DeleteAction } from '@hwc/core/storage/types';
import { encodeHashToBase64, type ActionHash, type EntryHash, type DnaHash, type AgentPubKey, type AnyDhtHash } from '@holochain/client';

// Types
interface WorkerMessage {
  id: number;
  type: 'INIT' | 'CALL_ZOME' | 'CONFIGURE_NETWORK' | 'RECOVER_CHAIN' | 'RUN_GENESIS';
  payload?: any;
}

interface NetworkRequest {
  id: number;
  type: 'NETWORK_FETCH';
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
}

// SQLite instance
let db: any = null;
let sqlite3: any = null;

// SharedArrayBuffer for network synchronization
let networkSignalBuffer: SharedArrayBuffer | null = null;
let networkSignalView: Int32Array | null = null;
let networkResultBuffer: SharedArrayBuffer | null = null;
let networkResultView: Uint8Array | null = null;

// SharedArrayBuffer for signing synchronization
// Signal: Int32Array[0] = status (0=waiting, 1=complete)
// Result: Uint8Array with signature (64 bytes) or error message
const SIGN_RESULT_SIZE = 1024; // Room for 64-byte signature or error message
let signSignalBuffer: SharedArrayBuffer | null = null;
let signSignalView: Int32Array | null = null;
let signResultBuffer: SharedArrayBuffer | null = null;
let signResultView: Uint8Array | null = null;

// Network configuration
let linkerUrl: string = '';
let sessionToken: string | null = null;

// Request ID counter
let nextNetworkRequestId = 1;

// WASM cache - avoid re-sending 1.3MB on every call
// Key: base64-encoded DNA hash, Value: Uint8Array of WASM
const wasmCache = new Map<string, Uint8Array>();

function getWasmCacheKey(dnaHash: DnaHash | number[]): string {
  const bytes = Array.isArray(dnaHash) ? dnaHash : Array.from(dnaHash);
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Initialize SQLite with OPFS using opfs-sahpool VFS
 *
 * We use opfs-sahpool instead of opfs because:
 * - opfs VFS requires spawning a nested worker (fails in extension context)
 * - opfs-sahpool uses FileSystemSyncAccessHandle directly (works in dedicated workers)
 */
async function initSQLite(): Promise<void> {
  console.log('[Ribosome Worker] Initializing SQLite...');

  const module = await import('@sqlite.org/sqlite-wasm');
  const sqlite3InitModule = module.default;

  sqlite3 = await sqlite3InitModule({
    print: (...args: any[]) => console.log('[SQLite]', ...args),
    printErr: (...args: any[]) => console.error('[SQLite Error]', ...args),
  });

  console.log('[Ribosome Worker] SQLite loaded, version:', sqlite3.version.libVersion);

  // Check available VFS options
  const vfsList = sqlite3.capi.sqlite3_js_vfs_list();
  console.log('[Ribosome Worker] Available VFS:', vfsList);

  // Try to install and use opfs-sahpool for synchronous OPFS access
  // This doesn't require spawning a nested worker like the regular opfs VFS
  let dbPath = ':memory:';
  let usingOpfs = false;

  try {
    // Install opfs-sahpool VFS if available
    if (sqlite3.installOpfsSAHPoolVfs) {
      console.log('[Ribosome Worker] Installing opfs-sahpool VFS...');
      const poolUtil = await sqlite3.installOpfsSAHPoolVfs({
        name: 'opfs-sahpool',
        directory: '/hwc-data',  // OPFS directory for our files
        initialCapacity: 10,  // Pre-allocate 10 file handles
      });

      console.log('[Ribosome Worker] opfs-sahpool installed, opening database...');
      db = new poolUtil.OpfsSAHPoolDb('/hwc-chain.sqlite3');
      dbPath = '/hwc-chain.sqlite3';
      usingOpfs = true;
    }
  } catch (e) {
    console.warn('[Ribosome Worker] Failed to install opfs-sahpool:', e);
  }

  // Fallback to in-memory if OPFS failed
  if (!usingOpfs) {
    console.warn('[Ribosome Worker] OPFS not available, using in-memory database (data will not persist)');
    db = new sqlite3.oo1.DB(':memory:');
  }

  console.log('[Ribosome Worker] Database opened:', dbPath, usingOpfs ? '(OPFS persistent)' : '(in-memory)');

  // Create schema
  db.exec(SCHEMA_SQL);
  console.log('[Ribosome Worker] Schema created');

  // WAL mode is not supported with opfs-sahpool, skip for OPFS
  if (!usingOpfs) {
    try {
      db.exec('PRAGMA journal_mode=WAL');
      console.log('[Ribosome Worker] WAL mode enabled');
    } catch (e) {
      console.log('[Ribosome Worker] WAL mode not available');
    }
  }
}

/**
 * SQLite Storage implementation that runs directly in the worker
 * Implements StorageProvider interface for full compatibility with ribosome
 */
class DirectSQLiteStorage implements StorageProvider {
  private currentCellId: string = '';
  private inTransaction: boolean = false;

  private getCellId(dnaHash: DnaHash, agentPubKey: AgentPubKey): string {
    const dnaB64 = btoa(String.fromCharCode(...toBytes(dnaHash)!));
    const agentB64 = btoa(String.fromCharCode(...toBytes(agentPubKey)!));
    return `${dnaB64}:${agentB64}`;
  }

  // Used to set context before zome call
  setCellContext(dnaHash: DnaHash, agentPubKey: AgentPubKey): void {
    this.currentCellId = this.getCellId(dnaHash, agentPubKey);
  }

  // StorageProvider interface implementation
  async init(): Promise<void> {
    // SQLite is initialized separately in initSQLite()
    // Nothing to do here
  }

  beginTransaction(): void {
    db.exec('BEGIN TRANSACTION');
    this.inTransaction = true;
  }

  commitTransaction(): void {
    db.exec('COMMIT');
    this.inTransaction = false;
  }

  rollbackTransaction(): void {
    db.exec('ROLLBACK');
    this.inTransaction = false;
  }

  isTransactionActive(): boolean {
    return this.inTransaction;
  }

  getChainHead(dnaHash: DnaHash, agentPubKey: AgentPubKey): ChainHead | null {
    const cellId = this.getCellId(dnaHash, agentPubKey);
    const stmt = db.prepare('SELECT action_seq, action_hash, timestamp FROM chain_heads WHERE cell_id = ?');
    try {
      stmt.bind([cellId]);
      if (stmt.step()) {
        const row = stmt.get({});
        return {
          cellId,
          actionSeq: row.action_seq,
          actionHash: new Uint8Array(row.action_hash),
          timestamp: BigInt(row.timestamp),
        };
      }
      return null;
    } finally {
      stmt.finalize();
    }
  }

  updateChainHead(dnaHash: DnaHash, agentPubKey: AgentPubKey, actionSeq: number, actionHash: ActionHash, timestamp: bigint): void {
    const cellId = this.getCellId(dnaHash, agentPubKey);
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO chain_heads (cell_id, action_seq, action_hash, timestamp)
      VALUES (?, ?, ?, ?)
    `);
    try {
      stmt.bind([cellId, actionSeq, toBytes(actionHash), timestamp.toString()]);
      stmt.step();
    } finally {
      stmt.finalize();
    }
  }

  putAction(action: any, dnaHash: DnaHash, agentPubKey: AgentPubKey): void {
    const cellId = this.getCellId(dnaHash, agentPubKey);
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO actions (
        action_hash, cell_id, action_seq, author, timestamp, prev_action_hash,
        action_type, signature, entry_hash, entry_type,
        original_action_hash, original_entry_hash, deletes_action_hash, deletes_entry_hash,
        base_address, target_address, zome_index, link_type, tag, link_add_address,
        dna_hash, membrane_proof
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    try {
      stmt.bind([
        toBytes(action.actionHash),
        cellId,
        action.actionSeq,
        toBytes(action.author),
        action.timestamp.toString(),
        toBytes(action.prevActionHash),
        action.actionType,
        toBytes(action.signature),
        toBytes(action.entryHash),
        action.entryType ? JSON.stringify(action.entryType) : null,
        toBytes(action.originalActionHash),
        toBytes(action.originalEntryHash),
        toBytes(action.deletesActionHash),
        toBytes(action.deletesEntryHash),
        toBytes(action.baseAddress),
        toBytes(action.targetAddress),
        action.zomeIndex ?? null,
        action.linkType ?? null,
        toBytes(action.tag),
        toBytes(action.linkAddAddress),
        toBytes(action.dnaHash),
        toBytes(action.membraneProof),
      ]);
      stmt.step();
    } finally {
      stmt.finalize();
    }
  }

  getAction(actionHash: ActionHash): Action | null {
    const stmt = db.prepare('SELECT * FROM actions WHERE action_hash = ?');
    try {
      stmt.bind([toBytes(actionHash)]);
      if (stmt.step()) {
        return this.rowToAction(stmt.get({}));
      }
      return null;
    } finally {
      stmt.finalize();
    }
  }

  queryActions(dnaHash: DnaHash, agentPubKey: AgentPubKey, filter?: { actionType?: string }): Action[] {
    const cellId = this.getCellId(dnaHash, agentPubKey);
    const results: Action[] = [];

    let sql = 'SELECT * FROM actions WHERE cell_id = ?';
    const params: any[] = [cellId];

    if (filter?.actionType) {
      sql += ' AND action_type = ?';
      params.push(filter.actionType);
    }

    sql += ' ORDER BY action_seq';

    const stmt = db.prepare(sql);
    try {
      stmt.bind(params);
      while (stmt.step()) {
        results.push(this.rowToAction(stmt.get({})));
      }
    } finally {
      stmt.finalize();
    }
    return results;
  }

  /**
   * Get all records (actions + entries) for a cell
   * Used for republishing all data to the DHT
   */
  getAllRecords(dnaHash: DnaHash, agentPubKey: AgentPubKey): Array<{ action: Action; entry: StoredEntry | null }> {
    const cellId = this.getCellId(dnaHash, agentPubKey);
    const records: Array<{ action: Action; entry: StoredEntry | null }> = [];

    // Get all actions for this cell, ordered by sequence
    const stmt = db.prepare('SELECT * FROM actions WHERE cell_id = ? ORDER BY action_seq');
    try {
      stmt.bind([cellId]);
      while (stmt.step()) {
        const action = this.rowToAction(stmt.get({}));

        // Get entry if this action has one
        let entry: StoredEntry | null = null;
        if (isEntryAction(action)) {
          entry = this.getEntry(action.entryHash);
        }

        records.push({ action, entry });
      }
    } finally {
      stmt.finalize();
    }

    return records;
  }

  getActionByEntryHash(entryHash: EntryHash): Action | null {
    const stmt = db.prepare('SELECT * FROM actions WHERE entry_hash = ? ORDER BY action_seq ASC LIMIT 1');
    try {
      stmt.bind([toBytes(entryHash)]);
      if (stmt.step()) {
        return this.rowToAction(stmt.get({}));
      }
      return null;
    } finally {
      stmt.finalize();
    }
  }

  putEntry(entry: { entryHash: EntryHash; entryContent: Uint8Array; entryType: any }, dnaHash: DnaHash, agentPubKey: AgentPubKey): void {
    const cellId = this.getCellId(dnaHash, agentPubKey);
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO entries (entry_hash, cell_id, entry_content, entry_type)
      VALUES (?, ?, ?, ?)
    `);
    try {
      // entryType can be a string ('Agent') or object ({zome_id, entry_index})
      const entryTypeStr = typeof entry.entryType === 'string'
        ? entry.entryType
        : JSON.stringify(entry.entryType);
      stmt.bind([toBytes(entry.entryHash), cellId, toBytes(entry.entryContent), entryTypeStr]);
      stmt.step();
    } finally {
      stmt.finalize();
    }
  }

  getEntry(entryHash: EntryHash): { entryHash: EntryHash; entryContent: Uint8Array; entryType: any } | null {
    const stmt = db.prepare('SELECT entry_hash, entry_content, entry_type FROM entries WHERE entry_hash = ?');
    try {
      stmt.bind([toBytes(entryHash)]);
      if (stmt.step()) {
        const row = stmt.get({});
        // Parse entryType - could be string or JSON object
        let entryType: any = row.entry_type;
        if (entryType && entryType.startsWith('{')) {
          try {
            entryType = JSON.parse(entryType);
          } catch {
            // Keep as string if not valid JSON
          }
        }
        return {
          entryHash: new Uint8Array(row.entry_hash),
          entryContent: new Uint8Array(row.entry_content),
          entryType,
        };
      }
      return null;
    } finally {
      stmt.finalize();
    }
  }

  getRecord(actionHash: ActionHash): StoredRecord | null {
    const action = this.getAction(actionHash);
    if (!action) return null;

    let entry = null;
    if (isEntryAction(action)) {
      entry = this.getEntry(action.entryHash);
    }

    return { actionHash, action, entry: entry ?? undefined } as StoredRecord;
  }

  getDetails(entryHash: EntryHash, dnaHash: DnaHash, agentPubKey: AgentPubKey): RecordDetails | null {
    // Get all actions that reference this entry hash
    const cellId = this.getCellId(dnaHash, agentPubKey);
    let originatingAction: Action | null = null;
    const updateActions: Array<{ updateHash: Uint8Array; updateAction: UpdateAction }> = [];
    const deleteActions: Array<{ deleteHash: Uint8Array; deleteAction: DeleteAction }> = [];

    // Find creates and updates that have this entry hash
    const stmt = db.prepare('SELECT * FROM actions WHERE cell_id = ? AND entry_hash = ?');
    try {
      stmt.bind([cellId, toBytes(entryHash)]);
      while (stmt.step()) {
        const action = this.rowToAction(stmt.get({}));
        if (action.actionType === 'Create') {
          // First Create action is the originating action
          if (!originatingAction) {
            originatingAction = action;
          }
        } else if (action.actionType === 'Update') {
          // If no Create found yet, an Update that created this entry is the originator
          if (!originatingAction) {
            originatingAction = action;
          }
        }
      }
    } finally {
      stmt.finalize();
    }

    if (!originatingAction) {
      console.log('[SQLiteStorage.getDetails] No originating action found for entryHash');
      return null;
    }

    const entry = this.getEntry(entryHash);
    if (!entry) {
      console.log('[SQLiteStorage.getDetails] Entry not found in storage');
      return null;
    }

    // Find updates that reference this entry's ORIGINAL entry hash
    const updateStmt = db.prepare('SELECT * FROM actions WHERE cell_id = ? AND action_type = ? AND original_entry_hash = ?');
    try {
      updateStmt.bind([cellId, 'Update', toBytes(entryHash)]);
      while (updateStmt.step()) {
        const action = this.rowToAction(updateStmt.get({}));
        if (action.actionType === 'Update') {
          updateActions.push({
            updateHash: action.actionHash,
            updateAction: action,
          });
        }
      }
    } finally {
      updateStmt.finalize();
    }

    // Find deletes that target this entry
    const deleteStmt = db.prepare('SELECT * FROM actions WHERE cell_id = ? AND action_type = ? AND deletes_entry_hash = ?');
    try {
      deleteStmt.bind([cellId, 'Delete', toBytes(entryHash)]);
      while (deleteStmt.step()) {
        const action = this.rowToAction(deleteStmt.get({}));
        if (action.actionType === 'Delete') {
          deleteActions.push({
            deleteHash: action.actionHash,
            deleteAction: action,
          });
        }
      }
    } finally {
      deleteStmt.finalize();
    }

    // Return RecordDetails shape expected by get_details.ts
    return {
      record: {
        actionHash: originatingAction.actionHash,
        action: originatingAction,
        entry,
      },
      validationStatus: 'Valid',
      updates: updateActions,
      deletes: deleteActions,
    };
  }

  getEntryDetails(entryHash: EntryHash, dnaHash: DnaHash, agentPubKey: AgentPubKey): EntryDetails | null {
    const cellId = this.getCellId(dnaHash, agentPubKey);

    // Get the entry itself
    const entry = this.getEntry(entryHash);
    if (!entry) {
      console.log('[SQLiteStorage.getEntryDetails] Entry not found for hash');
      return null;
    }

    // Find all Create/Update actions that produced this entry hash
    const actions: Array<{ actionHash: ActionHash; action: CreateAction | UpdateAction }> = [];
    const stmt = db.prepare('SELECT * FROM actions WHERE cell_id = ? AND entry_hash = ?');
    try {
      stmt.bind([cellId, toBytes(entryHash)]);
      while (stmt.step()) {
        const action = this.rowToAction(stmt.get({}));
        if (action.actionType === 'Create' || action.actionType === 'Update') {
          actions.push({ actionHash: action.actionHash, action });
        }
      }
    } finally {
      stmt.finalize();
    }

    // Find updates that have originalEntryHash pointing to this entry
    const updates: Array<{ updateHash: ActionHash; updateAction: UpdateAction }> = [];
    const updateStmt = db.prepare('SELECT * FROM actions WHERE cell_id = ? AND action_type = ? AND original_entry_hash = ?');
    try {
      updateStmt.bind([cellId, 'Update', toBytes(entryHash)]);
      while (updateStmt.step()) {
        const action = this.rowToAction(updateStmt.get({}));
        if (action.actionType === 'Update') {
          updates.push({ updateHash: action.actionHash, updateAction: action });
        }
      }
    } finally {
      updateStmt.finalize();
    }

    // Find deletes targeting this entry
    const deletes: Array<{ deleteHash: ActionHash; deleteAction: DeleteAction }> = [];
    const deleteStmt = db.prepare('SELECT * FROM actions WHERE cell_id = ? AND action_type = ? AND deletes_entry_hash = ?');
    try {
      deleteStmt.bind([cellId, 'Delete', toBytes(entryHash)]);
      while (deleteStmt.step()) {
        const action = this.rowToAction(deleteStmt.get({}));
        if (action.actionType === 'Delete') {
          deletes.push({ deleteHash: action.actionHash, deleteAction: action });
        }
      }
    } finally {
      deleteStmt.finalize();
    }

    // Determine entry DHT status
    // Live if there are no deletes, Dead if there are deletes
    const entryDhtStatus: EntryDhtStatus = deletes.length > 0 ? 'Dead' : 'Live';

    console.log('[SQLiteStorage.getEntryDetails] Found entry details', {
      actionsCount: actions.length,
      updatesCount: updates.length,
      deletesCount: deletes.length,
      status: entryDhtStatus,
    });

    return {
      entry,
      actions,
      rejectedActions: [], // We don't track rejection in this implementation
      deletes,
      updates,
      entryDhtStatus,
    };
  }

  putLink(link: any, dnaHash: DnaHash, agentPubKey: AgentPubKey): void {
    const cellId = this.getCellId(dnaHash, agentPubKey);
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO links (
        create_link_hash, cell_id, base_address, target_address, timestamp,
        zome_index, link_type, tag, author, deleted, delete_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    try {
      stmt.bind([
        toBytes(link.createLinkHash),
        cellId,
        toBytes(link.baseAddress),
        toBytes(link.targetAddress),
        link.timestamp.toString(),
        link.zomeIndex,
        link.linkType,
        toBytes(link.tag),
        toBytes(link.author),
        0,
        null,
      ]);
      stmt.step();
    } finally {
      stmt.finalize();
    }
  }

  getLinks(baseAddress: AnyDhtHash, dnaHash: DnaHash, agentPubKey: AgentPubKey, linkType?: number): Link[] {
    const cellId = this.getCellId(dnaHash, agentPubKey);
    const results: Link[] = [];

    let sql = 'SELECT * FROM links WHERE cell_id = ? AND base_address = ? AND deleted = 0';
    const params: any[] = [cellId, toBytes(baseAddress)];

    if (linkType !== undefined) {
      sql += ' AND link_type = ?';
      params.push(linkType);
    }

    const stmt = db.prepare(sql);
    try {
      stmt.bind(params);
      while (stmt.step()) {
        const row = stmt.get({});
        results.push({
          createLinkHash: new Uint8Array(row.create_link_hash),
          baseAddress: new Uint8Array(row.base_address),
          targetAddress: new Uint8Array(row.target_address),
          timestamp: BigInt(row.timestamp),
          zomeIndex: row.zome_index,
          linkType: row.link_type,
          tag: row.tag ? new Uint8Array(row.tag) : new Uint8Array(),
          author: new Uint8Array(row.author),
          deleted: false,
        });
      }
    } finally {
      stmt.finalize();
    }
    return results;
  }

  deleteLink(createLinkHash: ActionHash, deleteHash: ActionHash): void {
    const stmt = db.prepare('UPDATE links SET deleted = 1, delete_hash = ? WHERE create_link_hash = ?');
    try {
      stmt.bind([toBytes(deleteHash), toBytes(createLinkHash)]);
      stmt.step();
    } finally {
      stmt.finalize();
    }
  }

  clear(): void {
    db.exec('DELETE FROM actions');
    db.exec('DELETE FROM entries');
    db.exec('DELETE FROM links');
    db.exec('DELETE FROM chain_heads');
  }

  private rowToAction(row: any): Action {
    return {
      actionHash: new Uint8Array(row.action_hash),
      actionSeq: row.action_seq,
      author: new Uint8Array(row.author),
      timestamp: BigInt(row.timestamp),
      prevActionHash: row.prev_action_hash ? new Uint8Array(row.prev_action_hash) : null,
      actionType: row.action_type,
      signature: new Uint8Array(row.signature),
      entryHash: row.entry_hash ? new Uint8Array(row.entry_hash) : undefined,
      entryType: row.entry_type ? JSON.parse(row.entry_type) : undefined,
      originalActionHash: row.original_action_hash ? new Uint8Array(row.original_action_hash) : undefined,
      originalEntryHash: row.original_entry_hash ? new Uint8Array(row.original_entry_hash) : undefined,
      deletesActionHash: row.deletes_action_hash ? new Uint8Array(row.deletes_action_hash) : undefined,
      deletesEntryHash: row.deletes_entry_hash ? new Uint8Array(row.deletes_entry_hash) : undefined,
      baseAddress: row.base_address ? new Uint8Array(row.base_address) : undefined,
      targetAddress: row.target_address ? new Uint8Array(row.target_address) : undefined,
      zomeIndex: row.zome_index,
      linkType: row.link_type,
      tag: row.tag ? new Uint8Array(row.tag) : undefined,
      linkAddAddress: row.link_add_address ? new Uint8Array(row.link_add_address) : undefined,
      dnaHash: row.dna_hash ? new Uint8Array(row.dna_hash) : undefined,
      membraneProof: row.membrane_proof ? new Uint8Array(row.membrane_proof) : undefined,
    };
  }
}

/**
 * Helper to ensure a value is a proper Uint8Array for SQLite binding.
 * Values might come through as ArrayBuffer, typed array views, or array-like objects.
 */
function toBytes(value: any): Uint8Array | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value) || (typeof value === 'object' && 'length' in value)) {
    return new Uint8Array(value);
  }
  console.warn('[DirectSQLiteStorage] Unknown byte type:', typeof value, value);
  return new Uint8Array(value);
}

const storage = new DirectSQLiteStorage();

/**
 * Proxy Lair Client - forwards signing requests to offscreen/background
 *
 * Uses SharedArrayBuffers and Atomics.wait for synchronous operation
 * so that WASM can call signing synchronously.
 */
class ProxyLairClient implements ILairClient {
  // Track "preloaded" keys - in our case, we always forward to background
  // but we track which keys have been registered for preloading
  private preloadedKeys = new Set<string>();

  private keyToString(key: Uint8Array): string {
    return btoa(String.fromCharCode(...key));
  }

  // Required interface methods - signing is what we need

  async newSeed(tag: string, exportable?: boolean): Promise<any> {
    throw new Error('ProxyLairClient does not support newSeed - use background Lair client');
  }

  async getEntry(tag: string): Promise<any> {
    throw new Error('ProxyLairClient does not support getEntry - use background Lair client');
  }

  async listEntries(): Promise<any[]> {
    throw new Error('ProxyLairClient does not support listEntries - use background Lair client');
  }

  async signByPubKey(pub_key: Ed25519PubKey, data: Uint8Array): Promise<Ed25519Signature> {
    // Forward to background for async signing
    return this.signSync(pub_key, data);
  }

  async preloadKeyForSync(pub_key: Ed25519PubKey): Promise<void> {
    // Mark as preloaded - we don't actually preload since we proxy to background
    this.preloadedKeys.add(this.keyToString(pub_key));
    console.log(`[ProxyLairClient] Key marked as preloaded: ${this.keyToString(pub_key).substring(0, 20)}...`);
  }

  signSync(pub_key: Ed25519PubKey, data: Uint8Array): Ed25519Signature {
    if (!signSignalBuffer || !signResultBuffer) {
      throw new Error('Sign buffers not initialized');
    }

    console.log(`[ProxyLairClient] signSync called, data length: ${data.length}`);

    // Reset signal
    Atomics.store(signSignalView!, 0, 0);

    // Send request to offscreen
    self.postMessage({
      type: 'SIGN_REQUEST',
      pub_key: Array.from(pub_key),
      data: Array.from(data),
    });

    // Block until offscreen responds
    console.log('[ProxyLairClient] Waiting for sign response...');
    const waitResult = Atomics.wait(signSignalView!, 0, 0, 30000);

    if (waitResult === 'timed-out') {
      throw new Error('Signing request timed out');
    }

    // Read response from shared buffer
    // Format: [success: 1 byte] [length: 4 bytes] [data: variable]
    const success = signResultView![0] === 1;
    const dv = new DataView(signResultBuffer!);
    const dataLength = dv.getInt32(1, true); // little-endian

    if (!success) {
      // Read error message
      const errorBytes = new Uint8Array(signResultBuffer!, 5, dataLength);
      const errorMsg = new TextDecoder().decode(errorBytes);
      throw new Error(`Signing failed: ${errorMsg}`);
    }

    // Read signature (64 bytes)
    const signature = new Uint8Array(signResultBuffer!, 5, 64);
    console.log(`[ProxyLairClient] Sign response received, signature length: ${signature.length}`);

    return new Uint8Array(signature) as Ed25519Signature;
  }

  hasPreloadedKey(pub_key: Ed25519PubKey): boolean {
    return this.preloadedKeys.has(this.keyToString(pub_key));
  }

  clearPreloadedKey(pub_key: Ed25519PubKey): void {
    this.preloadedKeys.delete(this.keyToString(pub_key));
  }

  clearAllPreloadedKeys(): void {
    this.preloadedKeys.clear();
  }

  // Methods we don't support in proxy

  async deriveSeed(): Promise<any> {
    throw new Error('ProxyLairClient does not support deriveSeed');
  }

  async cryptoBoxByPubKey(): Promise<any> {
    throw new Error('ProxyLairClient does not support cryptoBoxByPubKey');
  }

  async cryptoBoxOpenByPubKey(): Promise<any> {
    throw new Error('ProxyLairClient does not support cryptoBoxOpenByPubKey');
  }

  async secretBoxByTag(): Promise<any> {
    throw new Error('ProxyLairClient does not support secretBoxByTag');
  }

  async secretBoxOpenByTag(): Promise<any> {
    throw new Error('ProxyLairClient does not support secretBoxOpenByTag');
  }

  async exportSeedByTag(): Promise<any> {
    throw new Error('ProxyLairClient does not support exportSeedByTag');
  }

  async importSeed(): Promise<any> {
    throw new Error('ProxyLairClient does not support importSeed');
  }

  async exportSeedAsMnemonic(): Promise<string> {
    throw new Error('ProxyLairClient does not support exportSeedAsMnemonic');
  }

  async importSeedFromMnemonic(): Promise<NewSeedResult> {
    throw new Error('ProxyLairClient does not support importSeedFromMnemonic');
  }

  async deleteEntry(): Promise<void> {
    throw new Error('ProxyLairClient does not support deleteEntry');
  }
}

const proxyLairClient = new ProxyLairClient();

/**
 * Network service that proxies to offscreen document for sync XHR
 */
class ProxyNetworkService implements NetworkService {
  /**
   * Low-level sync fetch via offscreen document
   */
  fetchSync(method: string, url: string, headers?: Record<string, string>, body?: Uint8Array): { status: number; body: Uint8Array } {
    if (!networkSignalBuffer || !networkResultBuffer) {
      throw new Error('Network buffers not initialized');
    }

    const requestId = nextNetworkRequestId++;

    // Reset signal
    Atomics.store(networkSignalView!, 0, 0);

    // Send request to offscreen
    self.postMessage({
      type: 'NETWORK_REQUEST',
      id: requestId,
      method,
      url,
      headers,
      body: body ? Array.from(body) : undefined,
    });

    // Block until offscreen responds
    console.log('[Ribosome Worker] Waiting for network response...');
    const waitResult = Atomics.wait(networkSignalView!, 0, 0, 30000);

    if (waitResult === 'timed-out') {
      throw new Error('Network request timed out');
    }

    // Read response from shared buffer
    const dv = new DataView(networkResultBuffer!);
    const status = dv.getInt32(0);
    const bodyLength = dv.getInt32(4);
    const responseBody = new Uint8Array(networkResultBuffer!, 8, bodyLength);

    console.log('[Ribosome Worker] Network response received, status:', status);

    return { status, body: new Uint8Array(responseBody) };
  }

  /**
   * Get DNA hash as base64 string
   */
  private getDnaHashB64(dnaHash: DnaHash): string {
    return encodeHashToBase64(dnaHash);
  }

  /**
   * Convert hash to Holochain base64 format
   */
  private toHolochainBase64(bytes: Uint8Array): string {
    return encodeHashToBase64(bytes);
  }

  /**
   * Build URL for fetching a record
   */
  private buildRecordUrl(dnaHash: DnaHash, hash: AnyDhtHash): string {
    const dnaHashB64 = this.getDnaHashB64(dnaHash);
    const hashB64 = this.toHolochainBase64(hash);
    return `${linkerUrl}/dht/${dnaHashB64}/record/${hashB64}`;
  }

  /**
   * Build URL for fetching details
   */
  private buildDetailsUrl(dnaHash: DnaHash, hash: AnyDhtHash): string {
    const dnaHashB64 = this.getDnaHashB64(dnaHash);
    const hashB64 = this.toHolochainBase64(hash);
    return `${linkerUrl}/dht/${dnaHashB64}/details/${hashB64}`;
  }

  /**
   * Build URL for fetching links
   */
  private buildLinksUrl(dnaHash: DnaHash, baseAddress: AnyDhtHash, linkType?: number, zomeIndex?: number): string {
    const dnaHashB64 = this.getDnaHashB64(dnaHash);
    const baseB64 = this.toHolochainBase64(baseAddress);
    const params = new URLSearchParams();
    params.set('base', baseB64);
    if (linkType !== undefined) {
      params.set('type', linkType.toString());
    }
    if (zomeIndex !== undefined) {
      params.set('zome_index', zomeIndex.toString());
    }
    return `${linkerUrl}/dht/${dnaHashB64}/links?${params.toString()}`;
  }

  /**
   * Build URL for counting links
   */
  private buildCountLinksUrl(dnaHash: DnaHash, baseAddress: AnyDhtHash, linkType?: number, zomeIndex?: number): string {
    const dnaHashB64 = this.getDnaHashB64(dnaHash);
    const baseB64 = this.toHolochainBase64(baseAddress);
    const params = new URLSearchParams();
    params.set('base', baseB64);
    if (linkType !== undefined) {
      params.set('type', linkType.toString());
    }
    if (zomeIndex !== undefined) {
      params.set('zome_index', zomeIndex.toString());
    }
    return `${linkerUrl}/dht/${dnaHashB64}/count_links?${params.toString()}`;
  }

  /**
   * Recursively convert JSON arrays to Uint8Array
   */
  private normalizeByteArrays(data: any): any {
    if (data === null || data === undefined) return data;
    if (data instanceof Uint8Array) return data;

    if (Array.isArray(data)) {
      // Check if it's a flat array of numbers (likely bytes)
      if (data.length > 0 && data.every(v => typeof v === 'number' && v >= 0 && v <= 255)) {
        return new Uint8Array(data);
      }
      return data.map(item => this.normalizeByteArrays(item));
    }

    if (typeof data === 'object') {
      const result: any = {};
      for (const [key, value] of Object.entries(data)) {
        result[key] = this.normalizeByteArrays(value);
      }
      return result;
    }

    return data;
  }

  /**
   * Parse record response from linker
   */
  private parseRecordResponse(responseText: string): NetworkRecord | null {
    try {
      const data = JSON.parse(responseText);
      if (!data || !data.signed_action) {
        return null;
      }

      return {
        signed_action: this.normalizeByteArrays(data.signed_action),
        entry: this.parseEntry(data.entry),
      };
    } catch (error) {
      console.error('[ProxyNetwork] Failed to parse record response:', error);
      return null;
    }
  }

  /**
   * Parse entry from linker response
   */
  private parseEntry(data: unknown): NetworkEntry {
    if (!data || data === 'NA' || data === 'NotApplicable') {
      return 'NotApplicable';
    }
    if (data === 'Hidden') return 'Hidden';
    if (data === 'NotStored') return 'NotStored';
    const record = data as Record<string, unknown>;
    if (record.Present !== undefined) {
      return { Present: this.normalizeByteArrays(record.Present) };
    }
    return { Present: this.normalizeByteArrays(data) };
  }

  /**
   * Parse links response from linker
   *
   * Linker may return one of two formats:
   * 1. Vec<Link> - array of Link objects (conductor-dht mode)
   * 2. WireLinkOps - {creates: [...], deletes: [...]} (direct kitsune2 mode)
   *
   * Linker returns hashes as JSON arrays (e.g., [132, 41, 36, ...])
   * NOT as base64 strings. Use normalizeByteArrays to convert.
   */
  private parseLinksResponse(responseText: string, baseAddress?: AnyDhtHash): NetworkLink[] {
    try {
      const data = JSON.parse(responseText);

      // Check if this is WireLinkOps format (direct kitsune2 mode)
      if (data && typeof data === 'object' && 'creates' in data && Array.isArray(data.creates)) {
        console.log(`[ProxyNetwork] Parsing WireLinkOps format with ${data.creates.length} creates, ${data.deletes?.length || 0} deletes`);
        return this.parseWireLinkOps(data, baseAddress);
      }

      // Otherwise expect Vec<Link> format (conductor mode)
      if (!Array.isArray(data)) {
        console.log('[ProxyNetwork] Links response is not an array:', typeof data);
        return [];
      }

      console.log(`[ProxyNetwork] Parsing ${data.length} links from linker (Link array format)`);

      return data.map((link: any) => ({
        create_link_hash: this.normalizeByteArrays(link.create_link_hash),
        base: this.normalizeByteArrays(link.base),
        target: this.normalizeByteArrays(link.target),
        zome_index: link.zome_index,
        link_type: link.link_type,
        tag: link.tag ? this.normalizeByteArrays(link.tag) : new Uint8Array(0),
        timestamp: link.timestamp,
        author: this.normalizeByteArrays(link.author),
      }));
    } catch (error) {
      console.error('[ProxyNetwork] Failed to parse links response:', error);
      return [];
    }
  }

  /**
   * Parse WireLinkOps format from direct kitsune2 response
   *
   * WireCreateLink has:
   * - author, timestamp, action_seq, prev_action, target_address,
   *   zome_index, link_type, tag, signature, validation_status, weight
   */
  private parseWireLinkOps(wireOps: { creates: any[]; deletes?: any[] }, baseAddress?: AnyDhtHash): NetworkLink[] {
    if (!wireOps.creates || wireOps.creates.length === 0) {
      return [];
    }

    return wireOps.creates.map((create: any, idx: number) => {
      const author = this.normalizeByteArrays(create.author);
      // WireCreateLink uses target_address, not target
      const target = this.normalizeByteArrays(create.target_address);
      const tag = create.tag ? this.normalizeByteArrays(create.tag) : new Uint8Array(0);

      // Compute a create_link_hash from prev_action and action_seq
      const prevAction = this.normalizeByteArrays(create.prev_action);
      const createLinkHash = this.computeCreateLinkHash(prevAction, create.action_seq);

      // Use provided baseAddress or create empty placeholder
      const base = baseAddress || new Uint8Array(39);

      console.log(`[ProxyNetwork] WireLinkOps create ${idx}:`, {
        target_prefix: target instanceof Uint8Array ? Array.from(target.slice(0, 3)) : 'N/A',
        author_prefix: author instanceof Uint8Array ? Array.from(author.slice(0, 3)) : 'N/A',
        zome_index: create.zome_index,
        link_type: create.link_type,
      });

      return {
        create_link_hash: createLinkHash,
        base,
        target,
        zome_index: typeof create.zome_index === 'number' ? create.zome_index : create.zome_index?.value || 0,
        link_type: typeof create.link_type === 'number' ? create.link_type : create.link_type?.value || 0,
        tag,
        timestamp: create.timestamp,
        author,
      };
    });
  }

  /**
   * Compute a unique hash for a create link action based on prev_action and action_seq
   */
  private computeCreateLinkHash(prevAction: ActionHash, actionSeq: number): ActionHash {
    const hash = new Uint8Array(39);
    // ActionHash prefix
    hash[0] = 132;
    hash[1] = 41;
    hash[2] = 36;

    // Copy core bytes from prev_action
    const coreStart = prevAction.length === 39 ? 3 : 0;
    const coreBytes = prevAction.slice(coreStart, coreStart + 32);
    hash.set(coreBytes, 3);

    // XOR action_seq into first 4 bytes of core to make it unique
    hash[3] ^= (actionSeq >> 24) & 0xff;
    hash[4] ^= (actionSeq >> 16) & 0xff;
    hash[5] ^= (actionSeq >> 8) & 0xff;
    hash[6] ^= actionSeq & 0xff;

    // DHT location (last 4 bytes)
    if (prevAction.length >= 39) {
      hash.set(prevAction.slice(35, 39), 35);
    }

    return hash;
  }

  // NetworkService interface methods

  getRecordSync(dnaHash: DnaHash, hash: AnyDhtHash, options?: any): NetworkRecord | null {
    if (!linkerUrl) {
      return null;
    }

    const url = this.buildRecordUrl(dnaHash, hash);
    console.log(`[ProxyNetwork] Fetching record: ${url}`);

    try {
      const response = this.fetchSync('GET', url, { 'Accept': 'application/json' });

      if (response.status === 200) {
        const responseText = new TextDecoder().decode(response.body);
        const record = this.parseRecordResponse(responseText);
        console.log(`[ProxyNetwork] Record fetched successfully`);
        return record;
      } else if (response.status === 404) {
        console.log(`[ProxyNetwork] Record not found (404)`);
        return null;
      } else {
        console.error(`[ProxyNetwork] Network error: ${response.status}`);
        return null;
      }
    } catch (error) {
      console.error(`[ProxyNetwork] Request failed:`, error);
      return null;
    }
  }

  getLinksSync(dnaHash: DnaHash, baseAddress: AnyDhtHash, linkType?: number, zomeIndex?: number, options?: any): NetworkLink[] {
    if (!linkerUrl) {
      return [];
    }

    const url = this.buildLinksUrl(dnaHash, baseAddress, linkType, zomeIndex);
    console.log(`[ProxyNetwork] Fetching links: ${url}`);

    try {
      const response = this.fetchSync('GET', url, { 'Accept': 'application/json' });

      if (response.status === 200) {
        const responseText = new TextDecoder().decode(response.body);
        const links = this.parseLinksResponse(responseText, baseAddress);
        console.log(`[ProxyNetwork] Fetched ${links.length} links`);
        return links;
      } else if (response.status === 404) {
        console.log(`[ProxyNetwork] No links found (404)`);
        return [];
      } else {
        console.error(`[ProxyNetwork] Network error: ${response.status}`);
        return [];
      }
    } catch (error) {
      console.error(`[ProxyNetwork] Request failed:`, error);
      return [];
    }
  }

  getDetailsSync(dnaHash: DnaHash, hash: AnyDhtHash, options?: any): any | null {
    if (!linkerUrl) {
      return null;
    }

    const url = this.buildDetailsUrl(dnaHash, hash);
    console.log(`[ProxyNetwork] Fetching details: ${url}`);

    try {
      const response = this.fetchSync('GET', url, { 'Accept': 'application/json' });

      if (response.status === 200) {
        const responseText = new TextDecoder().decode(response.body);
        const details = JSON.parse(responseText);
        console.log(`[ProxyNetwork] Details fetched successfully`);
        return this.normalizeByteArrays(details);
      } else if (response.status === 404) {
        console.log(`[ProxyNetwork] Details not found (404)`);
        return null;
      } else {
        console.error(`[ProxyNetwork] Network error: ${response.status}`);
        return null;
      }
    } catch (error) {
      console.error(`[ProxyNetwork] Request failed:`, error);
      return null;
    }
  }

  countLinksSync(dnaHash: DnaHash, baseAddress: AnyDhtHash, linkType?: number, zomeIndex?: number, options?: any): number {
    if (!linkerUrl) {
      return 0;
    }

    const url = this.buildCountLinksUrl(dnaHash, baseAddress, linkType, zomeIndex);
    console.log(`[ProxyNetwork] Counting links: ${url}`);

    try {
      const response = this.fetchSync('GET', url, { 'Accept': 'application/json' });

      if (response.status === 200) {
        const responseText = new TextDecoder().decode(response.body);
        const count = JSON.parse(responseText);
        console.log(`[ProxyNetwork] Link count:`, typeof count, Array.isArray(count) ? `array(${count.length})` : count);
        // CountLinksResponse is Vec<ActionHash> (array) in kitsune mode, or number in conductor mode
        if (Array.isArray(count)) {
          return count.length;
        }
        return typeof count === 'number' ? count : 0;
      } else if (response.status === 404) {
        console.log(`[ProxyNetwork] No links found (404)`);
        return 0;
      } else {
        console.error(`[ProxyNetwork] Network error: ${response.status}`);
        return 0;
      }
    } catch (error) {
      console.error(`[ProxyNetwork] Request failed:`, error);
      return 0;
    }
  }

  getAgentActivitySync(
    dnaHash: DnaHash,
    agentPubKey: AgentPubKey,
    activityRequest: 'status' | 'full',
    options?: any,
  ): AgentActivityResponse | null {
    if (!linkerUrl) {
      return null;
    }
    const dnaHashB64 = this.getDnaHashB64(dnaHash);
    const agentB64 = this.toHolochainBase64(agentPubKey);
    const url = `${linkerUrl}/dht/${dnaHashB64}/agent_activity/${agentB64}?request=${activityRequest}`;
    console.log(`[ProxyNetwork] Fetching agent activity: ${url}`);
    try {
      const response = this.fetchSync('GET', url, { 'Accept': 'application/json' });
      if (response.status === 200) {
        const responseText = new TextDecoder().decode(response.body);
        const data = JSON.parse(responseText);
        console.log(`[ProxyNetwork] Agent activity fetched, status: ${data.status}`);
        return this.normalizeByteArrays(data) as AgentActivityResponse;
      } else if (response.status === 404) {
        console.log(`[ProxyNetwork] Agent activity not found (404)`);
        return null;
      } else {
        console.error(`[ProxyNetwork] Agent activity error: ${response.status}`);
        return null;
      }
    } catch (error) {
      console.error(`[ProxyNetwork] Agent activity request failed:`, error);
      return null;
    }
  }

  mustGetAgentActivitySync(
    dnaHash: DnaHash,
    agent: AgentPubKey,
    chainTop: ActionHash,
    includeCachedEntries: boolean,
    options?: any,
  ): MustGetAgentActivityResponse | null {
    if (!linkerUrl) {
      return null;
    }
    const dnaHashB64 = this.getDnaHashB64(dnaHash);
    const url = `${linkerUrl}/dht/${dnaHashB64}/must_get_agent_activity`;
    const body = JSON.stringify({
      agent: Array.from(agent),
      chain_top: Array.from(chainTop),
      include_cached_entries: includeCachedEntries,
    });
    console.log(`[ProxyNetwork] Fetching must_get_agent_activity: ${url}`);
    try {
      const response = this.fetchSync('POST', url, {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      }, new TextEncoder().encode(body));
      if (response.status === 200) {
        const responseText = new TextDecoder().decode(response.body);
        const data = JSON.parse(responseText);
        console.log(`[ProxyNetwork] must_get_agent_activity fetched`);
        return this.normalizeByteArrays(data) as MustGetAgentActivityResponse;
      } else {
        console.error(`[ProxyNetwork] must_get_agent_activity error: ${response.status}`);
        return null;
      }
    } catch (error) {
      console.error(`[ProxyNetwork] must_get_agent_activity request failed:`, error);
      return null;
    }
  }

  isAvailable(): boolean {
    // Network is available if linker URL is configured
    return linkerUrl !== '';
  }

  getLinkerUrl(): string {
    return linkerUrl;
  }

  getSessionToken(): string | null {
    return sessionToken;
  }

  setSessionToken(token: string | null): void {
    sessionToken = token;
  }
}

const networkService = new ProxyNetworkService();

/**
 * Handle messages from offscreen document
 */
// Serialize zome calls via promise chain to prevent concurrent SQLite
// transactions from interleaving at await points within callZome().
// Without this, two concurrent CALL_ZOME messages (e.g., UI call + network
// recv_remote_signal) can both reach beginTransaction(), causing SQLite to
// throw "cannot start a transaction within a transaction".
// Non-CALL_ZOME messages bypass the chain and execute immediately.
let zomeCallChain: Promise<void> = Promise.resolve();

/**
 * Execute a CALL_ZOME request. Extracted from onmessage so it can be
 * serialized via zomeCallChain.
 */
async function handleCallZome(payload: any): Promise<any> {
  const workerCallStart = performance.now();
  const { dnaWasm, cellId, zome, fn, payloadBytes, provenance, dnaManifest } = payload;
  console.log(`[Ribosome Worker] >>> handleCallZome START: ${zome}::${fn}`);

  // Set cell context for storage
  const cellIdBytes: [DnaHash, AgentPubKey] = [
    new Uint8Array(cellId[0]) as DnaHash,
    new Uint8Array(cellId[1]) as AgentPubKey,
  ];
  storage.setCellContext(cellIdBytes[0], cellIdBytes[1]);
  const afterSetContext = performance.now();

  // Use cached WASM if available, otherwise cache the incoming WASM
  const dnaHashKey = getWasmCacheKey(cellId[0]);
  let cachedWasm = wasmCache.get(dnaHashKey);
  if (!cachedWasm && dnaWasm && dnaWasm.length > 0) {
    // First time seeing this DNA - cache the WASM
    cachedWasm = new Uint8Array(dnaWasm);
    wasmCache.set(dnaHashKey, cachedWasm);
    console.log(`[Ribosome Worker] Cached WASM for ${dnaHashKey.substring(0, 16)}... (${cachedWasm.length} bytes)`);
  } else if (cachedWasm) {
    console.log(`[Ribosome Worker] Using cached WASM for ${dnaHashKey.substring(0, 16)}...`);
  }

  if (!cachedWasm) {
    throw new Error('No WASM available for DNA');
  }

  const request: ZomeCallRequest = {
    dnaWasm: cachedWasm,
    cellId: cellIdBytes,
    zome,
    fn,
    payload: new Uint8Array(payloadBytes),
    provenance: new Uint8Array(provenance),
    dnaManifest,
  };
  const afterBuildRequest = performance.now();

  console.log(`[Ribosome Worker] >>> calling WASM: ${zome}::${fn}`);
  const zomeResult = await callZome(request);
  const afterZomeCall = performance.now();
  console.log(`[Ribosome Worker] <<< WASM returned: ${zome}::${fn} in ${(afterZomeCall - afterBuildRequest).toFixed(0)}ms`);

  // Convert pending records for transport (Uint8Array -> Array)
  let pendingRecordsForTransport: any[] | undefined;
  if (zomeResult.pendingRecords && zomeResult.pendingRecords.length > 0) {
    pendingRecordsForTransport = zomeResult.pendingRecords.map(record => {
      // Convert Entry for transport - Entry is internally tagged: { entry_type: "App", entry: bytes }
      let entryForTransport: any = undefined;
      const recordEntry = record.entry;
      // recordEntry can be an object ({ Present: ... }, { NotApplicable: null }) or
      // a string ("NA", "Hidden", "NotStored") from msgpack deserialization.
      // The `in` operator only works on objects, so check typeof first.
      if (recordEntry && typeof recordEntry === 'object' && 'Present' in recordEntry) {
        const presentEntry = recordEntry.Present;
        // Narrow entry content: App entries have Uint8Array, Agent entries have AgentPubKey (also Uint8Array)
        const entryBytes = presentEntry.entry instanceof Uint8Array
          ? Array.from(presentEntry.entry)
          : presentEntry.entry;
        entryForTransport = {
          Present: {
            entry_type: presentEntry.entry_type,
            entry: entryBytes,
          }
        };
      } else if (recordEntry && typeof recordEntry === 'object' && 'NotApplicable' in recordEntry) {
        entryForTransport = { NotApplicable: null };
      }

      return {
        signed_action: {
          hashed: {
            content: record.signed_action.hashed.content,
            hash: Array.from(record.signed_action.hashed.hash),
          },
          signature: Array.from(record.signed_action.signature),
        },
        entry: entryForTransport,
      };
    });
    console.log(`[Ribosome Worker] ${pendingRecordsForTransport.length} pending records for publishing`);
  }

  // Send remote signals immediately via postMessage (fire-and-forget)
  // This mirrors Holochain's tokio::spawn pattern for send_remote_signal
  if (zomeResult.remoteSignals && zomeResult.remoteSignals.length > 0) {
    console.log(`[Ribosome Worker] Sending ${zomeResult.remoteSignals.length} remote signals`);
    // Send as separate message - offscreen will forward to WebSocket
    // Include DNA hash so offscreen knows which linker connection to use
    self.postMessage({
      type: 'SEND_REMOTE_SIGNALS',
      dnaHash: Array.from(cellIdBytes[0]),
      signals: zomeResult.remoteSignals,
    });
  }

  console.log(`[Ribosome Worker] Returning ${(zomeResult.signals || []).length} emitted signals`);

  console.log(`[PERF Worker] CALL_ZOME message handling:
   ├─ setContext:     ${(afterSetContext - workerCallStart).toFixed(1)}ms
   ├─ buildRequest:   ${(afterBuildRequest - afterSetContext).toFixed(1)}ms
   ├─ callZome:       ${(afterZomeCall - afterBuildRequest).toFixed(1)}ms
   └─ TOTAL:          ${(afterZomeCall - workerCallStart).toFixed(1)}ms`);

  return {
    result: zomeResult.result,
    signals: zomeResult.signals || [],
    pendingRecords: pendingRecordsForTransport,
  };
}

self.onmessage = async (event: MessageEvent) => {
  const { id, type, payload } = event.data;

  try {
    let result: any;

    switch (type) {
      case 'INIT':
        // Initialize SQLite
        await initSQLite();

        // Set up network buffers
        if (payload.networkSignalBuffer && payload.networkResultBuffer) {
          const nsb: SharedArrayBuffer = payload.networkSignalBuffer;
          const nrb: SharedArrayBuffer = payload.networkResultBuffer;
          networkSignalBuffer = nsb;
          networkSignalView = new Int32Array(nsb);
          networkResultBuffer = nrb;
          networkResultView = new Uint8Array(nrb);
        }

        // Set up sign buffers
        if (payload.signSignalBuffer && payload.signResultBuffer) {
          const ssb: SharedArrayBuffer = payload.signSignalBuffer;
          const srb: SharedArrayBuffer = payload.signResultBuffer;
          signSignalBuffer = ssb;
          signSignalView = new Int32Array(ssb);
          signResultBuffer = srb;
          signResultView = new Uint8Array(srb);
          console.log('[Ribosome Worker] Sign buffers initialized');
        }

        // Set storage provider for ribosome
        setStorageProvider(storage);
        setNetworkService(networkService);

        // Set Lair client for signing
        setLairClient(proxyLairClient);
        console.log('[Ribosome Worker] Lair client set');

        result = { success: true };
        console.log('[Ribosome Worker] Initialized');
        break;

      case 'CONFIGURE_NETWORK':
        linkerUrl = payload.linkerUrl || '';
        sessionToken = payload.sessionToken || null;
        console.log('[Ribosome Worker] Network configured:', linkerUrl);
        result = { success: true };
        break;

      case 'SET_LOG_FILTER':
        workerLogFilter = payload.filter ?? '*';
        originalConsoleLog(`[Ribosome Worker] Log filter set to: ${workerLogFilter === '*' ? 'all' : workerLogFilter === '' ? 'none' : workerLogFilter}`);
        result = { success: true, filter: workerLogFilter };
        break;

      case 'CALL_ZOME': {
        // Chain onto zomeCallChain so concurrent CALL_ZOME messages execute
        // one at a time. Errors are isolated per-call (the chain always continues).
        const callPromise = zomeCallChain.then(() => handleCallZome(payload));
        zomeCallChain = callPromise.then(() => {}, () => {});
        result = await callPromise;
        break;
      }

      case 'NETWORK_RESPONSE':
        // Response from offscreen's sync XHR - signal is handled via Atomics
        break;

      case 'GET_ALL_RECORDS': {
        // Get all records for a cell - used for republishing
        const { dnaHash: dnaHashArr, agentPubKey: agentPubKeyArr } = payload;
        const dnaHashBytes = new Uint8Array(dnaHashArr) as DnaHash;
        const agentPubKeyBytes = new Uint8Array(agentPubKeyArr) as AgentPubKey;

        console.log('[Ribosome Worker] Getting all records for republishing');
        const records = storage.getAllRecords(dnaHashBytes, agentPubKeyBytes);
        console.log(`[Ribosome Worker] Found ${records.length} records`);

        // Convert records to transport format (Uint8Array -> Array)
        const recordsForTransport = records.map(record => {
          // Convert entry for transport
          let entryForTransport: any = null;
          if (record.entry) {
            entryForTransport = {
              entryHash: Array.from(record.entry.entryHash),
              entryContent: Array.from(record.entry.entryContent),
              entryType: record.entry.entryType,
            };
          }

          // Convert action for transport - convert Uint8Array to Array and BigInt to string
          // for Chrome message passing compatibility.
          // rowToAction creates flat objects with all fields; variant-specific fields are undefined.
          const actionForTransport: Record<string, unknown> = { ...record.action };
          actionForTransport.timestamp = record.action.timestamp?.toString() || '0';
          for (const key of Object.keys(actionForTransport)) {
            const value = actionForTransport[key];
            if (value instanceof Uint8Array) {
              actionForTransport[key] = Array.from(value);
            } else if (value === undefined) {
              actionForTransport[key] = null;
            }
          }

          return { action: actionForTransport, entry: entryForTransport };
        });

        result = { records: recordsForTransport };
        break;
      }

      case 'RECOVER_CHAIN': {
        // Recover chain data from DHT for all DNAs of a hApp context
        const { dnaHashes: recoverDnaHashes, agentPubKey: recoverAgentKey } = payload;
        const agentBytes = new Uint8Array(recoverAgentKey);

        let totalRecovered = 0;
        let totalFailed = 0;
        let totalVerified = 0;
        let totalUnverified = 0;
        const allErrors: string[] = [];

        for (const dnaHashArr of recoverDnaHashes) {
          const dnaHashBytes = new Uint8Array(dnaHashArr);
          console.log(`[Ribosome Worker] Recovering chain for DNA ${encodeHashToBase64(dnaHashBytes).substring(0, 15)}...`);

          // Set cell context for storage writes
          storage.setCellContext(dnaHashBytes, agentBytes);

          const { records, errors: dnaErrors } = recoverChainFromDHT(
            dnaHashBytes,
            agentBytes,
            networkService,
            (progress) => {
              // Fire-and-forget progress update to offscreen
              self.postMessage({
                type: 'RECOVER_CHAIN_PROGRESS',
                progress,
              });
            }
          );

          allErrors.push(...dnaErrors);

          // Store recovered records using the shared helper
          const storeResult = storeRecoveredRecords(records, storage, dnaHashBytes, agentBytes);
          totalRecovered += storeResult.recoveredCount;
          totalFailed += storeResult.failedCount;
          totalVerified += storeResult.verifiedCount;
          totalUnverified += storeResult.unverifiedCount;
          allErrors.push(...storeResult.errors);
        }

        console.log(`[Ribosome Worker] Recovery complete: ${totalRecovered} recovered, ${totalFailed} failed, ${totalVerified} verified, ${totalUnverified} unverified`);
        result = { recoveredCount: totalRecovered, failedCount: totalFailed, verifiedCount: totalVerified, unverifiedCount: totalUnverified, errors: allErrors };
        break;
      }

      case 'RUN_GENESIS': {
        // Run genesis_self_check then initializeGenesis with a membrane proof.
        // Called from provideMemproofs before enabling a deferred-memproof context.
        const { dnaWasm: genesisDnaWasm, cellId: genesisCellId, dnaManifest: genesisManifest, membraneProof: genesisProof } = payload;

        const cellIdBytes: [DnaHash, AgentPubKey] = [
          new Uint8Array(genesisCellId[0]) as DnaHash,
          new Uint8Array(genesisCellId[1]) as AgentPubKey,
        ];
        const [genesisDnaHash, genesisAgentKey] = cellIdBytes;

        // Load WASM into cache (same pattern as CALL_ZOME)
        const genesisDnaHashKey = getWasmCacheKey(genesisCellId[0]);
        let genesisWasm = wasmCache.get(genesisDnaHashKey);
        if (!genesisWasm && genesisDnaWasm && genesisDnaWasm.length > 0) {
          genesisWasm = new Uint8Array(genesisDnaWasm);
          wasmCache.set(genesisDnaHashKey, genesisWasm);
        }
        if (!genesisWasm) {
          throw new Error('No WASM available for genesis');
        }

        // Inject WASM into manifest integrity zomes so runGenesisSelfCheck can find it.
        // Always use genesisWasm (reconstructed from number[] payload) — Chrome message
        // passing corrupts Uint8Array to {0:x,1:y} plain objects, so z.wasm from the
        // manifest cannot be used even if it looks non-empty.
        const manifestWithWasm = genesisManifest ? {
          ...genesisManifest,
          integrity_zomes: (genesisManifest.integrity_zomes || []).map((z: any) => ({
            ...z,
            wasm: genesisWasm,
          })),
        } : genesisManifest;

        storage.setCellContext(genesisDnaHash, genesisAgentKey);

        const memproofBytes = genesisProof ? new Uint8Array(genesisProof) : undefined;

        // 1. Run genesis_self_check
        const { runGenesisSelfCheck } = await import('@hwc/core/ribosome/genesis-self-check');
        const selfCheckResult = await runGenesisSelfCheck(manifestWithWasm, cellIdBytes, memproofBytes);
        if (!selfCheckResult.valid) {
          result = { valid: false, reason: selfCheckResult.reason };
          break;
        }

        // 2. Run initializeGenesis with the membrane proof
        const { initializeGenesis } = await import('@hwc/core/storage/genesis');
        const genesisResult = await initializeGenesis(storage as any, genesisDnaHash, genesisAgentKey, memproofBytes);

        // Convert pending records to the same signed_action transport format used by
        // CALL_ZOME. buildRecords converts StoredRecord[] (BigInt timestamps) to
        // HolochainRecord[] (@holochain/client format, number tuple timestamps).
        // Uint8Arrays are then converted to number[] for Chrome message passing.
        const { buildRecords } = await import('@hwc/core/dht');
        const clientRecords = buildRecords(genesisResult.pendingRecords || []);
        const genesisRecordsForTransport = clientRecords.map((record: any) => {
          let entryForTransport: any = undefined;
          const recordEntry = record.entry;
          if (recordEntry && typeof recordEntry === 'object' && 'Present' in recordEntry) {
            const presentEntry = recordEntry.Present;
            entryForTransport = {
              Present: {
                entry_type: presentEntry.entry_type,
                entry: Array.from(presentEntry.entry),
              }
            };
          } else if (recordEntry && typeof recordEntry === 'object' && 'NotApplicable' in recordEntry) {
            entryForTransport = { NotApplicable: null };
          }
          return {
            signed_action: {
              hashed: {
                content: record.signed_action.hashed.content,
                hash: Array.from(record.signed_action.hashed.hash),
              },
              signature: Array.from(record.signed_action.signature),
            },
            entry: entryForTransport,
          };
        });

        result = { valid: true, pendingRecords: genesisRecordsForTransport };
        break;
      }

      default:
        throw new Error(`Unknown message type: ${type}`);
    }

    self.postMessage({ id, success: true, result });
  } catch (error) {
    console.error('[Ribosome Worker] Error:', error);
    self.postMessage({
      id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

// Signal ready
self.postMessage({ type: 'READY' });
console.log('[Ribosome Worker] Started');
