/**
 * Types for Lair keystore implementation
 * Based on lair_keystore_api types
 */

/**
 * A tag identifying a key entry in the keystore
 */
export type EntryTag = string;

/**
 * Ed25519 public key (32 bytes)
 */
export type Ed25519PubKey = Uint8Array;

/**
 * Ed25519 signature (64 bytes)
 */
export type Ed25519Signature = Uint8Array;

/**
 * X25519 public key for encryption (32 bytes)
 */
export type X25519PubKey = Uint8Array;

/**
 * Encrypted data from crypto_box
 */
export type EncryptedData = Uint8Array;

/**
 * Nonce for encryption (24 bytes for XSalsa20)
 */
export type Nonce = Uint8Array;

/**
 * Key derivation path (e.g., "m/0/1/2")
 */
export type DerivationPath = string | number[];

/**
 * Entry information for a key in the keystore
 */
export interface EntryInfo {
  /** Unique tag for this entry */
  tag: EntryTag;

  /** Ed25519 public key for signing */
  ed25519_pub_key: Ed25519PubKey;

  /** X25519 public key for encryption (derived from Ed25519) */
  x25519_pub_key: X25519PubKey;

  /** When this entry was created */
  created_at: number;

  /** Whether this key can be exported */
  exportable: boolean;
}

/**
 * Result of creating a new seed
 */
export interface NewSeedResult {
  /** The tag for the new entry */
  tag: EntryTag;

  /** Entry information */
  entry_info: EntryInfo;
}

/**
 * Lair keystore client interface
 */
export interface LairClient {
  /**
   * Generate a new seed/keypair
   * @param tag - Unique tag for this key
   * @param exportable - Whether this key can be exported
   */
  newSeed(tag: EntryTag, exportable?: boolean): Promise<NewSeedResult>;

  /**
   * Get entry information by tag
   * @param tag - The tag to look up
   */
  getEntry(tag: EntryTag): Promise<EntryInfo | null>;

  /**
   * List all entries in the keystore
   */
  listEntries(): Promise<EntryInfo[]>;

  /**
   * Sign data with a key identified by its public key
   * @param pub_key - The Ed25519 public key
   * @param data - Data to sign
   */
  signByPubKey(pub_key: Ed25519PubKey, data: Uint8Array): Promise<Ed25519Signature>;

  /**
   * Derive a new seed from an existing one
   * @param source_tag - Tag of the source key
   * @param derivation_path - Path for derivation
   * @param dest_tag - Tag for the derived key
   * @param exportable - Whether the derived key can be exported
   */
  deriveSeed(
    source_tag: EntryTag,
    derivation_path: DerivationPath,
    dest_tag: EntryTag,
    exportable?: boolean
  ): Promise<NewSeedResult>;

  /**
   * Encrypt data using crypto_box (asymmetric encryption)
   * @param recipient_pub_key - Recipient's X25519 public key
   * @param sender_pub_key - Sender's Ed25519 public key (for signing)
   * @param data - Data to encrypt
   */
  cryptoBoxByPubKey(
    recipient_pub_key: X25519PubKey,
    sender_pub_key: Ed25519PubKey,
    data: Uint8Array
  ): Promise<{ nonce: Nonce; cipher: EncryptedData }>;

  /**
   * Decrypt data using crypto_box
   * @param sender_pub_key - Sender's X25519 public key
   * @param recipient_pub_key - Recipient's Ed25519 public key (our key)
   * @param nonce - Nonce used for encryption
   * @param cipher - Encrypted data
   */
  cryptoBoxOpenByPubKey(
    sender_pub_key: X25519PubKey,
    recipient_pub_key: Ed25519PubKey,
    nonce: Nonce,
    cipher: EncryptedData
  ): Promise<Uint8Array>;

  /**
   * Encrypt data using secret_box (symmetric encryption)
   * @param tag - Tag of the key to use
   * @param data - Data to encrypt
   */
  secretBoxByTag(
    tag: EntryTag,
    data: Uint8Array
  ): Promise<{ nonce: Nonce; cipher: EncryptedData }>;

  /**
   * Decrypt data using secret_box
   * @param tag - Tag of the key to use
   * @param nonce - Nonce used for encryption
   * @param cipher - Encrypted data
   */
  secretBoxOpenByTag(
    tag: EntryTag,
    nonce: Nonce,
    cipher: EncryptedData
  ): Promise<Uint8Array>;
}

/**
 * Stored key entry (includes private key material)
 * This is stored in IndexedDB
 */
export interface StoredKeyEntry {
  /** Entry information (public data) */
  info: EntryInfo;

  /** Ed25519 seed (32 bytes of secret key material) */
  seed: Uint8Array;
}
