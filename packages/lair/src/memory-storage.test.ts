import { describe, it, expect, beforeEach } from "vitest";
import { MemoryKeyStorage } from "./memory-storage.js";
import type { StoredKeyEntry } from "./types.js";

function makeEntry(tag: string, seedByte = 0x01): StoredKeyEntry {
  return {
    info: {
      tag,
      ed25519_pub_key: new Uint8Array(32).fill(seedByte),
      x25519_pub_key: new Uint8Array(32).fill(seedByte + 1),
      created_at: Date.now(),
      exportable: false,
    },
    seed: new Uint8Array(64).fill(seedByte + 2),
  };
}

describe("MemoryKeyStorage", () => {
  let storage: MemoryKeyStorage;

  beforeEach(async () => {
    storage = new MemoryKeyStorage();
    await storage.init();
  });

  it("stores and retrieves an entry", async () => {
    const entry = makeEntry("test-key");
    await storage.putEntry(entry);

    const result = await storage.getEntry("test-key");
    expect(result).not.toBeNull();
    expect(result!.info.tag).toBe("test-key");
    expect(result!.seed).toEqual(entry.seed);
  });

  it("returns null for missing entry", async () => {
    const result = await storage.getEntry("nonexistent");
    expect(result).toBeNull();
  });

  it("returns a copy (not reference) from getEntry", async () => {
    const entry = makeEntry("test-key");
    await storage.putEntry(entry);

    const a = await storage.getEntry("test-key");
    const b = await storage.getEntry("test-key");
    expect(a!.seed).toEqual(b!.seed);
    expect(a!.seed).not.toBe(b!.seed);
  });

  it("overwrites entry on put with same tag", async () => {
    await storage.putEntry(makeEntry("key", 0x01));
    await storage.putEntry(makeEntry("key", 0x99));

    const result = await storage.getEntry("key");
    expect(result!.seed[0]).toBe(0x9b); // 0x99 + 2
  });

  it("getEntryInfo returns info without seed", async () => {
    await storage.putEntry(makeEntry("key"));

    const info = await storage.getEntryInfo("key");
    expect(info).not.toBeNull();
    expect(info!.tag).toBe("key");
    expect("seed" in info!).toBe(false);
  });

  it("getEntryInfo returns null for missing entry", async () => {
    const info = await storage.getEntryInfo("missing");
    expect(info).toBeNull();
  });

  it("listEntries returns all entry infos", async () => {
    await storage.putEntry(makeEntry("a"));
    await storage.putEntry(makeEntry("b"));
    await storage.putEntry(makeEntry("c"));

    const entries = await storage.listEntries();
    expect(entries).toHaveLength(3);
    const tags = entries.map((e) => e.tag).sort();
    expect(tags).toEqual(["a", "b", "c"]);
  });

  it("hasEntry returns true for existing entry", async () => {
    await storage.putEntry(makeEntry("key"));
    expect(await storage.hasEntry("key")).toBe(true);
  });

  it("hasEntry returns false for missing entry", async () => {
    expect(await storage.hasEntry("missing")).toBe(false);
  });

  it("deleteEntry removes the entry", async () => {
    await storage.putEntry(makeEntry("key"));
    await storage.deleteEntry("key");

    expect(await storage.getEntry("key")).toBeNull();
    expect(await storage.hasEntry("key")).toBe(false);
  });

  it("deleteEntry is safe for nonexistent keys", async () => {
    await storage.deleteEntry("nonexistent");
    // No error thrown
  });

  it("clear removes all entries", async () => {
    await storage.putEntry(makeEntry("a"));
    await storage.putEntry(makeEntry("b"));

    await storage.clear();

    expect(await storage.listEntries()).toHaveLength(0);
    expect(await storage.hasEntry("a")).toBe(false);
  });
});
