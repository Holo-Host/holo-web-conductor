/**
 * Encrypted storage decorator for KeyStorage
 *
 * Wraps any KeyStorage implementation to optionally encrypt seed material
 * at rest. Three states:
 *
 *   1. No passphrase set (encryptionEnabled=false) — all operations pass
 *      through to the inner storage unencrypted. Identical to pre-security
 *      behavior.
 *   2. Passphrase set + unlocked (encryptionEnabled=true, masterKey set) —
 *      putEntry encrypts, getEntry decrypts.
 *   3. Passphrase set + locked (encryptionEnabled=true, masterKey null) —
 *      putEntry/getEntry throw "Storage is locked". Info-only operations
 *      (listEntries, getEntryInfo, hasEntry) still work.
 *
 * Encryption uses XSalsa20-Poly1305 (crypto_secretbox) with a per-entry
 * random nonce prepended to the ciphertext.
 *
 * Wire format for the seed field:
 *   [magic (4 bytes, "ENC\x01")] [nonce (24 bytes)] [ciphertext (seed_len + 16 MAC bytes)]
 */

import sodium from "libsodium-wrappers";
import type { EntryTag, EntryInfo, StoredKeyEntry } from "./types.js";
import type { KeyStorage } from "./storage.js";

/**
 * 4-byte magic header for encrypted seeds. Chosen to be extremely unlikely
 * to appear at the start of a random Ed25519 seed (1 in ~4 billion).
 * ASCII: "ENC\x01" — human-readable prefix plus version byte.
 */
const ENCRYPTED_MAGIC = new Uint8Array([0x45, 0x4e, 0x43, 0x01]); // "ENC\x01"
const MAGIC_LEN = ENCRYPTED_MAGIC.length;
const NONCE_LEN = 24; // crypto_secretbox_NONCEBYTES
const MAC_LEN = 16; // crypto_secretbox_MACBYTES

/**
 * Runtime guard — narrows libsodium's string | Uint8Array return to Uint8Array.
 */
function asBytes(value: string | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new Error("Expected Uint8Array from libsodium, got string");
}

export class EncryptedKeyStorage implements KeyStorage {
  private inner: KeyStorage;
  private masterKey: Uint8Array | null = null;
  /**
   * Tracks whether encryption has been activated (a passphrase was set).
   * When false, all operations pass through to inner storage unencrypted.
   * When true, putEntry encrypts and getEntry decrypts — and both require
   * the master key to be present (i.e. the keystore must be unlocked).
   */
  private encryptionEnabled = false;

  constructor(inner: KeyStorage) {
    this.inner = inner;
  }

  /**
   * Enable encryption and set the master key (called when passphrase is set).
   * Once enabled, encryption stays enabled even after lock/clearMasterKey.
   */
  setMasterKey(key: Uint8Array): void {
    this.masterKey = new Uint8Array(key);
    this.encryptionEnabled = true;
  }

  /** Wipe and clear the master encryption key (called on lock). */
  clearMasterKey(): void {
    if (this.masterKey) {
      this.masterKey.fill(0);
      this.masterKey = null;
    }
    // encryptionEnabled stays true — seeds are encrypted on disk
  }

  /** Check if a master key is currently set (i.e. unlocked). */
  hasMasterKey(): boolean {
    return this.masterKey !== null;
  }

  /** Check if encryption has been enabled (passphrase was set at some point). */
  isEncryptionEnabled(): boolean {
    return this.encryptionEnabled;
  }

  async init(): Promise<void> {
    await sodium.ready;
    return this.inner.init();
  }

  async putEntry(entry: StoredKeyEntry): Promise<void> {
    // No passphrase set — store plaintext (pre-security behavior)
    if (!this.encryptionEnabled) {
      return this.inner.putEntry(entry);
    }

    if (!this.masterKey) throw new Error("Storage is locked");

    const nonce = asBytes(sodium.randombytes_buf(NONCE_LEN));
    const cipher = asBytes(
      sodium.crypto_secretbox_easy(entry.seed, nonce, this.masterKey)
    );

    // Prepend magic header and nonce to ciphertext
    const encryptedSeed = new Uint8Array(MAGIC_LEN + NONCE_LEN + cipher.length);
    encryptedSeed.set(ENCRYPTED_MAGIC, 0);
    encryptedSeed.set(nonce, MAGIC_LEN);
    encryptedSeed.set(cipher, MAGIC_LEN + NONCE_LEN);

    await this.inner.putEntry({
      info: entry.info,
      seed: encryptedSeed,
    });
  }

  async getEntry(tag: EntryTag): Promise<StoredKeyEntry | null> {
    // No passphrase set — read plaintext directly
    if (!this.encryptionEnabled) {
      return this.inner.getEntry(tag);
    }

    if (!this.masterKey) throw new Error("Storage is locked");

    const stored = await this.inner.getEntry(tag);
    if (!stored) return null;

    const seed = this.decryptSeed(stored.seed);
    return { info: stored.info, seed };
  }

