/**
 * @holo-host/lair - Lair keystore implementation
 *
 * Cryptographic key management for Holochain applications.
 * Works in browsers (IndexedDB), Node.js servers (MemoryKeyStorage),
 * Cloudflare Workers, and Electron apps.
 *
 * Features:
 * - Ed25519 key generation and signing
 * - X25519 encryption/decryption (crypto_box)
 * - Symmetric encryption (secret_box)
 * - Key derivation (hierarchical deterministic keys)
 * - Pluggable storage backends (IndexedDB, in-memory)
 * - Full libsodium compatibility
 */

// Export types
export type {
  EntryTag,
  Ed25519PubKey,
  Ed25519Signature,
  X25519PubKey,
  EncryptedData,
  Nonce,
  DerivationPath,
  EntryInfo,
  NewSeedResult,
  EncryptedExport,
  LairClient as ILairClient,
  StoredKeyEntry,
} from "./types.js";

// Export storage
export type { KeyStorage } from "./storage.js";
export { IndexedDBKeyStorage, createKeyStorage } from "./storage.js";
export { MemoryKeyStorage } from "./memory-storage.js";
export { EncryptedKeyStorage } from "./encrypted-storage.js";

// Export client
export { LairClient, createLairClient } from "./client.js";

// Export seed utilities (for loading keys from external sources)
export { seedToStoredEntry, hexToSeed } from "./seed-utils.js";

// Export mnemonic (seed phrase backup/recovery)
export { seedToMnemonic, mnemonicToSeed, isValidMnemonic } from "./mnemonic.js";

export const VERSION = "0.1.0";
