/**
 * Tests for hApp Context Storage
 */

import { describe, it, expect, beforeEach } from "vitest";
import { HappContextStorage } from "./happ-context-storage";
import type { HappContext } from "@hwc/core";

describe("HappContextStorage", () => {
  let storage: HappContextStorage;

  beforeEach(async () => {
    // Create new instance and clear data before each test
    storage = new HappContextStorage();
    await storage.clear();
  });

  describe("Context CRUD Operations", () => {
    it("should create and retrieve a context", async () => {
      const context: HappContext = {
        id: "test-context-1",
        domain: "https://example.com",
        agentPubKey: new Uint8Array([1, 2, 3, 4]),
        agentKeyTag: "https://example.com:agent",
        dnas: [
          {
            hash: new Uint8Array([5, 6, 7, 8]),
            wasm: new Uint8Array([9, 10, 11, 12]),
            name: "test-dna",
          },
        ],
        appName: "Test App",
        appVersion: "1.0.0",
        installedAt: Date.now(),
        lastUsed: Date.now(),
        enabled: true,
      };

      await storage.putContext(context);
      const retrieved = await storage.getContext("test-context-1");

      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(context.id);
      expect(retrieved!.domain).toBe(context.domain);
      expect(retrieved!.agentPubKey).toEqual(context.agentPubKey);
      expect(retrieved!.agentKeyTag).toBe(context.agentKeyTag);
      expect(retrieved!.dnas).toHaveLength(1);
      expect(retrieved!.dnas[0].hash).toEqual(context.dnas[0].hash);
      expect(retrieved!.dnas[0].wasm).toEqual(context.dnas[0].wasm);
      expect(retrieved!.enabled).toBe(true);
    });

    it("should return null for non-existent context", async () => {
      const retrieved = await storage.getContext("non-existent");
      expect(retrieved).toBeNull();
    });

    it("should find context by domain using index", async () => {
      const context: HappContext = {
        id: "test-context-2",
        domain: "https://app.example.com",
        agentPubKey: new Uint8Array([1, 2, 3]),
        agentKeyTag: "https://app.example.com:agent",
        dnas: [],
        installedAt: Date.now(),
        lastUsed: Date.now(),
        enabled: true,
      };

      await storage.putContext(context);
      const retrieved = await storage.getContextByDomain("https://app.example.com");

      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe("test-context-2");
      expect(retrieved!.domain).toBe("https://app.example.com");
    });

    it("should return null for non-existent domain", async () => {
      const retrieved = await storage.getContextByDomain("https://nonexistent.com");
      expect(retrieved).toBeNull();
    });

    it("should list all contexts", async () => {
      const context1: HappContext = {
        id: "ctx-1",
        domain: "https://app1.com",
        agentPubKey: new Uint8Array([1]),
        agentKeyTag: "https://app1.com:agent",
        dnas: [],
        installedAt: Date.now(),
        lastUsed: Date.now(),
        enabled: true,
      };

      const context2: HappContext = {
        id: "ctx-2",
        domain: "https://app2.com",
        agentPubKey: new Uint8Array([2]),
        agentKeyTag: "https://app2.com:agent",
        dnas: [],
        installedAt: Date.now(),
        lastUsed: Date.now(),
        enabled: false,
      };

      await storage.putContext(context1);
      await storage.putContext(context2);

      const contexts = await storage.listContexts();
      expect(contexts).toHaveLength(2);
      expect(contexts.map((c) => c.id).sort()).toEqual(["ctx-1", "ctx-2"]);
    });

    it("should delete a context", async () => {
      const context: HappContext = {
        id: "delete-test",
        domain: "https://delete.com",
        agentPubKey: new Uint8Array([1]),
        agentKeyTag: "https://delete.com:agent",
        dnas: [],
        installedAt: Date.now(),
        lastUsed: Date.now(),
        enabled: true,
      };

      await storage.putContext(context);
      expect(await storage.getContext("delete-test")).toBeDefined();

      await storage.deleteContext("delete-test");
      expect(await storage.getContext("delete-test")).toBeNull();
    });

    it("should update last used timestamp", async () => {
      const context: HappContext = {
        id: "update-test",
        domain: "https://update.com",
        agentPubKey: new Uint8Array([1]),
        agentKeyTag: "https://update.com:agent",
        dnas: [],
        installedAt: Date.now(),
        lastUsed: Date.now() - 10000, // 10 seconds ago
        enabled: true,
      };

      await storage.putContext(context);
      const stored = await storage.getContext("update-test");
      const originalLastUsed = stored!.lastUsed;

      // Wait a bit to ensure timestamp changes
      await new Promise((resolve) => setTimeout(resolve, 50));

      await storage.updateLastUsed("update-test");
      const updated = await storage.getContext("update-test");

      expect(updated).toBeDefined();
      expect(updated!.lastUsed).toBeGreaterThan(originalLastUsed);
    });
  });

  describe("DNA WASM Operations", () => {
    it("should store and retrieve DNA WASM", async () => {
      const hash = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const wasm = new Uint8Array([10, 20, 30, 40, 50]);

      await storage.putDnaWasm(hash, wasm);
      const retrieved = await storage.getDnaWasm(hash);

      expect(retrieved).toBeDefined();
      expect(retrieved).toEqual(wasm);
    });

    it("should return null for non-existent DNA WASM", async () => {
      const hash = new Uint8Array([99, 99, 99, 99]);
      const retrieved = await storage.getDnaWasm(hash);
      expect(retrieved).toBeNull();
    });

    it("should delete DNA WASM", async () => {
      const hash = new Uint8Array([1, 2, 3, 4]);
      const wasm = new Uint8Array([10, 20, 30]);

      await storage.putDnaWasm(hash, wasm);
      expect(await storage.getDnaWasm(hash)).toBeDefined();

      await storage.deleteDnaWasm(hash);
      expect(await storage.getDnaWasm(hash)).toBeNull();
    });

    it("should handle DNA WASM deduplication (same hash, different contexts)", async () => {
      const hash = new Uint8Array([5, 6, 7, 8]);
      const wasm = new Uint8Array([100, 200, 300]);

      // Store same DNA WASM twice
      await storage.putDnaWasm(hash, wasm);
      await storage.putDnaWasm(hash, wasm);

      // Should retrieve the same WASM
      const retrieved = await storage.getDnaWasm(hash);
      expect(retrieved).toEqual(wasm);
    });
  });

  describe("Domain Index Uniqueness", () => {
    it("should enforce unique domain constraint via index", async () => {
      const context1: HappContext = {
        id: "ctx-1",
        domain: "https://unique.com",
        agentPubKey: new Uint8Array([1]),
        agentKeyTag: "https://unique.com:agent",
        dnas: [],
        installedAt: Date.now(),
        lastUsed: Date.now(),
        enabled: true,
      };

      const context2: HappContext = {
        id: "ctx-2", // Different ID
        domain: "https://unique.com", // Same domain
        agentPubKey: new Uint8Array([2]),
        agentKeyTag: "https://unique.com:agent:1",
        dnas: [],
        installedAt: Date.now(),
        lastUsed: Date.now(),
        enabled: true,
      };

      await storage.putContext(context1);

      // Attempting to store context2 with same domain should fail
      // Note: IndexedDB's unique constraint will throw an error
      await expect(storage.putContext(context2)).rejects.toThrow();
    });
  });
});
