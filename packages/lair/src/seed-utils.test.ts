import { describe, it, expect } from "vitest";
import sodium from "libsodium-wrappers";
import { seedToStoredEntry, hexToSeed } from "./seed-utils.js";

describe("seedToStoredEntry", () => {
  it("produces a StoredKeyEntry from a 32-byte seed", async () => {
    const seed = new Uint8Array(32).fill(0x42);
    const entry = await seedToStoredEntry(seed, "test-tag");

    expect(entry.info.tag).toBe("test-tag");
    expect(entry.info.ed25519_pub_key).toBeInstanceOf(Uint8Array);
    expect(entry.info.ed25519_pub_key.length).toBe(32);
    expect(entry.info.x25519_pub_key).toBeInstanceOf(Uint8Array);
    expect(entry.info.x25519_pub_key.length).toBe(32);
    expect(entry.info.exportable).toBe(false);
    expect(entry.info.created_at).toBeGreaterThan(0);
    // seed field stores 64-byte libsodium private key
    expect(entry.seed).toBeInstanceOf(Uint8Array);
    expect(entry.seed.length).toBe(64);
  });

  it("is deterministic (same seed produces same keys)", async () => {
    const seed = new Uint8Array(32).fill(0xab);
    const a = await seedToStoredEntry(seed, "a");
    const b = await seedToStoredEntry(seed, "b");

    expect(a.info.ed25519_pub_key).toEqual(b.info.ed25519_pub_key);
    expect(a.info.x25519_pub_key).toEqual(b.info.x25519_pub_key);
    expect(a.seed).toEqual(b.seed);
  });

  it("produces a valid signing key", async () => {
    await sodium.ready;
    const seed = new Uint8Array(32).fill(0x07);
    const entry = await seedToStoredEntry(seed, "signer");

    const message = new Uint8Array([1, 2, 3, 4]);
    const signature = sodium.crypto_sign_detached(message, entry.seed);
    const valid = sodium.crypto_sign_verify_detached(
      signature,
      message,
      entry.info.ed25519_pub_key,
    );
    expect(valid).toBe(true);
  });

  it("sets exportable flag", async () => {
    const seed = new Uint8Array(32).fill(0x01);
    const entry = await seedToStoredEntry(seed, "exportable-key", true);
    expect(entry.info.exportable).toBe(true);
  });

  it("rejects non-32-byte seeds", async () => {
    await expect(
      seedToStoredEntry(new Uint8Array(16), "bad"),
    ).rejects.toThrow("Expected 32-byte seed");
  });
});

describe("hexToSeed", () => {
  it("parses 64 hex characters into 32 bytes", () => {
    const hex = "00".repeat(32);
    const result = hexToSeed(hex);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(32);
    expect(result.every((b) => b === 0)).toBe(true);
  });

  it("correctly parses hex values", () => {
    const hex = "ff01ab" + "00".repeat(29);
    const result = hexToSeed(hex);
    expect(result[0]).toBe(0xff);
    expect(result[1]).toBe(0x01);
    expect(result[2]).toBe(0xab);
  });

  it("strips whitespace and newlines", () => {
    const hex = "ab cd ef 01\n02 03" + " 00".repeat(26);
    const result = hexToSeed(hex);
    expect(result[0]).toBe(0xab);
    expect(result[1]).toBe(0xcd);
    expect(result.length).toBe(32);
  });

  it("rejects wrong-length hex strings", () => {
    expect(() => hexToSeed("aabb")).toThrow("Expected 64 hex characters");
    expect(() => hexToSeed("00".repeat(33))).toThrow(
      "Expected 64 hex characters",
    );
  });
});
