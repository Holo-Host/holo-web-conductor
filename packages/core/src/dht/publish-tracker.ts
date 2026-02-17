/**
 * Publish Tracker
 *
 * Tracks pending DhtOp publications and handles retry logic.
 * Stores publish status in IndexedDB and provides methods for
 * queueing, updating, and querying publish state.
 */

import type { DnaHash, Record as HolochainRecord } from "@holochain/client";
import type { ChainOp, PendingPublish, OpBasis } from "./dht-op-types";
import { PublishStatus, ChainOpType } from "./dht-op-types";
import { produceOpsFromRecord, computeOpBasis, getOpAction } from "./produce-ops";

const DB_NAME = "fishy_publish_tracker";
const DB_VERSION = 2; // v2: Changed dnaHash from number[] to dnaHashStr string for proper indexing

const STORES = {
  PENDING_PUBLISHES: "pendingPublishes",
} as const;

/**
 * Storable version of PendingPublish for IndexedDB
 * Converts Uint8Array and complex types to serializable formats
 */
interface StorablePendingPublish {
  id: string;
  opType: ChainOpType;
  opData: string; // JSON serialized ChainOp with base64 binary fields
  basis: number[]; // Uint8Array as number[]
  status: PublishStatus;
  retryCount: number;
  lastAttempt: number;
  error?: string;
  dnaHashStr: string; // Base64 string for indexing (arrays don't work as keys)
  createdAt: number;
}

/**
 * Result from a publish attempt
 */
export interface PublishAttemptResult {
  success: boolean;
  error?: string;
}

/**
 * Options for publish operations
 */
export interface PublishOptions {
  /** Linker URL for publishing */
  linkerUrl: string;
  /** Session token for authentication */
  sessionToken?: string;
  /** Maximum retry attempts */
  maxRetries?: number;
  /** Base delay for exponential backoff (ms) */
  baseDelay?: number;
}

/**
 * Publish Tracker - manages pending DHT publications
 */
export class PublishTracker {
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;
  private static instance: PublishTracker | null = null;

  private constructor() {}

  /**
   * Get singleton instance
   */
  static getInstance(): PublishTracker {
    if (!PublishTracker.instance) {
      PublishTracker.instance = new PublishTracker();
    }
    return PublishTracker.instance;
  }

