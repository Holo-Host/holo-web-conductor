import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { LairClient, createLairClient } from "./client";
import { createKeyStorage, type KeyStorage } from "./storage";
import sodium from "libsodium-wrappers";

describe("LairClient", () => {
  let client: LairClient;
  let storage: KeyStorage;

  beforeEach(async () => {
    // Initialize libsodium
    await sodium.ready;

    // Create storage and client for each test
    storage = await createKeyStorage();
    await storage.clear(); // Ensure clean state
    client = new LairClient(storage);
    await client["ready"]; // Wait for client to be ready
  });

  afterEach(async () => {
    // Clean up
    if (storage) {
      await storage.clear();
    }
  });

  describe("newSeed", () => {
    it("should generate a new seed with valid Ed25519 keypair", async () => {
      const result = await client.newSeed("test-key");

      expect(result.tag).toBe("test-key");
      expect(result.entry_info.tag).toBe("test-key");
      expect(result.entry_info.ed25519_pub_key).toBeInstanceOf(Uint8Array);
      expect(result.entry_info.ed25519_pub_key.length).toBe(32);
      expect(result.entry_info.x25519_pub_key).toBeInstanceOf(Uint8Array);
      expect(result.entry_info.x25519_pub_key.length).toBe(32);
      expect(result.entry_info.created_at).toBeGreaterThan(0);
      expect(result.entry_info.exportable).toBe(false);
    });

    it("should create exportable keys when requested", async () => {
      const result = await client.newSeed("exportable-key", true);

      expect(result.entry_info.exportable).toBe(true);
    });

    it("should throw error if tag already exists", async () => {
      await client.newSeed("duplicate");

      await expect(client.newSeed("duplicate")).rejects.toThrow(
        "already exists"
      );
    });

    it("should generate different keys for different tags", async () => {
      const result1 = await client.newSeed("key1");
      const result2 = await client.newSeed("key2");

      expect(result1.entry_info.ed25519_pub_key).not.toEqual(
        result2.entry_info.ed25519_pub_key
      );
    });
  });

  describe("getEntry and listEntries", () => {
    it("should retrieve entry by tag", async () => {
      const created = await client.newSeed("test-key");
      const retrieved = await client.getEntry("test-key");

      expect(retrieved).not.toBeNull();
      expect(retrieved!.tag).toBe("test-key");
      expect(retrieved!.ed25519_pub_key).toEqual(
        created.entry_info.ed25519_pub_key
      );
    });

    it("should return null for non-existent tag", async () => {
      const result = await client.getEntry("non-existent");
      expect(result).toBeNull();
    });

    it("should list all entries", async () => {
      await client.newSeed("key1");
      await client.newSeed("key2");
      await client.newSeed("key3");

      const entries = await client.listEntries();

      expect(entries).toHaveLength(3);
      expect(entries.map((e) => e.tag).sort()).toEqual(["key1", "key2", "key3"]);
    });

    it("should return empty array when no entries exist", async () => {
      const entries = await client.listEntries();
      expect(entries).toEqual([]);
    });
  });

  describe("signByPubKey", () => {
    it("should sign data and produce valid signature", async () => {
      const { entry_info } = await client.newSeed("signer");
      const data = new Uint8Array([1, 2, 3, 4, 5]);

      const signature = await client.signByPubKey(
        entry_info.ed25519_pub_key,
        data
      );

      expect(signature).toBeInstanceOf(Uint8Array);
      expect(signature.length).toBe(64); // Ed25519 signature is 64 bytes

      // Verify signature
      const isValid = sodium.crypto_sign_verify_detached(
        signature,
        data,
        entry_info.ed25519_pub_key
      );
      expect(isValid).toBe(true);
    });

    it("should throw error for unknown public key", async () => {
      const fake_pub_key = new Uint8Array(32);

      await expect(
        client.signByPubKey(fake_pub_key, new Uint8Array([1, 2, 3]))
      ).rejects.toThrow("not found");
    });

    it("should produce different signatures for different data", async () => {
      const { entry_info } = await client.newSeed("signer");
      const data1 = new Uint8Array([1, 2, 3]);
      const data2 = new Uint8Array([4, 5, 6]);

      const sig1 = await client.signByPubKey(entry_info.ed25519_pub_key, data1);
      const sig2 = await client.signByPubKey(entry_info.ed25519_pub_key, data2);

      expect(sig1).not.toEqual(sig2);
    });
  });

  describe("deriveSeed", () => {
    it("should derive a new seed from existing one", async () => {
      await client.newSeed("parent");

      const derived = await client.deriveSeed("parent", [0], "child");

      expect(derived.tag).toBe("child");
      expect(derived.entry_info.ed25519_pub_key).toBeInstanceOf(Uint8Array);
      expect(derived.entry_info.ed25519_pub_key.length).toBe(32);
    });

    it("should derive different keys for different paths", async () => {
      await client.newSeed("parent");

      const child1 = await client.deriveSeed("parent", [0], "child1");
      const child2 = await client.deriveSeed("parent", [1], "child2");

      expect(child1.entry_info.ed25519_pub_key).not.toEqual(
        child2.entry_info.ed25519_pub_key
      );
    });

    it("should support string derivation paths", async () => {
      await client.newSeed("parent");

      const derived = await client.deriveSeed("parent", "0/1/2", "child");

      expect(derived.tag).toBe("child");
      expect(derived.entry_info).toBeTruthy();
    });

    it("should throw error if source tag not found", async () => {
      await expect(
        client.deriveSeed("non-existent", [0], "child")
      ).rejects.toThrow("not found");
    });

    it("should throw error if dest tag already exists", async () => {
      await client.newSeed("parent");
      await client.newSeed("existing");

      await expect(
        client.deriveSeed("parent", [0], "existing")
      ).rejects.toThrow("already exists");
    });
  });

  describe("crypto_box encryption", () => {
    it("should encrypt and decrypt data", async () => {
      const alice = await client.newSeed("alice");
      const bob = await client.newSeed("bob");

      const plaintext = new Uint8Array([1, 2, 3, 4, 5]);

      // Alice encrypts for Bob
      const { nonce, cipher } = await client.cryptoBoxByPubKey(
        bob.entry_info.x25519_pub_key,
        alice.entry_info.ed25519_pub_key,
        plaintext
      );

      expect(cipher).toBeInstanceOf(Uint8Array);
      expect(cipher.length).toBeGreaterThan(plaintext.length);
      expect(nonce).toBeInstanceOf(Uint8Array);
      expect(nonce.length).toBe(24);

      // Bob decrypts
      const decrypted = await client.cryptoBoxOpenByPubKey(
        alice.entry_info.x25519_pub_key,
        bob.entry_info.ed25519_pub_key,
        nonce,
        cipher
      );

      expect(decrypted).toEqual(plaintext);
    });

    it("should fail to decrypt with wrong nonce", async () => {
      const alice = await client.newSeed("alice");
      const bob = await client.newSeed("bob");

      const plaintext = new Uint8Array([1, 2, 3]);

      const { cipher } = await client.cryptoBoxByPubKey(
        bob.entry_info.x25519_pub_key,
        alice.entry_info.ed25519_pub_key,
        plaintext
      );

      const wrong_nonce = new Uint8Array(24); // All zeros

      await expect(
        client.cryptoBoxOpenByPubKey(
          alice.entry_info.x25519_pub_key,
          bob.entry_info.ed25519_pub_key,
          wrong_nonce,
          cipher
        )
      ).rejects.toThrow();
    });
  });

  describe("secret_box encryption", () => {
    it("should encrypt and decrypt data with symmetric key", async () => {
      await client.newSeed("secret-key");

      const plaintext = new Uint8Array([1, 2, 3, 4, 5]);

      // Encrypt
      const { nonce, cipher } = await client.secretBoxByTag(
        "secret-key",
        plaintext
      );

      expect(cipher).toBeInstanceOf(Uint8Array);
      expect(cipher.length).toBeGreaterThan(plaintext.length);
      expect(nonce).toBeInstanceOf(Uint8Array);

      // Decrypt
      const decrypted = await client.secretBoxOpenByTag(
        "secret-key",
        nonce,
        cipher
      );

      expect(decrypted).toEqual(plaintext);
    });

    it("should fail to decrypt with wrong key", async () => {
      await client.newSeed("key1");
      await client.newSeed("key2");

      const plaintext = new Uint8Array([1, 2, 3]);

      const { nonce, cipher } = await client.secretBoxByTag("key1", plaintext);

      await expect(
        client.secretBoxOpenByTag("key2", nonce, cipher)
      ).rejects.toThrow();
    });

    it("should throw error for non-existent tag", async () => {
      await expect(
        client.secretBoxByTag("non-existent", new Uint8Array([1, 2, 3]))
      ).rejects.toThrow("not found");
    });
  });
});