  /** Get entry info without decrypting the seed. Does not require master key. */
  async getEntryInfo(tag: EntryTag): Promise<EntryInfo | null> {
    return this.inner.getEntryInfo(tag);
  }

  /** List all entries (info only). Does not require master key. */
  async listEntries(): Promise<EntryInfo[]> {
    return this.inner.listEntries();
  }

  /** Check if a tag exists. Does not require master key. */
  async hasEntry(tag: EntryTag): Promise<boolean> {
    return this.inner.hasEntry(tag);
  }

  async deleteEntry(tag: EntryTag): Promise<void> {
    return this.inner.deleteEntry(tag);
  }

  async clear(): Promise<void> {
    return this.inner.clear();
  }

  /**
   * Migrate all plaintext seeds to encrypted form.
   * Call this after first setPassphrase or after unlock when migration is needed.
   * Returns the number of entries migrated.
   */
  async migrateToEncrypted(): Promise<number> {
    if (!this.masterKey) throw new Error("Storage is locked");

    const infos = await this.inner.listEntries();
    let migrated = 0;

    for (const info of infos) {
      const entry = await this.inner.getEntry(info.tag);
      if (!entry) continue;

      if (this.isPlaintext(entry.seed)) {
        // Encrypt and re-store
        const nonce = asBytes(sodium.randombytes_buf(NONCE_LEN));
        const cipher = asBytes(
          sodium.crypto_secretbox_easy(entry.seed, nonce, this.masterKey)
        );

        const encryptedSeed = new Uint8Array(MAGIC_LEN + NONCE_LEN + cipher.length);
        encryptedSeed.set(ENCRYPTED_MAGIC, 0);
        encryptedSeed.set(nonce, MAGIC_LEN);
        encryptedSeed.set(cipher, MAGIC_LEN + NONCE_LEN);

        await this.inner.putEntry({
          info: entry.info,
          seed: encryptedSeed,
        });
        migrated++;
      }
    }

    return migrated;
  }

  /**
   * Re-encrypt all seeds with a new master key.
   * Both old and new keys must be provided. Used during passphrase change.
   */
  async reEncrypt(oldKey: Uint8Array, newKey: Uint8Array): Promise<void> {
    this.encryptionEnabled = true;
    const infos = await this.inner.listEntries();

    // Decrypt all seeds with old key, re-encrypt with new key, collect updates
    const updates: StoredKeyEntry[] = [];
    for (const info of infos) {
      const stored = await this.inner.getEntry(info.tag);
      if (!stored) continue;

      // Decrypt with old key
      let plainSeed: Uint8Array;
      if (this.isPlaintext(stored.seed)) {
        plainSeed = stored.seed;
      } else {
        const nonce = stored.seed.slice(MAGIC_LEN, MAGIC_LEN + NONCE_LEN);
        const cipher = stored.seed.slice(MAGIC_LEN + NONCE_LEN);
        plainSeed = asBytes(
          sodium.crypto_secretbox_open_easy(cipher, nonce, oldKey)
        );
      }

      // Re-encrypt with new key
      const nonce = asBytes(sodium.randombytes_buf(NONCE_LEN));
      const cipher = asBytes(
        sodium.crypto_secretbox_easy(plainSeed, nonce, newKey)
      );
      sodium.memzero(plainSeed);

      const encryptedSeed = new Uint8Array(MAGIC_LEN + NONCE_LEN + cipher.length);
      encryptedSeed.set(ENCRYPTED_MAGIC, 0);
      encryptedSeed.set(nonce, MAGIC_LEN);
      encryptedSeed.set(cipher, MAGIC_LEN + NONCE_LEN);

      updates.push({ info: stored.info, seed: encryptedSeed });
    }

    // Write all updates
    for (const entry of updates) {
      await this.inner.putEntry(entry);
    }
  }

  // ---- Private helpers ----

  private isPlaintext(seed: Uint8Array): boolean {
    if (seed.length < MAGIC_LEN) return true;
    for (let i = 0; i < MAGIC_LEN; i++) {
      if (seed[i] !== ENCRYPTED_MAGIC[i]) return true;
    }
    return false;
  }

  private decryptSeed(storedSeed: Uint8Array): Uint8Array {
    if (this.isPlaintext(storedSeed)) {
      // Legacy plaintext — return as-is (pre-migration)
      return storedSeed;
    }

    if (!this.masterKey) throw new Error("Storage is locked");

    const nonce = storedSeed.slice(MAGIC_LEN, MAGIC_LEN + NONCE_LEN);
    const cipher = storedSeed.slice(MAGIC_LEN + NONCE_LEN);

    try {
      return asBytes(
        sodium.crypto_secretbox_open_easy(cipher, nonce, this.masterKey)
      );
    } catch {
      throw new Error("Failed to decrypt seed — wrong master key or corrupted data");
    }
  }
}
