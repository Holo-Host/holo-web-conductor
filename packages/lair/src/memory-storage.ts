/**
 * In-memory key storage implementation.
 *
 * No persistence — keys live only in process memory. Useful for:
 * - Tests (no IndexedDB / fake-indexeddb needed)
 * - Cloudflare Workers (key loaded from env secret at startup)
 * - Node.js servers (key loaded from file at startup)
 * - Any context where keys are provided externally
 */

import type { EntryTag, EntryInfo, StoredKeyEntry } from "./types";
import type { KeyStorage } from "./storage";

export class MemoryKeyStorage implements KeyStorage {
  private entries = new Map<EntryTag, StoredKeyEntry>();

  async init(): Promise<void> {
    // No initialization needed for in-memory storage
  }

  async putEntry(entry: StoredKeyEntry): Promise<void> {
    // Deep-copy to prevent external mutation
    this.entries.set(entry.info.tag, {
      info: { ...entry.info },
      seed: new Uint8Array(entry.seed),
    });
  }

  async getEntry(tag: EntryTag): Promise<StoredKeyEntry | null> {
    const entry = this.entries.get(tag);
    if (!entry) return null;
    // Return a copy
    return {
      info: { ...entry.info },
      seed: new Uint8Array(entry.seed),
    };
  }

  async getEntryInfo(tag: EntryTag): Promise<EntryInfo | null> {
    const entry = this.entries.get(tag);
    return entry ? { ...entry.info } : null;
  }

  async listEntries(): Promise<EntryInfo[]> {
    return Array.from(this.entries.values()).map((e) => ({ ...e.info }));
  }

  async hasEntry(tag: EntryTag): Promise<boolean> {
    return this.entries.has(tag);
  }

  async deleteEntry(tag: EntryTag): Promise<void> {
    const entry = this.entries.get(tag);
    if (entry) {
      // Zero out key material before removing
      entry.seed.fill(0);
      this.entries.delete(tag);
    }
  }

  async clear(): Promise<void> {
    for (const entry of this.entries.values()) {
      entry.seed.fill(0);
    }
    this.entries.clear();
  }
}
