/**
 * Tests for hApp Context Manager
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { HappContextManager, resetHappContextManager } from "./happ-context-manager";
import { HappContextStorage } from "./happ-context-storage";
import { LairClient, type ILairClient } from "@holo-host/lair";
import { PermissionManager } from "./permissions";
import type { InstallHappRequest, HappContext } from "@hwc/core";
import * as bundle from "@hwc/core";

// Mock the bundle unpacker functions
vi.mock("@hwc/core", async () => {
  const actual = await vi.importActual("@hwc/core");
  return {
    ...actual,
    unpackHappBundle: vi.fn((bytes: Uint8Array) => ({
      manifest: {
        name: "test-app",
        roles: [
          {
            name: "test-role",
            dna: {
              path: "test.dna",
            },
            provisioning: { Create: { deferred: false } },
          },
        ],
      },
      resources: new Map([
        ["test.dna", new Uint8Array([1, 2, 3, 4])],
      ]),
    })),
    unpackDnaBundle: vi.fn((bytes: Uint8Array) => ({
      manifest: {
        name: "test-dna",
        integrity: {
          network_seed: "test-seed",
          properties: {},
          zomes: [
            {
              name: "test_zome",
              path: "test_zome.wasm",
            },
          ],
        },
        coordinator: {
          zomes: [],
        },
      },
      resources: new Map([
        ["test_zome.wasm", new Uint8Array([10, 20, 30, 40])],
      ]),
    })),
    createRuntimeManifest: vi.fn((manifest: any, resources: any) => ({
      name: manifest.name,
      network_seed: manifest.integrity.network_seed,
      properties: manifest.integrity.properties,
      integrity_zomes: manifest.integrity.zomes.map((z: any, i: number) => ({
        name: z.name,
        index: i,
        wasm: resources.get(z.path),
        dependencies: [],
      })),
      coordinator_zomes: [],
    })),
  };
});

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

// Helper to create a mock .happ bundle (doesn't need to be real since unpacker is mocked)
function createMockHappBundle(): Uint8Array {
  return new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
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
        happBundle: createMockHappBundle(),
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
        happBundle: createMockHappBundle(),
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
        happBundle: createMockHappBundle(),
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
        happBundle: createMockHappBundle(),
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
        happBundle: createMockHappBundle(),
      };

      const context = await manager.installHapp(domain, request);

      expect(context.agentKeyTag).toBe("https://myapp.com:agent");
    });

    it("should use agentKeyTag override when provided", async () => {
      const domain = "https://keytag.com";
      await permissions.grantPermission(domain);

      const request: InstallHappRequest = {
        happBundle: createMockHappBundle(),
        agentKeyTag: "my-custom-agent-tag",
      };

      const context = await manager.installHapp(domain, request);

      expect(context.agentKeyTag).toBe("my-custom-agent-tag");
      // Should NOT have created the default domain-scoped key
      const entries = await lair.listEntries();
      expect(entries.some((e) => e.tag === "my-custom-agent-tag")).toBe(true);
      expect(entries.some((e) => e.tag === `${domain}:agent`)).toBe(false);
    });

    it("should reuse pre-existing Lair key when agentKeyTag matches existing entry", async () => {
      const domain = "https://reuse-key.com";
      await permissions.grantPermission(domain);

      // Pre-create a key in Lair under a custom tag (simulates a key created externally)
      const preExistingResult = await lair.newSeed("pre-existing-key", true);
      const preExistingPubKey = preExistingResult.entry_info.ed25519_pub_key;

      const request: InstallHappRequest = {
        happBundle: createMockHappBundle(),
        agentKeyTag: "pre-existing-key",
      };

      const context = await manager.installHapp(domain, request);

      // The same raw Ed25519 key should be wrapped into the AgentPubKey
      // The 32-byte raw key sits at bytes [3..35] of the 39-byte HoloHash
      const rawFromContext = context.agentPubKey.slice(3, 35);
      expect(rawFromContext).toEqual(preExistingPubKey);
    });

    it("should park context as awaitingMemproofs when allow_deferred_memproofs=true and no proofs provided", async () => {
      const domain = "https://deferred.com";
      await permissions.grantPermission(domain);

      // Override mock to return a deferred-memproof manifest
      vi.mocked(bundle.unpackHappBundle).mockReturnValueOnce({
        manifest: {
          name: "deferred-app",
          allow_deferred_memproofs: true,
          roles: [{ name: "test-role", dna: { path: "test.dna" } }],
        },
        resources: new Map([["test.dna", new Uint8Array([1, 2, 3, 4])]]),
      } as any);

      const request: InstallHappRequest = {
        happBundle: createMockHappBundle(),
      };

      const context = await manager.installHapp(domain, request);

      expect(context.status).toBe("awaitingMemproofs");
      expect(context.enabled).toBe(false);
    });

    it("should still park as awaitingMemproofs when allow_deferred_memproofs=true even if memproofs are provided", async () => {
      // installHapp always parks when deferred; the background handler runs genesis
      // immediately if proofs are present (one-step install flow).
      const domain = "https://onestep.com";
      await permissions.grantPermission(domain);

      vi.mocked(bundle.unpackHappBundle).mockReturnValueOnce({
        manifest: {
          name: "onestep-app",
          allow_deferred_memproofs: true,
          roles: [{ name: "test-role", dna: { path: "test.dna" } }],
        },
        resources: new Map([["test.dna", new Uint8Array([1, 2, 3, 4])]]),
      } as any);

      const request: InstallHappRequest = {
        happBundle: createMockHappBundle(),
        membraneProofs: { "test-role": new Uint8Array(64).fill(0xab) },
      };

      const context = await manager.installHapp(domain, request);

      // installHapp always parks; background handler will call completeMemproofs
      // after running genesis with the provided proofs
      expect(context.status).toBe("awaitingMemproofs");
      expect(context.enabled).toBe(false);
    });
  });

  describe("Membrane proof state machine", () => {
    async function installDeferredApp(domain: string): Promise<HappContext> {
      await permissions.grantPermission(domain);
      vi.mocked(bundle.unpackHappBundle).mockReturnValueOnce({
        manifest: {
          name: "deferred-app",
          allow_deferred_memproofs: true,
          roles: [{ name: "test-role", dna: { path: "test.dna" } }],
        },
        resources: new Map([["test.dna", new Uint8Array([1, 2, 3, 4])]]),
      } as any);
      return manager.installHapp(domain, { happBundle: createMockHappBundle() });
    }

    it("provideMemproofs validates context is in awaitingMemproofs state", async () => {
      const context = await installDeferredApp("https://memproof1.com");
      expect(context.status).toBe("awaitingMemproofs");

      // provideMemproofs should return the context unchanged (background runs genesis)
      const returned = await manager.provideMemproofs(context.id, {
        "test-role": new Uint8Array(64).fill(0xab),
      });
      expect(returned.id).toBe(context.id);
      expect(returned.status).toBe("awaitingMemproofs"); // still parked until completeMemproofs
    });

    it("provideMemproofs throws when context is not in awaitingMemproofs state", async () => {
      const domain = "https://memproof2.com";
      await permissions.grantPermission(domain);
      const context = await manager.installHapp(domain, { happBundle: createMockHappBundle() });
      expect(context.status).toBe("enabled");

      await expect(
        manager.provideMemproofs(context.id, { "test-role": new Uint8Array(64) })
      ).rejects.toThrow();
    });

    it("completeMemproofs transitions awaitingMemproofs to enabled", async () => {
      const context = await installDeferredApp("https://memproof3.com");
      expect(context.status).toBe("awaitingMemproofs");

      const updated = await manager.completeMemproofs(context.id);

      expect(updated.status).toBe("enabled");
      expect(updated.enabled).toBe(true);

      // Persisted
      const stored = await manager.getContext(context.id);
      expect(stored!.status).toBe("enabled");
    });

    it("completeMemproofs is idempotent when context is already enabled", async () => {
      const domain = "https://memproof4.com";
      await permissions.grantPermission(domain);
      const context = await manager.installHapp(domain, { happBundle: createMockHappBundle() });
      expect(context.status).toBe("enabled");

      // completeMemproofs does not guard source state — calling on an already-enabled
      // context is a no-op (re-sets enabled=true, which is already true)
      const result = await manager.completeMemproofs(context.id);
      expect(result.status).toBe("enabled");
      expect(result.enabled).toBe(true);
    });
  });

  describe("Get context", () => {
    it("should get context for domain", async () => {
      const domain = "https://gettest.com";

      await permissions.grantPermission(domain);

      const request: InstallHappRequest = {
        appName: "Get Test",
        happBundle: createMockHappBundle(),
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
        happBundle: createMockHappBundle(),
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

      const context = await manager.installHapp(domain, { happBundle: createMockHappBundle() });

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

      await manager.installHapp(domain1, { happBundle: createMockHappBundle() });
      await manager.installHapp(domain2, { happBundle: createMockHappBundle() });

      const contexts = await manager.listContexts();
      expect(contexts).toHaveLength(2);
      expect(contexts.map((c) => c.domain).sort()).toEqual([domain1, domain2].sort());
    });
  });

  describe("Touch context", () => {
    it("should update last used timestamp", async () => {
      const domain = "https://touch.com";

      await permissions.grantPermission(domain);

      const context = await manager.installHapp(domain, { happBundle: createMockHappBundle() });
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
        happBundle: createMockHappBundle(),
      };

      const context = await manager.installHapp(domain, request);
      const cellIds = manager.getCellIds(context);

      expect(cellIds).toHaveLength(1); // Mock returns 1 DNA
      expect(cellIds[0][0]).toBeInstanceOf(Uint8Array); // DNA hash
      expect(cellIds[0][1]).toEqual(context.agentPubKey); // Agent pub key
    });
  });
});
