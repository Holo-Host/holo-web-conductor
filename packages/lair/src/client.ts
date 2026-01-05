/**
 * Lair keystore client implementation
 *
 * Provides key management and cryptographic operations using libsodium
 */

import sodium from "libsodium-wrappers";
import type {
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
import type { KeyStorage } from "./storage";
import { createKeyStorage } from "./storage";

/**
 * Cached key for synchronous signing
 */
interface PreloadedKey {
  pubKey: Ed25519PubKey;
  privateKey: Uint8Array; // 64-byte Ed25519 private key
}

/**
 * Lair keystore client implementation
 */
export class LairClient implements ILairClient {
  private storage!: KeyStorage; // Initialized in async initialize()
  private ready: Promise<void>;
  private preloadedKeys: Map<string, PreloadedKey> = new Map();

  constructor(storage?: KeyStorage) {
    // Initialize libsodium and storage
    this.ready = this.initialize(storage);
  }

  private async initialize(storage?: KeyStorage): Promise<void> {
    // Wait for libsodium to be ready
    await sodium.ready;

    // Initialize storage
    this.storage = storage || (await createKeyStorage());
  }

  /**
   * Ensure the client is ready before operations
   */
  private async ensureReady(): Promise<void> {
    await this.ready;
  }

  /**
   * Convert pubKey to string for Map lookup
   */
  private pubKeyToString(pubKey: Ed25519PubKey): string {
    return Array.from(pubKey).join(",");
  }

  /**
   * Generate a new seed/keypair
   */
  async newSeed(tag: EntryTag, exportable: boolean = false): Promise<NewSeedResult> {
    await this.ensureReady();

    // Check if tag already exists
    if (await this.storage.hasEntry(tag)) {
      throw new Error(`Entry with tag "${tag}" already exists`);
    }

    // Generate Ed25519 keypair
    const keypair = sodium.crypto_sign_keypair();

    // Convert signing key to X25519 for encryption
    const x25519_pub_key = sodium.crypto_sign_ed25519_pk_to_curve25519(
      keypair.publicKey
    );

    const entry_info: EntryInfo = {
      tag,
      ed25519_pub_key: keypair.publicKey,
      x25519_pub_key,
      created_at: Date.now(),
      exportable,
    };

    const stored_entry: StoredKeyEntry = {
      info: entry_info,
      seed: keypair.privateKey,
    };

    await this.storage.putEntry(stored_entry);

    return {
      tag,
      entry_info,
    };
  }

  /**
   * Get entry information by tag
   */
  async getEntry(tag: EntryTag): Promise<EntryInfo | null> {
    await this.ensureReady();
    return this.storage.getEntryInfo(tag);
  }

  /**
   * List all entries in the keystore
   */
  async listEntries(): Promise<EntryInfo[]> {
    await this.ensureReady();
    return this.storage.listEntries();
  }

  /**
   * Sign data with a key identified by its public key
   */
  async signByPubKey(
    pub_key: Ed25519PubKey,
    data: Uint8Array
  ): Promise<Ed25519Signature> {
    await this.ensureReady();

    // Validate key length - must be raw 32-byte Ed25519 key
    if (pub_key.length !== 32) {
      throw new Error(`Invalid public key length: ${pub_key.length} (expected 32-byte Ed25519 key)`);
    }

    // Find the entry with this public key
    const entries = await this.storage.listEntries();
    const entry_info = entries.find((info) =>
      sodium.memcmp(info.ed25519_pub_key, pub_key)
    );

    if (!entry_info) {
      throw new Error("Public key not found in keystore");
    }

    // Get the full entry with private key
    const entry = await this.storage.getEntry(entry_info.tag);
    if (!entry) {
      throw new Error("Entry not found");
    }

    // Sign the data
    const signature = sodium.crypto_sign_detached(data, entry.seed);

    return signature;
  }

  /**
   * Preload a key into memory for synchronous signing
   */
  async preloadKeyForSync(pub_key: Ed25519PubKey): Promise<void> {
    await this.ensureReady();

    if (pub_key.length !== 32) {
      throw new Error(`Invalid public key length: ${pub_key.length} (expected 32)`);
    }

    // Find the entry with this public key
    const entries = await this.storage.listEntries();
    const entry_info = entries.find((info) =>
      sodium.memcmp(info.ed25519_pub_key, pub_key)
    );

    if (!entry_info) {
      throw new Error("Public key not found in keystore");
    }

    // Get the full entry with private key
    const entry = await this.storage.getEntry(entry_info.tag);
    if (!entry) {
      throw new Error("Entry not found");
    }

    // Cache the key for sync access
    const key = this.pubKeyToString(pub_key);
    this.preloadedKeys.set(key, {
      pubKey: new Uint8Array(pub_key),
      privateKey: new Uint8Array(entry.seed),
    });
  }

  /**
   * Sign data synchronously using a preloaded key
   */
  signSync(pub_key: Ed25519PubKey, data: Uint8Array): Ed25519Signature {
    const key = this.pubKeyToString(pub_key);
    const cached = this.preloadedKeys.get(key);

    if (!cached) {
      throw new Error(
        "Key not preloaded. Call preloadKeyForSync() before WASM execution."
      );
    }

    return sodium.crypto_sign_detached(data, cached.privateKey);
  }

  /**
   * Check if a key is preloaded for sync signing
   */
  hasPreloadedKey(pub_key: Ed25519PubKey): boolean {
    return this.preloadedKeys.has(this.pubKeyToString(pub_key));
  }

  /**
   * Clear a preloaded key from memory
   */
  clearPreloadedKey(pub_key: Ed25519PubKey): void {
    const key = this.pubKeyToString(pub_key);
    const cached = this.preloadedKeys.get(key);
    if (cached) {
      // Zero out private key before deleting
      cached.privateKey.fill(0);
      this.preloadedKeys.delete(key);
    }
  }

  /**
   * Clear all preloaded keys from memory
   */
  clearAllPreloadedKeys(): void {
    for (const cached of this.preloadedKeys.values()) {
      cached.privateKey.fill(0);
    }
    this.preloadedKeys.clear();
  }

  /**
   * Derive a new seed from an existing one
   */
  async deriveSeed(
    source_tag: EntryTag,
    derivation_path: DerivationPath,
    dest_tag: EntryTag,
    exportable: boolean = false
  ): Promise<NewSeedResult> {
    await this.ensureReady();

    // Check if dest_tag already exists
    if (await this.storage.hasEntry(dest_tag)) {
      throw new Error(`Entry with tag "${dest_tag}" already exists`);
    }

    // Get source entry
    const source_entry = await this.storage.getEntry(source_tag);
    if (!source_entry) {
      throw new Error(`Source tag "${source_tag}" not found`);
    }

    // Normalize derivation path to array of numbers
    const path_indices = this.normalizePath(derivation_path);

    // Derive new seed using KDF
    // For each index in the path, derive a new seed
    // Extract the Ed25519 seed (first 32 bytes of the private key)
    let current_seed = new Uint8Array(source_entry.seed.slice(0, 32));

    // Ensure the seed is exactly 32 bytes for KDF
    if (current_seed.length !== 32) {
      throw new Error("Invalid seed length for derivation");
    }

    for (const index of path_indices) {
      // Use crypto_kdf to derive child seed
      const context = "LairDerv"; // 8-byte context
      const subkey_id = index;

      // Derive 32 bytes for the new seed
      current_seed = new Uint8Array(
        sodium.crypto_kdf_derive_from_key(
          32, // subkey length
          subkey_id,
          context,
          current_seed
        )
      );
    }

    // Generate keypair from derived seed
    const keypair = sodium.crypto_sign_seed_keypair(current_seed);

    // Convert to X25519
    const x25519_pub_key = sodium.crypto_sign_ed25519_pk_to_curve25519(
      keypair.publicKey
    );

    const entry_info: EntryInfo = {
      tag: dest_tag,
      ed25519_pub_key: keypair.publicKey,
      x25519_pub_key,
      created_at: Date.now(),
      exportable,
    };

    const stored_entry: StoredKeyEntry = {
      info: entry_info,
      seed: keypair.privateKey,
    };

    await this.storage.putEntry(stored_entry);

    return {
      tag: dest_tag,
      entry_info,
    };
  }

  /**
   * Encrypt data using crypto_box (asymmetric encryption)
   */
  async cryptoBoxByPubKey(
    recipient_pub_key: X25519PubKey,
    sender_pub_key: Ed25519PubKey,
    data: Uint8Array
  ): Promise<{ nonce: Nonce; cipher: EncryptedData }> {
    await this.ensureReady();

    // Find sender's entry
    const entries = await this.storage.listEntries();
    const sender_info = entries.find((info) =>
      sodium.memcmp(info.ed25519_pub_key, sender_pub_key)
    );

    if (!sender_info) {
      throw new Error("Sender public key not found in keystore");
    }

    const sender_entry = await this.storage.getEntry(sender_info.tag);
    if (!sender_entry) {
      throw new Error("Sender entry not found");
    }

    // Convert sender's Ed25519 private key to X25519
    const sender_x25519_secret = sodium.crypto_sign_ed25519_sk_to_curve25519(
      sender_entry.seed
    );

    // Generate nonce
    const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);

    // Encrypt
    const cipher = sodium.crypto_box_easy(
      data,
      nonce,
      recipient_pub_key,
      sender_x25519_secret
    );

    // Zero out the secret key from memory
    sodium.memzero(sender_x25519_secret);

    return { nonce, cipher };
  }

  /**
   * Decrypt data using crypto_box
   */
  async cryptoBoxOpenByPubKey(
    sender_pub_key: X25519PubKey,
    recipient_pub_key: Ed25519PubKey,
    nonce: Nonce,
    cipher: EncryptedData
  ): Promise<Uint8Array> {
    await this.ensureReady();

    // Find recipient's entry
    const entries = await this.storage.listEntries();
    const recipient_info = entries.find((info) =>
      sodium.memcmp(info.ed25519_pub_key, recipient_pub_key)
    );

    if (!recipient_info) {
      throw new Error("Recipient public key not found in keystore");
    }

    const recipient_entry = await this.storage.getEntry(recipient_info.tag);
    if (!recipient_entry) {
      throw new Error("Recipient entry not found");
    }

    // Convert recipient's Ed25519 private key to X25519
    const recipient_x25519_secret = sodium.crypto_sign_ed25519_sk_to_curve25519(
      recipient_entry.seed
    );

    // Decrypt
    const decrypted = sodium.crypto_box_open_easy(
      cipher,
      nonce,
      sender_pub_key,
      recipient_x25519_secret
    );

    // Zero out the secret key from memory
    sodium.memzero(recipient_x25519_secret);

    return decrypted;
  }

  /**
   * Encrypt data using secret_box (symmetric encryption)
   */
  async secretBoxByTag(
    tag: EntryTag,
    data: Uint8Array
  ): Promise<{ nonce: Nonce; cipher: EncryptedData }> {
    await this.ensureReady();

    const entry = await this.storage.getEntry(tag);
    if (!entry) {
      throw new Error(`Tag "${tag}" not found`);
    }

    // Use first 32 bytes of seed as symmetric key
    const key = new Uint8Array(entry.seed.slice(0, sodium.crypto_secretbox_KEYBYTES));

    // Generate nonce
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);

    // Encrypt
    const cipher = sodium.crypto_secretbox_easy(data, nonce, key);

    return { nonce, cipher };
  }

  /**
   * Decrypt data using secret_box
   */
  async secretBoxOpenByTag(
    tag: EntryTag,
    nonce: Nonce,
    cipher: EncryptedData
  ): Promise<Uint8Array> {
    await this.ensureReady();

    const entry = await this.storage.getEntry(tag);
    if (!entry) {
      throw new Error(`Tag "${tag}" not found`);
    }

    // Use first 32 bytes of seed as symmetric key
    const key = new Uint8Array(entry.seed.slice(0, sodium.crypto_secretbox_KEYBYTES));

    // Decrypt
    const decrypted = sodium.crypto_secretbox_open_easy(cipher, nonce, key);

    return decrypted;
  }

  /**
   * Export a seed encrypted with a passphrase
   */
  async exportSeedByTag(tag: EntryTag, passphrase: string): Promise<EncryptedExport> {
    await this.ensureReady();

    const entry = await this.storage.getEntry(tag);
    if (!entry) {
      throw new Error(`Tag "${tag}" not found`);
    }

    // Enforce exportable flag
    if (!entry.info.exportable) {
      throw new Error(`Key "${tag}" is not exportable`);
    }

    if (!passphrase || passphrase.length < 8) {
      throw new Error("Passphrase must be at least 8 characters");
    }

    // Generate salt for key derivation
    const salt = sodium.randombytes_buf(16);

    // Derive encryption key from passphrase using PBKDF2 (Web Crypto API)
    const encoder = new TextEncoder();
    const passphraseBytes = encoder.encode(passphrase);

    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      passphraseBytes,
      "PBKDF2",
      false,
      ["deriveBits"]
    );

    const keyBuffer = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: salt as BufferSource,
        iterations: 100000,
        hash: "SHA-256",
      },
      keyMaterial,
      256
    );

    const key = new Uint8Array(keyBuffer);

    // Generate nonce
    const nonce = sodium.randombytes_buf(24);

    // Encrypt the seed (first 32 bytes)
    const seedToEncrypt = entry.seed.slice(0, 32);
    const cipher = sodium.crypto_secretbox_easy(seedToEncrypt, nonce, key);

    return {
      version: 1,
      tag: entry.info.tag,
      ed25519_pub_key: entry.info.ed25519_pub_key,
      x25519_pub_key: entry.info.x25519_pub_key,
      salt,
      nonce,
      cipher,
      exportable: entry.info.exportable,
      created_at: entry.info.created_at,
    };
  }

  /**
   * Import an encrypted seed
   */
  async importSeed(
    encrypted: EncryptedExport,
    passphrase: string,
    newTag: EntryTag,
    exportable: boolean
  ): Promise<NewSeedResult> {
    await this.ensureReady();

    // Check if newTag already exists
    if (await this.storage.hasEntry(newTag)) {
      throw new Error(`Entry with tag "${newTag}" already exists`);
    }

    if (!passphrase || passphrase.length < 8) {
      throw new Error("Passphrase must be at least 8 characters");
    }

    // Derive decryption key from passphrase using PBKDF2 (Web Crypto API)
    const encoder = new TextEncoder();
    const passphraseBytes = encoder.encode(passphrase);

    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      passphraseBytes,
      "PBKDF2",
      false,
      ["deriveBits"]
    );

    const keyBuffer = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: encrypted.salt as BufferSource,
        iterations: 100000,
        hash: "SHA-256",
      },
      keyMaterial,
      256
    );

    const key = new Uint8Array(keyBuffer);

    // Decrypt the seed
    let seed: Uint8Array;
    try {
      seed = sodium.crypto_secretbox_open_easy(
        encrypted.cipher,
        encrypted.nonce,
        key
      );
    } catch (error) {
      throw new Error("Failed to decrypt: incorrect passphrase or corrupted data");
    }

    // Regenerate keypair from seed
    const keypair = sodium.crypto_sign_seed_keypair(seed);

    // Verify the public key matches
    if (!sodium.memcmp(keypair.publicKey, encrypted.ed25519_pub_key)) {
      throw new Error("Decrypted seed does not match expected public key");
    }

    // Convert to X25519
    const x25519_pub_key = sodium.crypto_sign_ed25519_pk_to_curve25519(
      keypair.publicKey
    );

    const entry_info: EntryInfo = {
      tag: newTag,
      ed25519_pub_key: keypair.publicKey,
      x25519_pub_key,
      created_at: Date.now(),
      exportable,
    };

    const stored_entry: StoredKeyEntry = {
      info: entry_info,
      seed: keypair.privateKey,
    };

    await this.storage.putEntry(stored_entry);

    return {
      tag: newTag,
      entry_info,
    };
  }

  /**
   * Delete an entry from the keystore
   */
  async deleteEntry(tag: EntryTag): Promise<void> {
    await this.ensureReady();
    await this.storage.deleteEntry(tag);
  }

  /**
   * Normalize derivation path to array of indices
   */
  private normalizePath(path: DerivationPath): number[] {
    if (Array.isArray(path)) {
      return path;
    }

    // Parse string path like "m/0/1/2" or "0/1/2"
    const parts = path.replace(/^m\//, "").split("/");
    return parts.map((part) => {
      const num = parseInt(part, 10);
      if (isNaN(num) || num < 0) {
        throw new Error(`Invalid derivation path: ${path}`);
      }
      return num;
    });
  }
}

/**
 * Create a new Lair client instance
 */
export async function createLairClient(storage?: KeyStorage): Promise<LairClient> {
  const client = new LairClient(storage);
  await client["ready"]; // Wait for initialization
  return client;
}
