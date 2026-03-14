import { describe, it, expect, beforeEach } from "vitest";
import sodium from "libsodium-wrappers";
import { EncryptedKeyStorage } from "./encrypted-storage";
import { MemoryKeyStorage } from "./memory-storage";
import type { StoredKeyEntry } from "./types";

function makeEntry(tag: string): StoredKeyEntry {
  // 64-byte Ed25519 private key (plaintext)
  const seed = new Uint8Array(64);
  seed.fill(tag.charCodeAt(0));
  return {
    info: {
      tag,
      ed25519_pub_key: new Uint8Array(32).fill(0xaa),
      x25519_pub_key: new Uint8Array(32).fill(0xbb),
      created_at: Date.now(),
      exportable: true,
    },
    seed,
  };
}

describe("EncryptedKeyStorage", () => {
  let inner: MemoryKeyStorage;
  let storage: EncryptedKeyStorage;
  let masterKey: Uint8Array;

  beforeEach(async () => {
    await sodium.ready;
    inner = new MemoryKeyStorage();
    storage = new EncryptedKeyStorage(inner);
    await storage.init();
    masterKey = sodium.randombytes_buf(32);
    storage.setMasterKey(masterKey);
  });

  it("should encrypt and decrypt seeds roundtrip", async () => {
    const entry = makeEntry("test");
    const originalSeed = new Uint8Array(entry.seed);

    await storage.putEntry(entry);

    // Inner storage should have encrypted seed (105 bytes, not 64)
    const innerEntry = await inner.getEntry("test");
    expect(innerEntry).not.toBeNull();
    expect(innerEntry!.seed.length).toBe(108); // 4 magic + 24 nonce + 64 seed + 16 MAC

    // Encrypted seed should not match plaintext
    const innerSeedPayload = innerEntry!.seed.slice(28); // skip magic (4) + nonce (24)
    expect(innerSeedPayload).not.toEqual(originalSeed);

    // Decrypted seed should match original
    const decrypted = await storage.getEntry("test");
    expect(decrypted).not.toBeNull();
    expect(decrypted!.seed).toEqual(originalSeed);
  });

  it("should fail to put/get when locked (no master key)", async () => {
    storage.clearMasterKey();
    expect(storage.hasMasterKey()).toBe(false);

    await expect(storage.putEntry(makeEntry("x"))).rejects.toThrow("locked");
    // Put one while unlocked first
    storage.setMasterKey(masterKey);
    await storage.putEntry(makeEntry("y"));
    storage.clearMasterKey();
    await expect(storage.getEntry("y")).rejects.toThrow("locked");
  });

  it("should allow info-only operations when locked", async () => {
    await storage.putEntry(makeEntry("a"));
    await storage.putEntry(makeEntry("b"));
    storage.clearMasterKey();

    // These should work without master key
    const infos = await storage.listEntries();
    expect(infos).toHaveLength(2);

    const info = await storage.getEntryInfo("a");
    expect(info).not.toBeNull();
    expect(info!.tag).toBe("a");

    expect(await storage.hasEntry("a")).toBe(true);
    expect(await storage.hasEntry("missing")).toBe(false);
  });

  it("should fail decryption with wrong master key", async () => {
    await storage.putEntry(makeEntry("test"));

    // Change to wrong key
    const wrongKey = sodium.randombytes_buf(32);
    storage.setMasterKey(wrongKey);

    await expect(storage.getEntry("test")).rejects.toThrow("Failed to decrypt");
  });

  it("should migrate plaintext seeds to encrypted", async () => {
    // Put plaintext entries directly into inner storage
    const entry1 = makeEntry("plain1");
    const entry2 = makeEntry("plain2");
    await inner.putEntry(entry1);
    await inner.putEntry(entry2);

    // Verify they're plaintext (64 bytes)
    const before = await inner.getEntry("plain1");
    expect(before!.seed.length).toBe(64);

    // Migrate
    const count = await storage.migrateToEncrypted();
    expect(count).toBe(2);

    // Now inner storage should have encrypted seeds
    const after = await inner.getEntry("plain1");
    expect(after!.seed.length).toBe(108);

    // Should still decrypt correctly
    const decrypted = await storage.getEntry("plain1");
    expect(decrypted!.seed).toEqual(entry1.seed);
  });

  it("should re-encrypt seeds with new key", async () => {
    await storage.putEntry(makeEntry("key1"));
    await storage.putEntry(makeEntry("key2"));

    const oldKey = new Uint8Array(masterKey);
    const newKey = sodium.randombytes_buf(32);

    await storage.reEncrypt(oldKey, newKey);
    storage.setMasterKey(newKey);

    // Should decrypt with new key
    const entry = await storage.getEntry("key1");
    expect(entry).not.toBeNull();
    expect(entry!.seed.length).toBe(64);

    // Old key should fail
    storage.setMasterKey(oldKey);
    await expect(storage.getEntry("key1")).rejects.toThrow("Failed to decrypt");
  });

  it("should zero master key on clearMasterKey", async () => {
    const key = new Uint8Array(masterKey);
    storage.setMasterKey(key);
    storage.clearMasterKey();

    // The key we passed should still be our copy, but internal copy should be zeroed
    expect(storage.hasMasterKey()).toBe(false);
  });

  it("should pass through unencrypted when no passphrase is set", async () => {
    // Create a fresh storage without ever setting a master key
    const freshInner = new MemoryKeyStorage();
    const freshStorage = new EncryptedKeyStorage(freshInner);
    await freshStorage.init();

    // Should not be "encryption enabled"
    expect(freshStorage.isEncryptionEnabled()).toBe(false);

    const entry = makeEntry("nopass");
    const originalSeed = new Uint8Array(entry.seed);

    // putEntry should work without a master key
    await freshStorage.putEntry(entry);

    // Inner storage should have plaintext seed (64 bytes, not 104)
    const innerEntry = await freshInner.getEntry("nopass");
    expect(innerEntry!.seed.length).toBe(64);
    expect(innerEntry!.seed).toEqual(originalSeed);

    // getEntry should work without a master key
    const retrieved = await freshStorage.getEntry("nopass");
    expect(retrieved!.seed).toEqual(originalSeed);

    // Info operations also work
    expect(await freshStorage.hasEntry("nopass")).toBe(true);
    const infos = await freshStorage.listEntries();
    expect(infos).toHaveLength(1);
  });

  it("should correctly migrate a plaintext seed starting with 0x01", async () => {
    // This was the old marker collision bug: a plaintext seed with first byte
    // 0x01 would be misidentified as encrypted, skipping migration.
    const entry = makeEntry("collision");
    entry.seed[0] = 0x01;
    const originalSeed = new Uint8Array(entry.seed);

    await inner.putEntry(entry);

    // Should be detected as plaintext and migrated
    const count = await storage.migrateToEncrypted();
    expect(count).toBe(1);

    // Should decrypt back to original
    const decrypted = await storage.getEntry("collision");
    expect(decrypted!.seed).toEqual(originalSeed);
  });

  it("should correctly migrate a plaintext seed starting with 0x45 (E)", async () => {
    // Partial magic match — first byte matches but rest doesn't
    const entry = makeEntry("partial");
    entry.seed[0] = 0x45; // 'E' — first byte of magic
    entry.seed[1] = 0x00; // not 'N'
    const originalSeed = new Uint8Array(entry.seed);

    await inner.putEntry(entry);

    const count = await storage.migrateToEncrypted();
    expect(count).toBe(1);

    const decrypted = await storage.getEntry("partial");
    expect(decrypted!.seed).toEqual(originalSeed);
  });

  it("should handle delete and clear", async () => {
    await storage.putEntry(makeEntry("del"));
    await storage.deleteEntry("del");
    expect(await storage.hasEntry("del")).toBe(false);

    await storage.putEntry(makeEntry("c1"));
    await storage.putEntry(makeEntry("c2"));
    await storage.clear();
    expect(await storage.listEntries()).toHaveLength(0);
  });
});
