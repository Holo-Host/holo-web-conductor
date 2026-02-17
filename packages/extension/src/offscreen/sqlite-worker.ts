/**
 * SQLite Worker
 *
 * Dedicated worker that runs SQLite with OPFS persistence via opfs-sahpool VFS.
 * Receives messages from the offscreen document and executes SQL operations.
 *
 * Architecture:
 * - Runs in a dedicated worker (spawned by offscreen document)
 * - Uses opfs-sahpool VFS for synchronous durable writes to OPFS
 * - Communicates via SharedArrayBuffer + Atomics for synchronous responses
 *
 * Why this approach:
 * - FileSystemSyncAccessHandle (for sync OPFS access) only works in dedicated workers
 * - opfs-sahpool pre-allocates file handles for sync access without COOP/COEP headers
 * - SharedArrayBuffer + Atomics.notify() enables sync communication back to main thread
 */

// Polyfill document for sqlite-wasm which tries to access it during module init in workers
// This must be before importing sqlite-wasm
if (typeof document === 'undefined') {
  // Use the worker's URL as the script src so sqlite-wasm can derive the base URL
  const workerUrl = (self as any).location?.href || 'chrome-extension://placeholder/offscreen/sqlite-worker.js';
  // baseURI must be the extension ROOT (not worker URL) because sqlite-wasm's fallback code
  // does: new URL("offscreen/sqlite-worker.js", document.baseURI) - so baseURI should NOT
  // include "offscreen/" or we get double-nested paths
  const extensionRoot = workerUrl.replace(/\/offscreen\/sqlite-worker\.js.*$/, '/');
  (self as any).document = {
    // currentScript needs tagName="SCRIPT" for sqlite-wasm's check
    currentScript: { src: workerUrl, tagName: 'SCRIPT' },
    // baseURI is extension root - the module appends "offscreen/sqlite-worker.js" to this
    baseURI: extensionRoot,
    querySelector: () => null,
    createElement: (tag: string) => ({
      style: {},
      setAttribute: () => {},
      appendChild: () => {},
    }),
    head: {
      appendChild: () => {},
    },
    body: {
      appendChild: () => {},
    },
  };
}

// Import schema types (these don't need document)
import { SCHEMA_SQL, type WorkerRequest, type WorkerResponse } from '@hwc/core/storage/sqlite-schema';

// sqlite3InitModule will be dynamically imported after polyfill is set up
let sqlite3InitModule: any = null;

// Database instance
let db: any = null;
let sqlite3: any = null;

// SharedArrayBuffer for synchronous signaling
let sharedBuffer: SharedArrayBuffer | null = null;
let int32View: Int32Array | null = null;
let resultBuffer: SharedArrayBuffer | null = null;
let resultView: Uint8Array | null = null;

// Result storage (for responses that don't fit in SharedArrayBuffer signal)
const pendingResults = new Map<number, any>();

/**
 * Initialize SQLite with OPFS VFS
 */
async function initDatabase(): Promise<void> {
  console.log('[SQLite Worker] Initializing SQLite WASM...');

  try {
    // Dynamically import sqlite-wasm after polyfill is in place
    if (!sqlite3InitModule) {
      const module = await import('@sqlite.org/sqlite-wasm');
      sqlite3InitModule = module.default;
    }

    // Initialize sqlite - the module will fetch WASM using the corrected baseURI
    sqlite3 = await sqlite3InitModule({
      print: (...args: any[]) => console.log('[SQLite]', ...args),
      printErr: (...args: any[]) => console.error('[SQLite Error]', ...args),
    });

    console.log('[SQLite Worker] SQLite loaded, version:', sqlite3.version.libVersion);

    // Check available VFS options
    const vfsList = sqlite3.capi.sqlite3_js_vfs_list();
    console.log('[SQLite Worker] Available VFS:', vfsList);

    // Try to use opfs-sahpool for synchronous OPFS access
    // If not available, fall back to OPFS (async) or memory
    let vfsName = ':memory:';
    let dbPath = ':memory:';

    if (vfsList.includes('opfs-sahpool')) {
      console.log('[SQLite Worker] Using opfs-sahpool VFS for sync OPFS access');
      vfsName = 'opfs-sahpool';
      dbPath = 'hwc-chain.sqlite3';

      // Install opfs-sahpool if needed
      if (sqlite3.installOpfsSAHPoolVfs) {
        try {
          await sqlite3.installOpfsSAHPoolVfs({
            name: 'opfs-sahpool',
            directory: undefined, // Use default OPFS root
          });
          console.log('[SQLite Worker] opfs-sahpool VFS installed');
        } catch (e) {
          console.log('[SQLite Worker] opfs-sahpool already installed or error:', e);
        }
      }
    } else if (vfsList.includes('opfs')) {
      console.log('[SQLite Worker] Using OPFS VFS (async fallback)');
      vfsName = 'opfs';
      dbPath = 'hwc-chain.sqlite3';
    } else {
      console.warn('[SQLite Worker] OPFS not available, using in-memory database');
    }

    // Open database
    if (vfsName === ':memory:') {
      db = new sqlite3.oo1.DB(':memory:');
    } else if (vfsName === 'opfs-sahpool') {
      // Use OpfsSAHPoolDb for synchronous OPFS access
      const poolUtil = await sqlite3.installOpfsSAHPoolVfs?.() ?? sqlite3.opfs?.sahPool;
      if (poolUtil) {
        db = new poolUtil.OpfsSAHPoolDb(dbPath);
      } else {
        // Fallback to regular OPFS
        db = new sqlite3.oo1.OpfsDb(dbPath);
      }
    } else {
      db = new sqlite3.oo1.OpfsDb(dbPath);
    }

    console.log('[SQLite Worker] Database opened:', dbPath);

    // Create schema
    db.exec(SCHEMA_SQL);
    console.log('[SQLite Worker] Schema created');

    // Enable WAL mode for better performance (if supported)
    try {
      db.exec('PRAGMA journal_mode=WAL');
      console.log('[SQLite Worker] WAL mode enabled');
    } catch (e) {
      console.log('[SQLite Worker] WAL mode not available:', e);
    }

  } catch (error) {
    console.error('[SQLite Worker] Failed to initialize database:', error);
    throw error;
  }
}

