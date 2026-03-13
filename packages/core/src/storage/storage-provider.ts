/**
 * Storage Provider Abstraction
 *
 * Provides a common interface for storage implementations:
 * - DirectSQLiteStorage (ribosome-worker.ts): Production -- SQLite WASM in browser
 * - SourceChainStorage: Test only -- IndexedDB via fake-indexeddb in vitest
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
import type { EntryHash, ActionHash, DnaHash, AgentPubKey, AnyDhtHash } from '@holochain/client';

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
  getChainHead(dnaHash: DnaHash, agentPubKey: AgentPubKey): ChainHead | null;
  updateChainHead(
    dnaHash: DnaHash,
    agentPubKey: AgentPubKey,
    actionSeq: number,
    actionHash: ActionHash,
    timestamp: bigint
  ): void;

  // Action operations (sync)
  putAction(action: Action, dnaHash: DnaHash, agentPubKey: AgentPubKey): void;
  getAction(actionHash: ActionHash): Action | null;
  queryActions(
    dnaHash: DnaHash,
    agentPubKey: AgentPubKey,
    filter?: { actionType?: string }
  ): Action[];
  getActionByEntryHash(entryHash: EntryHash): Action | null;

  // Entry operations (sync)
  putEntry(entry: StoredEntry, dnaHash: DnaHash, agentPubKey: AgentPubKey): void;
  getEntry(entryHash: EntryHash): StoredEntry | null;

  // Record operations (sync)
  getRecord(actionHash: ActionHash): StoredRecord | null;
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
  putLink(link: Link, dnaHash: DnaHash, agentPubKey: AgentPubKey): void;
  getLinks(
    baseAddress: AnyDhtHash,
    dnaHash: DnaHash,
    agentPubKey: AgentPubKey,
    linkType?: number
  ): Link[];
  deleteLink(createLinkHash: ActionHash, deleteHash: ActionHash): void;

  // Pre-loading (optional - only needed for IndexedDB implementation)
  preloadChainForCell?(dnaHash: DnaHash, agentPubKey: AgentPubKey): Promise<void>;

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
 * - Browser extension: ribosome-worker.ts sets DirectSQLiteStorage
 * - Tests: ribosome/index.ts auto-falls back to SourceChainStorage (IndexedDB)
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
