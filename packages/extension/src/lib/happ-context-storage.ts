/**
 * hApp Context Storage - IndexedDB persistence for hApp contexts
 *
 * Follows the same pattern as Lair keystore storage:
 * - IndexedDB for persistence
 * - Uint8Array serialization (Array for storage, Uint8Array for runtime)
 * - Singleton pattern with async initialization
 * - Domain-based indexing for fast lookups
 */

import type { HappContext, DnaContext } from "@hwc/core";

const DB_NAME = "hwc_happ_contexts";
const DB_VERSION = 1;
const CONTEXTS_STORE = "contexts";
const DNA_WASM_STORE = "dna_wasm";

/**
 * Storable context - Uint8Arrays converted to Arrays for IndexedDB
 */
interface StorableContext {
  id: string;
  domain: string;
  agentPubKey: number[];
  agentKeyTag: string;
  dnas: StorableDnaContext[];
  appName?: string;
  appVersion?: string;
  installedAt: number;
  lastUsed: number;
  enabled: boolean;
}

/**
 * Storable DNA context
 */
interface StorableDnaContext {
  hash: number[];
  wasm: number[];
  name?: string;
  properties?: Record<string, unknown>;
  manifest?: Record<string, unknown>;  // DnaManifestRuntime stored as plain object
}

/**
 * DNA WASM entry in IndexedDB
 */
interface DnaWasmEntry {
  hash: string; // base64-encoded hash (used as key)
  wasm: number[]; // Uint8Array stored as array
  size: number;
  storedAt: number;
}

/**
 * hApp context storage manager
 */
export class HappContextStorage {
  private db: IDBDatabase | null = null;
  private ready: Promise<void>;

  // In-memory cache to avoid repeated IndexedDB reads
  private contextCache: Map<string, HappContext> = new Map();
  private domainToIdCache: Map<string, string> = new Map();
  private cacheInitialized = false;

  constructor() {
    this.ready = this.initialize();
  }

