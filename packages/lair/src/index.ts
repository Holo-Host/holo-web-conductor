/**
 * @fishy/lair - Browser-based Lair keystore implementation
 *
 * This package provides key management functionality mirroring
 * the Lair keystore for use in browser environments.
 *
 * Features:
 * - Ed25519 key generation and signing
 * - X25519 encryption/decryption (crypto_box)
 * - Symmetric encryption (secret_box)
 * - Key derivation (hierarchical deterministic keys)
 * - IndexedDB persistence
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
} from "./types";

// Export storage
export type { KeyStorage } from "./storage";
export { IndexedDBKeyStorage, createKeyStorage } from "./storage";

// Export client
export { LairClient, createLairClient } from "./client";

export const VERSION = "0.0.1";