/**
 * Execute a query and return results
 */
function executeQuery(sql: string, params?: unknown[]): any[] {
  if (!db) throw new Error('Database not initialized');

  const results: any[] = [];

  if (params && params.length > 0) {
    // Prepare statement with parameters
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params);
      while (stmt.step()) {
        results.push(stmt.get({})); // Get as object
      }
    } finally {
      stmt.finalize();
    }
  } else {
    // Simple query without parameters
    db.exec({
      sql,
      callback: (row: any) => {
        results.push(row);
      },
    });
  }

  return results;
}

/**
 * Execute a statement (INSERT/UPDATE/DELETE)
 */
function executeStatement(sql: string, params?: unknown[]): { changes: number; lastInsertRowId: number } {
  if (!db) throw new Error('Database not initialized');

  if (params && params.length > 0) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params);
      stmt.step();
    } finally {
      stmt.finalize();
    }
  } else {
    db.exec(sql);
  }

  return {
    changes: db.changes(),
    lastInsertRowId: db.lastInsertRowId(),
  };
}

/**
 * Setup SharedArrayBuffer for synchronous communication
 */
function setupSharedBuffers(signalBuffer: SharedArrayBuffer, resultBuf: SharedArrayBuffer): void {
  sharedBuffer = signalBuffer;
  int32View = new Int32Array(sharedBuffer);
  resultBuffer = resultBuf;
  resultView = new Uint8Array(resultBuffer);
  console.log('[SQLite Worker] SharedArrayBuffers configured');
}

/**
 * Signal completion to main thread
 */
function signalComplete(requestId: number, success: boolean): void {
  if (!int32View) {
    console.warn('[SQLite Worker] No signal buffer configured');
    return;
  }

  // Store request ID and success flag
  Atomics.store(int32View, 0, requestId);
  Atomics.store(int32View, 1, success ? 1 : 0);

  // Wake up waiting thread
  Atomics.notify(int32View, 0);
}

/**
 * Store result for retrieval by main thread
 */
function storeResult(requestId: number, result: any): void {
  pendingResults.set(requestId, result);

  // Also try to serialize small results to shared buffer
  if (resultView) {
    try {
      const json = JSON.stringify(result);
      const bytes = new TextEncoder().encode(json);

      if (bytes.length < resultView.length - 4) {
        // Store length in first 4 bytes
        const dv = new DataView(resultBuffer!);
        dv.setUint32(0, bytes.length);
        resultView.set(bytes, 4);
      }
    } catch (e) {
      // Result too large or not serializable - main thread will fetch via message
    }
  }
}

/**
 * Handle incoming messages
 */
self.onmessage = async (event: MessageEvent) => {
  const request = event.data as WorkerRequest | {
    type: 'SETUP_BUFFERS';
    id?: number;
    signalBuffer: SharedArrayBuffer;
    resultBuffer: SharedArrayBuffer;
  };

  // Handle buffer setup separately
  if (request.type === 'SETUP_BUFFERS' && 'signalBuffer' in request) {
    setupSharedBuffers(request.signalBuffer, request.resultBuffer);
    // Use the request id so the promise resolves correctly
    self.postMessage({ id: request.id ?? -1, success: true });
    return;
  }

  const { id, type, payload } = request as WorkerRequest;

  try {
    let result: any;

    switch (type) {
      case 'INIT':
        await initDatabase();
        result = { success: true };
        break;

      case 'QUERY':
        if (!payload?.sql) throw new Error('Missing SQL for query');
        result = executeQuery(payload.sql, payload.params as unknown[]);
        break;

      case 'EXEC':
        if (!payload?.sql) throw new Error('Missing SQL for exec');
        result = executeStatement(payload.sql, payload.params as unknown[]);
        break;

      case 'BEGIN':
        db.exec('BEGIN TRANSACTION');
        result = { success: true };
        break;

      case 'COMMIT':
        db.exec('COMMIT');
        result = { success: true };
        break;

      case 'ROLLBACK':
        db.exec('ROLLBACK');
        result = { success: true };
        break;

      case 'CLOSE':
        if (db) {
          db.close();
          db = null;
        }
        result = { success: true };
        break;

      default:
        throw new Error(`Unknown message type: ${type}`);
    }

    // Store result for main thread
    storeResult(id, result);

    // Signal completion if using shared buffers
    if (int32View) {
      signalComplete(id, true);
    }

    // Also send via postMessage for async fallback
    self.postMessage({ id, success: true, result } as WorkerResponse);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('[SQLite Worker] Error:', errorMessage);

    storeResult(id, { error: errorMessage });

    if (int32View) {
      signalComplete(id, false);
    }

    self.postMessage({ id, success: false, error: errorMessage } as WorkerResponse);
  }
};

// Signal that worker is ready
self.postMessage({ id: 0, success: true, result: { type: 'READY' } });
console.log('[SQLite Worker] Worker started and ready');
