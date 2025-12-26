/**
 * Tests for hApp Context Manager
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { HappContextManager, resetHappContextManager } from "./happ-context-manager";
import { HappContextStorage } from "./happ-context-storage";
import { LairClient, type ILairClient } from "@fishy/lair";
import { PermissionManager } from "./permissions";
import type { InstallHappRequest, HappContext } from "@fishy/core";

// Mock dependencies
function createMockStorage(): HappContextStorage {
  const storage = new HappContextStorage();
  return storage;
}

function createMockLairClient(): ILairClient {
  const lair = new LairClient();
  return lair;
}

function createMockPermissionManager(): PermissionManager {
  const permissions = new PermissionManager();
  return permissions;
}

describe("HappContextManager", () => {
  let manager: HappContextManager;
  let storage: HappContextStorage;
  let lair: ILairClient;
  let permissions: PermissionManager;

  beforeEach(async () => {
    // Create fresh instances
    storage = createMockStorage();
    lair = createMockLairClient();
    permissions = createMockPermissionManager();

    // Clear storage
    await storage.clear();

    // Reset singleton
    resetHappContextManager();

    // Create manager with mocked dependencies
    manager = new HappContextManager(storage, lair, permissions);

    // Wait for initialization
    await manager["ready"];
  });

  describe("Install hApp", () => {
    it("should install hApp with new agent key", async () => {
      const domain = "https://example.com";

      // Grant permission first
      await permissions.grantPermission(domain);

      const request: InstallHappRequest = {
        appName: "Test App",
        appVersion: "1.0.0",
        dnas: [
          {
            hash: new Uint8Array([1, 2, 3, 4]),
            wasm: new Uint8Array([10, 20, 30, 40]),
            name: "test-dna",
          },
        ],
      };

      const context = await manager.installHapp(domain, request);

      expect(context).toBeDefined();
      expect(context.domain).toBe(domain);
      expect(context.appName).toBe("Test App");
      expect(context.appVersion).toBe("1.0.0");
      expect(context.enabled).toBe(true);
      expect(context.agentKeyTag).toBe(`${domain}:agent`);
      expect(context.agentPubKey).toBeInstanceOf(Uint8Array);
      expect(context.dnas).toHaveLength(1);

      // Verify agent key was created in Lair
      const entries = await lair.listEntries();
      expect(entries.some((e) => e.tag === `${domain}:agent`)).toBe(true);
    });

    it("should reject install without permission", async () => {
      const domain = "https://unauthorized.com";

      const request: InstallHappRequest = {
        dnas: [],
      };

      await expect(manager.installHapp(domain, request)).rejects.toThrow(
        "not authorized"
      );
    });

    it("should reject duplicate install for same domain", async () => {
      const domain = "https://duplicate.com";

      // Grant permission
      await permissions.grantPermission(domain);

      const request: InstallHappRequest = {
        dnas: [
          {
            hash: new Uint8Array([1, 2]),
            wasm: new Uint8Array([3, 4]),
          },
        ],
      };

      // First install should succeed
      await manager.installHapp(domain, request);

      // Second install should fail
      await expect(manager.installHapp(domain, request)).rejects.toThrow(
        "already installed"
      );
    });

    it("should generate unique context IDs", async () => {
      const domain1 = "https://app1.com";
      const domain2 = "https://app2.com";

      await permissions.grantPermission(domain1);
      await permissions.grantPermission(domain2);

      const request: InstallHappRequest = {
        dnas: [],
      };

      const context1 = await manager.installHapp(domain1, request);
      const context2 = await manager.installHapp(domain2, request);

      expect(context1.id).not.toBe(context2.id);
      expect(context1.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it("should use correct agent key tag naming convention", async () => {
      const domain = "https://myapp.com";

      await permissions.grantPermission(domain);

      const request: InstallHappRequest = {
        dnas: [],
      };

      const context = await manager.installHapp(domain, request);

      expect(context.agentKeyTag).toBe("https://myapp.com:agent");
    });
  });

  describe("Get context", () => {
    it("should get context for domain", async () => {
      const domain = "https://gettest.com";

      await permissions.grantPermission(domain);

      const request: InstallHappRequest = {
        appName: "Get Test",
        dnas: [],
      };

      const installed = await manager.installHapp(domain, request);
      const retrieved = await manager.getContextForDomain(domain);

      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(installed.id);
      expect(retrieved!.domain).toBe(domain);
    });

    it("should return null for non-existent domain", async () => {
      const context = await manager.getContextForDomain("https://nonexistent.com");
      expect(context).toBeNull();
    });
  });

  describe("Uninstall hApp", () => {
    it("should uninstall hApp and delete agent key", async () => {
      const domain = "https://uninstall.com";

      await permissions.grantPermission(domain);

      const request: InstallHappRequest = {
        dnas: [
          {
            hash: new Uint8Array([1, 2]),
            wasm: new Uint8Array([3, 4]),
          },
        ],
      };

      const context = await manager.installHapp(domain, request);

      // Verify agent key exists
      const entriesBefore = await lair.listEntries();
      expect(entriesBefore.some((e) => e.tag === context.agentKeyTag)).toBe(true);

      // Uninstall
      await manager.uninstallHapp(context.id);

      // Verify context deleted
      const retrieved = await manager.getContext(context.id);
      expect(retrieved).toBeNull();

      // Verify agent key deleted
      const entriesAfter = await lair.listEntries();
      expect(entriesAfter.some((e) => e.tag === context.agentKeyTag)).toBe(false);
    });

    it("should throw error for non-existent context", async () => {
      await expect(manager.uninstallHapp("nonexistent-id")).rejects.toThrow(
        "not found"
      );
    });
  });

  describe("Enable/Disable context", () => {
    it("should enable and disable context", async () => {
      const domain = "https://toggle.com";

      await permissions.grantPermission(domain);

      const context = await manager.installHapp(domain, { dnas: [] });

      // Should be enabled by default
      expect(context.enabled).toBe(true);

      // Disable
      await manager.setContextEnabled(context.id, false);
      const disabled = await manager.getContext(context.id);
      expect(disabled!.enabled).toBe(false);

      // Re-enable
      await manager.setContextEnabled(context.id, true);
      const enabled = await manager.getContext(context.id);
      expect(enabled!.enabled).toBe(true);
    });
  });

  describe("List contexts", () => {
    it("should list all contexts", async () => {
      const domain1 = "https://list1.com";
      const domain2 = "https://list2.com";

      await permissions.grantPermission(domain1);
      await permissions.grantPermission(domain2);

      await manager.installHapp(domain1, { dnas: [] });
      await manager.installHapp(domain2, { dnas: [] });

      const contexts = await manager.listContexts();
      expect(contexts).toHaveLength(2);
      expect(contexts.map((c) => c.domain).sort()).toEqual([domain1, domain2].sort());
    });
  });

  describe("Touch context", () => {
    it("should update last used timestamp", async () => {
      const domain = "https://touch.com";

      await permissions.grantPermission(domain);

      const context = await manager.installHapp(domain, { dnas: [] });
      const originalLastUsed = context.lastUsed;

      // Wait a bit to ensure timestamp changes
      await new Promise((resolve) => setTimeout(resolve, 10));

      await manager.touchContext(context.id);
      const updated = await manager.getContext(context.id);

      expect(updated).toBeDefined();
      expect(updated!.lastUsed).toBeGreaterThan(originalLastUsed);
    });
  });

  describe("Get cell IDs", () => {
    it("should return correct cell IDs", async () => {
      const domain = "https://cells.com";

      await permissions.grantPermission(domain);

      const request: InstallHappRequest = {
        dnas: [
          {
            hash: new Uint8Array([1, 2, 3]),
            wasm: new Uint8Array([4, 5, 6]),
          },
          {
            hash: new Uint8Array([7, 8, 9]),
            wasm: new Uint8Array([10, 11, 12]),
          },
        ],
      };

      const context = await manager.installHapp(domain, request);
      const cellIds = manager.getCellIds(context);

      expect(cellIds).toHaveLength(2);
      expect(cellIds[0][0]).toEqual(new Uint8Array([1, 2, 3])); // DNA hash
      expect(cellIds[0][1]).toEqual(context.agentPubKey); // Agent pub key
      expect(cellIds[1][0]).toEqual(new Uint8Array([7, 8, 9]));
      expect(cellIds[1][1]).toEqual(context.agentPubKey);
    });
  });
});