  /**
   * Initialize IndexedDB
   */
  private async initialize(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        console.error("[HappContextStorage] Failed to open database:", request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        console.log(`[HappContextStorage] Database opened: ${DB_NAME}`);
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Create contexts store with domain index
        if (!db.objectStoreNames.contains(CONTEXTS_STORE)) {
          const contextsStore = db.createObjectStore(CONTEXTS_STORE, {
            keyPath: "id",
          });
          contextsStore.createIndex("domain", "domain", { unique: true });
          contextsStore.createIndex("installedAt", "installedAt", { unique: false });
          contextsStore.createIndex("lastUsed", "lastUsed", { unique: false });
          console.log(`[HappContextStorage] Created ${CONTEXTS_STORE} store`);
        }

        // Create DNA WASM store
        if (!db.objectStoreNames.contains(DNA_WASM_STORE)) {
          db.createObjectStore(DNA_WASM_STORE, {
            keyPath: "hash",
          });
          console.log(`[HappContextStorage] Created ${DNA_WASM_STORE} store`);
        }
      };
    });
  }

  /**
   * Ensure database is ready before operations
   */
  private async ensureReady(): Promise<void> {
    await this.ready;
    if (!this.db) {
      throw new Error("Database not initialized");
    }
  }

  /**
   * Initialize the in-memory cache from IndexedDB (lazy loading)
   */
  private async initializeCache(): Promise<void> {
    if (this.cacheInitialized) return;

    await this.ensureReady();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([CONTEXTS_STORE], "readonly");
      const store = transaction.objectStore(CONTEXTS_STORE);
      const request = store.getAll();

      request.onsuccess = () => {
        const stored = request.result as StorableContext[];
        for (const s of stored) {
          const context = this.fromStorable(s);
          this.contextCache.set(context.id, context);
          this.domainToIdCache.set(context.domain, context.id);
        }
        this.cacheInitialized = true;
        console.log(`[HappContextStorage] Cache initialized with ${stored.length} contexts`);
        resolve();
      };

      request.onerror = () => {
        console.error(`[HappContextStorage] Failed to initialize cache:`, request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Serialize manifest for storage (convert nested WASM Uint8Arrays to Arrays)
   */
  private serializeManifest(manifest: import('@hwc/core').DnaManifestRuntime | undefined): Record<string, unknown> | undefined {
    if (!manifest) return undefined;

    return {
      ...manifest,
      integrity_zomes: manifest.integrity_zomes.map(z => ({
        ...z,
        wasm: z.wasm ? Array.from(z.wasm) : undefined,
      })),
      coordinator_zomes: manifest.coordinator_zomes.map(z => ({
        ...z,
        wasm: z.wasm ? Array.from(z.wasm) : undefined,
      })),
    };
  }

  /**
   * Deserialize manifest from storage (convert nested WASM Arrays back to Uint8Arrays)
   */
  private deserializeManifest(stored: Record<string, unknown> | undefined): import('@hwc/core').DnaManifestRuntime | undefined {
    if (!stored) return undefined;

    const manifest = stored as {
      name: string;
      network_seed?: string;
      properties?: Record<string, unknown>;
      integrity_zomes: Array<{ name: string; index: number; wasm?: number[] | Uint8Array; dependencies: string[]; entryDefs?: unknown[] }>;
      coordinator_zomes: Array<{ name: string; index: number; wasm?: number[] | Uint8Array; dependencies: string[] }>;
    };

    return {
      ...manifest,
      integrity_zomes: manifest.integrity_zomes.map(z => ({
        ...z,
        wasm: z.wasm ? new Uint8Array(z.wasm as number[]) : undefined,
        entryDefs: z.entryDefs as any,
      })),
      coordinator_zomes: manifest.coordinator_zomes.map(z => ({
        ...z,
        wasm: z.wasm ? new Uint8Array(z.wasm as number[]) : undefined,
      })),
    } as import('@hwc/core').DnaManifestRuntime;
  }

  /**
   * Convert HappContext to storable format (Uint8Array → Array)
   */
  private toStorable(context: HappContext): StorableContext {
    return {
      id: context.id,
      domain: context.domain,
      agentPubKey: Array.from(context.agentPubKey),
      agentKeyTag: context.agentKeyTag,
      dnas: context.dnas.map((dna) => ({
        hash: Array.from(dna.hash),
        wasm: Array.from(dna.wasm),
        name: dna.name,
        properties: dna.properties,
        manifest: this.serializeManifest(dna.manifest),
      })),
      appName: context.appName,
      appVersion: context.appVersion,
      installedAt: context.installedAt,
      lastUsed: context.lastUsed,
      enabled: context.enabled,
    };
  }

  /**
   * Convert storable format to HappContext (Array → Uint8Array)
   */
  private fromStorable(stored: StorableContext): HappContext {
    return {
      id: stored.id,
      domain: stored.domain,
      agentPubKey: new Uint8Array(stored.agentPubKey),
      agentKeyTag: stored.agentKeyTag,
      dnas: stored.dnas.map((dna) => ({
        hash: new Uint8Array(dna.hash),
        wasm: new Uint8Array(dna.wasm),
        name: dna.name,
        properties: dna.properties,
        manifest: this.deserializeManifest(dna.manifest),
      })),
      appName: stored.appName,
      appVersion: stored.appVersion,
      installedAt: stored.installedAt,
      lastUsed: stored.lastUsed,
      enabled: stored.enabled,
    };
  }

  /**
   * Convert Uint8Array to base64 string (for DNA WASM keys)
   */
  private toBase64(data: Uint8Array): string {
    return btoa(String.fromCharCode(...data));
  }

  /**
   * Convert base64 string to Uint8Array
   */
  private fromBase64(base64: string): Uint8Array {
    return new Uint8Array(atob(base64).split("").map((c) => c.charCodeAt(0)));
  }

  /**
   * Put context into storage
   */
  async putContext(context: HappContext): Promise<void> {
    await this.ensureReady();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([CONTEXTS_STORE], "readwrite");
      const store = transaction.objectStore(CONTEXTS_STORE);
      const storable = this.toStorable(context);

      const request = store.put(storable);

      request.onsuccess = () => {
        // Update cache
        this.contextCache.set(context.id, context);
        this.domainToIdCache.set(context.domain, context.id);
        console.log(`[HappContextStorage] Stored context ${context.id} for ${context.domain}`);
        resolve();
      };

      request.onerror = () => {
        console.error(`[HappContextStorage] Failed to store context:`, request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Get context by ID
   */
  async getContext(id: string): Promise<HappContext | null> {
    // Try cache first
    await this.initializeCache();
    const cached = this.contextCache.get(id);
    if (cached) {
      return cached;
    }

    // Fall back to IndexedDB (shouldn't happen if cache is properly initialized)
    await this.ensureReady();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([CONTEXTS_STORE], "readonly");
      const store = transaction.objectStore(CONTEXTS_STORE);
      const request = store.get(id);

      request.onsuccess = () => {
        const stored = request.result as StorableContext | undefined;
        if (stored) {
          const context = this.fromStorable(stored);
          // Update cache
          this.contextCache.set(context.id, context);
          this.domainToIdCache.set(context.domain, context.id);
          resolve(context);
        } else {
          resolve(null);
        }
      };

      request.onerror = () => {
        console.error(`[HappContextStorage] Failed to get context:`, request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Get context by domain (using domain index)
   */
  async getContextByDomain(domain: string): Promise<HappContext | null> {
    // Try cache first
    await this.initializeCache();
    const cachedId = this.domainToIdCache.get(domain);
    if (cachedId) {
      return this.contextCache.get(cachedId) || null;
    }

    // Fall back to IndexedDB
    await this.ensureReady();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([CONTEXTS_STORE], "readonly");
      const store = transaction.objectStore(CONTEXTS_STORE);
      const index = store.index("domain");
      const request = index.get(domain);

      request.onsuccess = () => {
        const stored = request.result as StorableContext | undefined;
        if (stored) {
          const context = this.fromStorable(stored);
          // Update cache
          this.contextCache.set(context.id, context);
          this.domainToIdCache.set(context.domain, context.id);
          resolve(context);
        } else {
          resolve(null);
        }
      };

      request.onerror = () => {
        console.error(`[HappContextStorage] Failed to get context by domain:`, request.error);
        reject(request.error);
      };
    });
  }

  /**
   * List all contexts
   */
  async listContexts(): Promise<HappContext[]> {
    // Use cache
    await this.initializeCache();
    return Array.from(this.contextCache.values());
  }

  /**
   * Delete context by ID
   */
  async deleteContext(id: string): Promise<void> {
    await this.ensureReady();

    // Get domain before deleting (for cache cleanup)
    const context = this.contextCache.get(id);
    const domain = context?.domain;

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([CONTEXTS_STORE], "readwrite");
      const store = transaction.objectStore(CONTEXTS_STORE);
      const request = store.delete(id);

      request.onsuccess = () => {
        // Remove from cache
        this.contextCache.delete(id);
        if (domain) {
          this.domainToIdCache.delete(domain);
        }
        console.log(`[HappContextStorage] Deleted context ${id}`);
        resolve();
      };

      request.onerror = () => {
        console.error(`[HappContextStorage] Failed to delete context:`, request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Update last used timestamp for a context
   *
   * OPTIMIZED: Skip IndexedDB writes if updated recently.
   * The full context (with 1MB+ WASM) was taking 400-450ms to re-store just to update a timestamp.
   * Since lastUsed is just for "recently used" sorting, we only need to persist it occasionally.
   */
  async updateLastUsed(id: string): Promise<void> {
    const now = Date.now();
    const recentThreshold = 60000; // 60 seconds

    // Check if we updated recently (before modifying cache)
    const cached = this.contextCache.get(id);
    const previousLastUsed = cached?.lastUsed || 0;

    // Always update in-memory cache (fast)
    if (cached) {
      cached.lastUsed = now;
    }

    // Skip IndexedDB write if we updated recently
    // lastUsed is just for "recently used" sorting, not precise timing
    if (now - previousLastUsed < recentThreshold) {
      return;
    }

    // First update after threshold - persist to IndexedDB
    // This happens at most once per minute per context
    await this.ensureReady();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([CONTEXTS_STORE], "readwrite");
      const store = transaction.objectStore(CONTEXTS_STORE);
      const getRequest = store.get(id);

      getRequest.onsuccess = () => {
        const stored = getRequest.result as StorableContext | undefined;
        if (!stored) {
          // Context not found in DB but was in cache - just skip
          resolve();
          return;
        }

        // Only update the timestamp field
        stored.lastUsed = now;
        const putRequest = store.put(stored);

        putRequest.onsuccess = () => resolve();
        putRequest.onerror = () => reject(putRequest.error);
      };

      getRequest.onerror = () => reject(getRequest.error);
    });
  }

  /**
   * Store DNA WASM separately for deduplication
   */
  async putDnaWasm(hash: Uint8Array, wasm: Uint8Array): Promise<void> {
    await this.ensureReady();

    const hashKey = this.toBase64(hash);
    const entry: DnaWasmEntry = {
      hash: hashKey,
      wasm: Array.from(wasm),
      size: wasm.length,
      storedAt: Date.now(),
    };

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([DNA_WASM_STORE], "readwrite");
      const store = transaction.objectStore(DNA_WASM_STORE);
      const request = store.put(entry);

      request.onsuccess = () => {
        console.log(
          `[HappContextStorage] Stored DNA WASM (${wasm.length} bytes) with hash ${hashKey.substring(0, 16)}...`
        );
        resolve();
      };

      request.onerror = () => {
        console.error(`[HappContextStorage] Failed to store DNA WASM:`, request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Get DNA WASM by hash
   */
  async getDnaWasm(hash: Uint8Array): Promise<Uint8Array | null> {
    await this.ensureReady();

    const hashKey = this.toBase64(hash);

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([DNA_WASM_STORE], "readonly");
      const store = transaction.objectStore(DNA_WASM_STORE);
      const request = store.get(hashKey);

      request.onsuccess = () => {
        const entry = request.result as DnaWasmEntry | undefined;
        resolve(entry ? new Uint8Array(entry.wasm) : null);
      };

      request.onerror = () => {
        console.error(`[HappContextStorage] Failed to get DNA WASM:`, request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Delete DNA WASM by hash
   */
  async deleteDnaWasm(hash: Uint8Array): Promise<void> {
    await this.ensureReady();

    const hashKey = this.toBase64(hash);

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([DNA_WASM_STORE], "readwrite");
      const store = transaction.objectStore(DNA_WASM_STORE);
      const request = store.delete(hashKey);

      request.onsuccess = () => {
        console.log(`[HappContextStorage] Deleted DNA WASM ${hashKey.substring(0, 16)}...`);
        resolve();
      };

      request.onerror = () => {
        console.error(`[HappContextStorage] Failed to delete DNA WASM:`, request.error);
        reject(request.error);
      };
    });
  }

  /**
   * Clear all data (for testing)
   */
  async clear(): Promise<void> {
    await this.ensureReady();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([CONTEXTS_STORE, DNA_WASM_STORE], "readwrite");

      const contextsStore = transaction.objectStore(CONTEXTS_STORE);
      const dnaWasmStore = transaction.objectStore(DNA_WASM_STORE);

      const clearContexts = contextsStore.clear();
      const clearDnaWasm = dnaWasmStore.clear();

      transaction.oncomplete = () => {
        // Clear cache
        this.contextCache.clear();
        this.domainToIdCache.clear();
        this.cacheInitialized = false;
        console.log("[HappContextStorage] Cleared all data");
        resolve();
      };

      transaction.onerror = () => {
        console.error("[HappContextStorage] Failed to clear data:", transaction.error);
        reject(transaction.error);
      };
    });
  }
}

// Singleton instance
let instance: HappContextStorage | null = null;

/**
 * Get singleton instance of HappContextStorage
 */
export function getHappContextStorage(): HappContextStorage {
  if (!instance) {
    instance = new HappContextStorage();
  }
  return instance;
}