  /**
   * Initialize IndexedDB
   */
  async init(): Promise<void> {
    if (this.db) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        console.log("[PublishTracker] Initialized");
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        const oldVersion = event.oldVersion;

        if (!db.objectStoreNames.contains(STORES.PENDING_PUBLISHES)) {
          const store = db.createObjectStore(STORES.PENDING_PUBLISHES, {
            keyPath: "id",
          });
          // Index by status for querying pending/failed ops
          store.createIndex("status", "status", { unique: false });
          // Index by DNA hash string for filtering
          store.createIndex("dnaHashStr", "dnaHashStr", { unique: false });
          // Compound index for DNA + status queries
          store.createIndex("dnaHashStr_status", ["dnaHashStr", "status"], {
            unique: false,
          });
        } else if (oldVersion < 2) {
          // Migration from v1: Add new indexes for string-based DNA hash
          const tx = (event.target as IDBOpenDBRequest).transaction!;
          const store = tx.objectStore(STORES.PENDING_PUBLISHES);

          // Delete old array-based indexes
          if (store.indexNames.contains("dnaHash")) {
            store.deleteIndex("dnaHash");
          }
          if (store.indexNames.contains("dnaHash_status")) {
            store.deleteIndex("dnaHash_status");
          }

          // Create new string-based indexes
          store.createIndex("dnaHashStr", "dnaHashStr", { unique: false });
          store.createIndex("dnaHashStr_status", ["dnaHashStr", "status"], {
            unique: false,
          });

          console.log("[PublishTracker] Migrated indexes from v1 to v2");
        }

        console.log("[PublishTracker] Database upgraded to version", DB_VERSION);
      };
    });

    return this.initPromise;
  }

  /**
   * Generate unique ID for a publish
   */
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Convert DNA hash to base64 string for indexing
   */
  private dnaHashToString(dnaHash: DnaHash): string {
    let binary = "";
    for (let i = 0; i < dnaHash.length; i++) {
      binary += String.fromCharCode(dnaHash[i]);
    }
    return btoa(binary);
  }

  /**
   * Convert ChainOp to storable JSON format
   */
  private opToStorable(op: ChainOp): string {
    // Convert Uint8Array fields to base64 for JSON storage
    const serializable = JSON.stringify(op, (key, value) => {
      if (value instanceof Uint8Array) {
        return { __uint8array__: true, data: Array.from(value) };
      }
      return value;
    });
    return serializable;
  }

  /**
   * Convert storable JSON back to ChainOp
   */
  private storableToOp(data: string): ChainOp {
    return JSON.parse(data, (key, value) => {
      if (value && typeof value === "object" && value.__uint8array__) {
        return new Uint8Array(value.data);
      }
      return value;
    });
  }

  /**
   * Queue a record's DhtOps for publishing
   *
   * @param record - The Record to generate ops from
   * @param dnaHash - DNA hash for this record
   * @returns Array of pending publish IDs
   */
  async queueRecordForPublish(
    record: HolochainRecord,
    dnaHash: DnaHash
  ): Promise<string[]> {
    await this.init();

    // Generate DhtOps from the record
    const ops = produceOpsFromRecord(record);
    const actionHash = record.signed_action.hashed.hash;

    const publishIds: string[] = [];

    for (const op of ops) {
      const id = this.generateId();
      const action = getOpAction(op);
      const basis = computeOpBasis(op.type, action, actionHash);

      const pending: PendingPublish = {
        id,
        op,
        basis,
        status: PublishStatus.Pending,
        retryCount: 0,
        lastAttempt: 0,
      };

      await this.storePendingPublish(pending, dnaHash);
      publishIds.push(id);
    }

    console.log(
      `[PublishTracker] Queued ${publishIds.length} ops for publishing`,
      { dnaHash: Array.from(dnaHash).slice(0, 8) }
    );

    return publishIds;
  }

  /**
   * Store a pending publish
   */
  private async storePendingPublish(
    pending: PendingPublish,
    dnaHash: DnaHash
  ): Promise<void> {
    const storable: StorablePendingPublish = {
      id: pending.id,
      opType: pending.op.type,
      opData: this.opToStorable(pending.op),
      basis: Array.from(pending.basis),
      status: pending.status,
      retryCount: pending.retryCount,
      lastAttempt: pending.lastAttempt,
      error: pending.error,
      dnaHashStr: this.dnaHashToString(dnaHash),
      createdAt: Date.now(),
    };

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORES.PENDING_PUBLISHES, "readwrite");
      const request = tx.objectStore(STORES.PENDING_PUBLISHES).put(storable);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get pending publish by ID
   */
  async getPendingPublish(id: string): Promise<PendingPublish | null> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORES.PENDING_PUBLISHES, "readonly");
      const request = tx.objectStore(STORES.PENDING_PUBLISHES).get(id);

      request.onsuccess = () => {
        const storable = request.result as StorablePendingPublish | undefined;
        if (!storable) {
          resolve(null);
          return;
        }

        resolve({
          id: storable.id,
          op: this.storableToOp(storable.opData),
          basis: new Uint8Array(storable.basis),
          status: storable.status,
          retryCount: storable.retryCount,
          lastAttempt: storable.lastAttempt,
          error: storable.error,
        });
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get all pending publishes by status
   */
  async getPendingByStatus(status: PublishStatus): Promise<PendingPublish[]> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORES.PENDING_PUBLISHES, "readonly");
      const store = tx.objectStore(STORES.PENDING_PUBLISHES);
      const index = store.index("status");
      const request = index.getAll(status);

      request.onsuccess = () => {
        const results = request.result as StorablePendingPublish[];
        resolve(
          results.map((s) => ({
            id: s.id,
            op: this.storableToOp(s.opData),
            basis: new Uint8Array(s.basis),
            status: s.status,
            retryCount: s.retryCount,
            lastAttempt: s.lastAttempt,
            error: s.error,
          }))
        );
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get pending publishes for a specific DNA
   */
  async getPendingForDna(
    dnaHash: DnaHash,
    status?: PublishStatus
  ): Promise<PendingPublish[]> {
    await this.init();

    const dnaHashStr = this.dnaHashToString(dnaHash);

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORES.PENDING_PUBLISHES, "readonly");
      const store = tx.objectStore(STORES.PENDING_PUBLISHES);

      let request: IDBRequest;
      if (status !== undefined) {
        const index = store.index("dnaHashStr_status");
        request = index.getAll([dnaHashStr, status]);
      } else {
        const index = store.index("dnaHashStr");
        request = index.getAll(dnaHashStr);
      }

      request.onsuccess = () => {
        const results = request.result as StorablePendingPublish[];
        resolve(
          results.map((s) => ({
            id: s.id,
            op: this.storableToOp(s.opData),
            basis: new Uint8Array(s.basis),
            status: s.status,
            retryCount: s.retryCount,
            lastAttempt: s.lastAttempt,
            error: s.error,
          }))
        );
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Update publish status
   */
  async updateStatus(
    id: string,
    status: PublishStatus,
    error?: string
  ): Promise<void> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORES.PENDING_PUBLISHES, "readwrite");
      const store = tx.objectStore(STORES.PENDING_PUBLISHES);
      const getRequest = store.get(id);

      getRequest.onsuccess = () => {
        const storable = getRequest.result as StorablePendingPublish | undefined;
        if (!storable) {
          resolve();
          return;
        }

        storable.status = status;
        storable.lastAttempt = Date.now();
        if (error !== undefined) {
          storable.error = error;
        }
        if (status === PublishStatus.Failed) {
          storable.retryCount++;
        }

        const putRequest = store.put(storable);
        putRequest.onsuccess = () => resolve();
        putRequest.onerror = () => reject(putRequest.error);
      };

      getRequest.onerror = () => reject(getRequest.error);
    });
  }

  /**
   * Remove a published op from tracking
   */
  async removePendingPublish(id: string): Promise<void> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORES.PENDING_PUBLISHES, "readwrite");
      const request = tx.objectStore(STORES.PENDING_PUBLISHES).delete(id);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get count of pending publishes by status
   */
  async getStatusCounts(): Promise<Record<PublishStatus, number>> {
    await this.init();

    const counts: Record<PublishStatus, number> = {
      [PublishStatus.Pending]: 0,
      [PublishStatus.InFlight]: 0,
      [PublishStatus.Published]: 0,
      [PublishStatus.Failed]: 0,
    };

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORES.PENDING_PUBLISHES, "readonly");
      const store = tx.objectStore(STORES.PENDING_PUBLISHES);
      const request = store.openCursor();

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          const storable = cursor.value as StorablePendingPublish;
          counts[storable.status]++;
          cursor.continue();
        } else {
          resolve(counts);
        }
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Clear all publish tracking data (for testing)
   */
  async clear(): Promise<void> {
    await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORES.PENDING_PUBLISHES, "readwrite");
      const request = tx.objectStore(STORES.PENDING_PUBLISHES).clear();

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get status counts for multiple DNAs (for per-hApp status)
   * Returns aggregate counts across all specified DNAs
   */
  async getStatusCountsForDnas(
    dnaHashes: DnaHash[]
  ): Promise<{ pending: number; inFlight: number; failed: number }> {
    await this.init();

    const counts = { pending: 0, inFlight: 0, failed: 0 };

    // Create a Set of DNA hash strings for efficient lookup
    const dnaHashStrings = new Set(
      dnaHashes.map((h) => this.dnaHashToString(h))
    );

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORES.PENDING_PUBLISHES, "readonly");
      const store = tx.objectStore(STORES.PENDING_PUBLISHES);
      const request = store.openCursor();

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          const storable = cursor.value as StorablePendingPublish;

          if (dnaHashStrings.has(storable.dnaHashStr)) {
            switch (storable.status) {
              case PublishStatus.Pending:
                counts.pending++;
                break;
              case PublishStatus.InFlight:
                counts.inFlight++;
                break;
              case PublishStatus.Failed:
                counts.failed++;
                break;
              // Published ops are not counted (they're removed after success)
            }
          }
          cursor.continue();
        } else {
          resolve(counts);
        }
      };

      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Reset all failed ops to pending for specified DNAs
   * Used by "Retry Failed" button in debug panel
   */
  async resetFailedForDnas(dnaHashes: DnaHash[]): Promise<number> {
    await this.init();

    // Create a Set of DNA hash strings (base64) for efficient lookup
    const dnaHashStrings = new Set(
      dnaHashes.map((h) => this.dnaHashToString(h))
    );

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction(STORES.PENDING_PUBLISHES, "readwrite");
      const store = tx.objectStore(STORES.PENDING_PUBLISHES);
      const request = store.openCursor();
      let resetCount = 0;

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          const storable = cursor.value as StorablePendingPublish;

          if (
            dnaHashStrings.has(storable.dnaHashStr) &&
            storable.status === PublishStatus.Failed
          ) {
            storable.status = PublishStatus.Pending;
            storable.error = undefined;
            storable.retryCount = 0;
            cursor.update(storable);
            resetCount++;
          }
          cursor.continue();
        } else {
          console.log(
            `[PublishTracker] Reset ${resetCount} failed ops to pending`
          );
          resolve(resetCount);
        }
      };

      request.onerror = () => reject(request.error);
    });
  }
}
