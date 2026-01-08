/**
 * Storage Provider Abstraction
 *
 * Provides a common interface for storage implementations:
 * - SourceChainStorage: IndexedDB-based, uses pre-loading and session cache
 * - SQLiteStorage: SQLite WASM-based, fully synchronous with OPFS persistence
 *
 * This abstraction allows switching between implementations without changing
 * ribosome or host function code.
 */

import type {
  Action,
  StoredEntry,
  StoredRecord,
  ChainHead,
  Link,
  RecordDetails,
  EntryDetails,
} from './types';
import type { EntryHash, ActionHash, DnaHash, AgentPubKey } from '@holochain/client';

/**
 * Storage provider interface
 *
 * All methods that may need synchronous access during WASM execution
 * return the value directly (not a Promise).
 */
export interface StorageProvider {
  // Initialization (async - called before WASM execution)
  init(): Promise<void>;

  // Transaction management (sync)
  beginTransaction(): void;
  commitTransaction(): void | Promise<void>;
  rollbackTransaction(): void;
  isTransactionActive(): boolean;

  // Chain head operations (sync)
  getChainHead(dnaHash: Uint8Array, agentPubKey: Uint8Array): ChainHead | null;
  updateChainHead(
    dnaHash: Uint8Array,
    agentPubKey: Uint8Array,
    actionSeq: number,
    actionHash: Uint8Array,
    timestamp: bigint
  ): void;

  // Action operations (sync)
  putAction(action: Action, dnaHash: Uint8Array, agentPubKey: Uint8Array): void;
  getAction(actionHash: Uint8Array): Action | null;
  queryActions(
    dnaHash: Uint8Array,
    agentPubKey: Uint8Array,
    filter?: { actionType?: string }
  ): Action[];
  getActionByEntryHash(entryHash: Uint8Array): Action | null;

  // Entry operations (sync)
  putEntry(entry: StoredEntry, dnaHash: Uint8Array, agentPubKey: Uint8Array): void;
  getEntry(entryHash: Uint8Array): StoredEntry | null;

  // Record operations (sync)
  getRecord(actionHash: Uint8Array): StoredRecord | null;
  /** Get details for an entry hash (returns RecordDetails for backward compat) */
  getDetails(
    entryHash: EntryHash,
    dnaHash: DnaHash,
    agentPubKey: AgentPubKey
  ): RecordDetails | null;
  /** Get entry details when querying by entry hash (for Details::Entry response) */
  getEntryDetails(
    entryHash: EntryHash,
    dnaHash: DnaHash,
    agentPubKey: AgentPubKey
  ): EntryDetails | null;

  // Link operations (sync)
  putLink(link: Link, dnaHash: Uint8Array, agentPubKey: Uint8Array): void;
  getLinks(
    baseAddress: Uint8Array,
    dnaHash: Uint8Array,
    agentPubKey: Uint8Array,
    linkType?: number
  ): Link[];
  deleteLink(createLinkHash: Uint8Array, deleteHash: Uint8Array): void;

  // Pre-loading (optional - only needed for IndexedDB implementation)
  preloadChainForCell?(dnaHash: Uint8Array, agentPubKey: Uint8Array): Promise<void>;

  // Utility
  clear(): void | Promise<void>;
}

/**
 * Global storage provider instance
 */
let storageProvider: StorageProvider | null = null;

/**
 * Set the storage provider to use
 *
 * Call this during initialization:
 * - In browser: setStorageProvider(sqliteStorage) after worker init
 * - In tests: setStorageProvider(sourceChainStorage) in setup
 */
export function setStorageProvider(provider: StorageProvider): void {
  storageProvider = provider;
  console.log('[StorageProvider] Set storage provider:', provider.constructor.name);
}

/**
 * Get the current storage provider
 *
 * @throws Error if no provider has been set
 */
export function getStorageProvider(): StorageProvider {
  if (!storageProvider) {
    throw new Error('[StorageProvider] No storage provider set. Call setStorageProvider() first.');
  }
  return storageProvider;
}

/**
 * Check if a storage provider has been set
 */
export function hasStorageProvider(): boolean {
  return storageProvider !== null;
}

/**
 * Clear the storage provider (for testing)
 */
export function clearStorageProvider(): void {
  storageProvider = null;
}
