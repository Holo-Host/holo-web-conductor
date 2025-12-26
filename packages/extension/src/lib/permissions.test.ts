/**
 * Tests for permission management
 */

import { describe, it, expect, beforeEach } from "vitest";
import { PermissionManager } from "./permissions";

// Mock chrome.storage.local
const mockStorage: Record<string, any> = {};

global.chrome = {
  storage: {
    local: {
      get: async (key: string) => {
        return { [key]: mockStorage[key] };
      },
      set: async (items: Record<string, any>) => {
        Object.assign(mockStorage, items);
      },
      remove: async (key: string) => {
        delete mockStorage[key];
      },
    },
  },
} as any;

describe("PermissionManager", () => {
  let manager: PermissionManager;

  beforeEach(async () => {
    // Clear storage before each test
    Object.keys(mockStorage).forEach((key) => delete mockStorage[key]);
    manager = new PermissionManager();
    // Wait for initialization
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it("should grant permission for origin", async () => {
    await manager.grantPermission("https://example.com");
    const perm = await manager.checkPermission("https://example.com");
    expect(perm?.granted).toBe(true);
    expect(perm?.origin).toBe("https://example.com");
  });

  it("should deny permission for origin", async () => {
    await manager.denyPermission("https://evil.com");
    const perm = await manager.checkPermission("https://evil.com");
    expect(perm?.granted).toBe(false);
    expect(perm?.origin).toBe("https://evil.com");
  });

  it("should revoke permission", async () => {
    await manager.grantPermission("https://example.com");
    await manager.revokePermission("https://example.com");
    const perm = await manager.checkPermission("https://example.com");
    expect(perm).toBeUndefined();
  });

  it("should persist permissions across instances", async () => {
    await manager.grantPermission("https://example.com");

    // Create new instance
    const newManager = new PermissionManager();
    await new Promise((resolve) => setTimeout(resolve, 50)); // Wait for init

    const perm = await newManager.checkPermission("https://example.com");
    expect(perm?.granted).toBe(true);
  });

  it("should list all permissions", async () => {
    await manager.grantPermission("https://example.com");
    await manager.denyPermission("https://evil.com");

    const list = await manager.listPermissions();
    expect(list).toHaveLength(2);

    const origins = list.map((p) => p.origin);
    expect(origins).toContain("https://example.com");
    expect(origins).toContain("https://evil.com");
  });

  it("should clear all permissions", async () => {
    await manager.grantPermission("https://example.com");
    await manager.grantPermission("https://another.com");

    await manager.clearAllPermissions();

    const list = await manager.listPermissions();
    expect(list).toHaveLength(0);
  });

  it("should handle no permission set", async () => {
    const perm = await manager.checkPermission("https://unknown.com");
    expect(perm).toBeUndefined();
  });

  it("should store timestamp when granting permission", async () => {
    const beforeTimestamp = Date.now();
    await manager.grantPermission("https://example.com");
    const afterTimestamp = Date.now();

    const perm = await manager.checkPermission("https://example.com");
    expect(perm?.timestamp).toBeGreaterThanOrEqual(beforeTimestamp);
    expect(perm?.timestamp).toBeLessThanOrEqual(afterTimestamp);
  });

  it("should update permission if granted after denied", async () => {
    await manager.denyPermission("https://example.com");
    await manager.grantPermission("https://example.com");

    const perm = await manager.checkPermission("https://example.com");
    expect(perm?.granted).toBe(true);
  });
});
