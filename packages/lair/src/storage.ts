/**
 * IndexedDB storage layer for Lair keystore
 *
 * Stores key entries in browser IndexedDB for persistence
 */

import type { EntryTag, EntryInfo, StoredKeyEntry } from "./types";

const DB_NAME = "fishy_lair";
const DB_VERSION = 1;
const STORE_NAME = "keys";

/**
 * Storage interface for key entries
 */
export interface KeyStorage {
  /** Initialize the storage */
  init(): Promise<void>;

  /** Store a key entry */
  putEntry(entry: StoredKeyEntry): Promise<void>;

  /** Get a key entry by tag */
  getEntry(tag: EntryTag): Promise<StoredKeyEntry | null>;

  /** Get entry info (without private key) by tag */
  getEntryInfo(tag: EntryTag): Promise<EntryInfo | null>;

  /** List all entry infos (without private keys) */
  listEntries(): Promise<EntryInfo[]>;

  /** Check if a tag exists */
  hasEntry(tag: EntryTag): Promise<boolean>;

  /** Delete an entry */
  deleteEntry(tag: EntryTag): Promise<void>;

  /** Clear all entries (for testing) */
  clear(): Promise<void>;
}

/**
 * IndexedDB-based key storage implementation
 */
export class IndexedDBKeyStorage implements KeyStorage {
  private db: IDBDatabase | null = null;

  async init(): Promise<void> {
    if (this.db) return; // Already initialized

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        reject(new Error(`Failed to open IndexedDB: ${request.error}`));
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Create object store for keys with tag as key path
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, {
            keyPath: "info.tag",
          });

          // Note: We don't create an index on ed25519_pub_key since it's now
          // stored as an array and IndexedDB indexing on arrays is complex
        }
      };
    });
  }

  async putEntry(entry: StoredKeyEntry): Promise<void> {
    if (!this.db) throw new Error("Storage not initialized");

    // Convert Uint8Arrays to regular arrays for storage
    const storableEntry = this.toStorable(entry);

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put(storableEntry);

      request.onsuccess = () => resolve();
      request.onerror = () =>
        reject(new Error(`Failed to store entry: ${request.error}`));
    });
  }

  async getEntry(tag: EntryTag): Promise<StoredKeyEntry | null> {
    if (!this.db) throw new Error("Storage not initialized");

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(tag);

      request.onsuccess = () => {
        const result = request.result;
        if (!result) {
          resolve(null);
        } else {
          // Convert back to Uint8Arrays
          resolve(this.fromStorable(result));
        }
      };
      request.onerror = () =>
        reject(new Error(`Failed to get entry: ${request.error}`));
    });
  }

  async getEntryInfo(tag: EntryTag): Promise<EntryInfo | null> {
    const entry = await this.getEntry(tag);
    return entry ? entry.info : null;
  }

  async listEntries(): Promise<EntryInfo[]> {
    if (!this.db) throw new Error("Storage not initialized");

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();

      request.onsuccess = () => {
        const storedEntries = request.result as any[];
        const entries = storedEntries.map((stored) =>
          this.fromStorable(stored)
        );
        resolve(entries.map((entry) => entry.info));
      };
      request.onerror = () =>
        reject(new Error(`Failed to list entries: ${request.error}`));
    });
  }

  async hasEntry(tag: EntryTag): Promise<boolean> {
    const entry = await this.getEntryInfo(tag);
    return entry !== null;
  }

  async deleteEntry(tag: EntryTag): Promise<void> {
    if (!this.db) throw new Error("Storage not initialized");

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(tag);

      request.onsuccess = () => resolve();
      request.onerror = () =>
        reject(new Error(`Failed to delete entry: ${request.error}`));
    });
  }

  async clear(): Promise<void> {
    if (!this.db) throw new Error("Storage not initialized");

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.clear();

      request.onsuccess = () => resolve();
      request.onerror = () =>
        reject(new Error(`Failed to clear storage: ${request.error}`));
    });
  }

  /**
   * Convert StoredKeyEntry to a format suitable for IndexedDB
   */
  private toStorable(entry: StoredKeyEntry): any {
    return {
      info: {
        tag: entry.info.tag,
        ed25519_pub_key: Array.from(entry.info.ed25519_pub_key),
        x25519_pub_key: Array.from(entry.info.x25519_pub_key),
        created_at: entry.info.created_at,
        exportable: entry.info.exportable,
      },
      seed: Array.from(entry.seed),
    };
  }

  /**
   * Convert stored data back to StoredKeyEntry with Uint8Arrays
   */
  private fromStorable(stored: any): StoredKeyEntry {
    return {
      info: {
        tag: stored.info.tag,
        ed25519_pub_key: new Uint8Array(stored.info.ed25519_pub_key),
        x25519_pub_key: new Uint8Array(stored.info.x25519_pub_key),
        created_at: stored.info.created_at,
        exportable: stored.info.exportable,
      },
      seed: new Uint8Array(stored.seed),
    };
  }

  /**
   * Close the database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

/**
 * Create and initialize a new key storage instance
 */
export async function createKeyStorage(): Promise<KeyStorage> {
  const storage = new IndexedDBKeyStorage();
  await storage.init();
  return storage;
}
