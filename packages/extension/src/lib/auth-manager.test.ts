/**
 * Tests for authorization request management
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AuthManager } from "./auth-manager";
import type { ResponseMessage } from "./messaging";

describe("AuthManager", () => {
  let manager: AuthManager;

  beforeEach(() => {
    manager = new AuthManager();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should create auth request", async () => {
    const req = await manager.createAuthRequest("https://example.com", 123, "msg-id");
    expect(req.origin).toBe("https://example.com");
    expect(req.tabId).toBe(123);
    expect(req.messageId).toBe("msg-id");
    expect(req.id).toBeDefined();
    expect(req.timestamp).toBeGreaterThan(0);
  });

  it("should retrieve auth request by ID", async () => {
    const req = await manager.createAuthRequest("https://example.com", 123, "msg-id");
    const retrieved = await manager.getAuthRequest(req.id);
    expect(retrieved).toEqual(req);
  });

  it("should resolve auth request", async () => {
    const req = await manager.createAuthRequest("https://example.com", 123, "msg-id");

    const mockResponse: ResponseMessage = {
      id: "response-id",
      type: "success" as any,
      timestamp: Date.now(),
      requestId: "msg-id",
      payload: { connected: true },
    };

    const mockCallback = vi.fn();
    manager.setPendingCallback(req.id, mockCallback);

    const resolved = await manager.resolveAuthRequest(req.id, mockResponse);
    expect(resolved).toBe(true);
    expect(mockCallback).toHaveBeenCalledWith(mockResponse);

    // Request should be removed after resolution
    const retrieved = await manager.getAuthRequest(req.id);
    expect(retrieved).toBeUndefined();
  });

  it("should return false when resolving unknown request", async () => {
    const mockResponse: ResponseMessage = {
      id: "response-id",
      type: "success" as any,
      timestamp: Date.now(),
      requestId: "msg-id",
    };

    const resolved = await manager.resolveAuthRequest("unknown-id", mockResponse);
    expect(resolved).toBe(false);
  });

  it("should timeout auth request after 2 minutes", async () => {
    const req = await manager.createAuthRequest("https://example.com", 123, "msg-id");

    const mockCallback = vi.fn();
    manager.setPendingCallback(req.id, mockCallback);

    // Fast-forward time by 2 minutes
    vi.advanceTimersByTime(120000);

    // Callback should have been called with timeout error
    expect(mockCallback).toHaveBeenCalled();
    const callArgs = mockCallback.mock.calls[0][0];
    expect(callArgs.type).toBe("error");
    expect(callArgs.error).toContain("timed out");

    // Request should be removed
    const retrieved = await manager.getAuthRequest(req.id);
    expect(retrieved).toBeUndefined();
  });

  it("should not timeout if resolved before timeout", async () => {
    const req = await manager.createAuthRequest("https://example.com", 123, "msg-id");

    const mockCallback = vi.fn();
    manager.setPendingCallback(req.id, mockCallback);

    const mockResponse: ResponseMessage = {
      id: "response-id",
      type: "success" as any,
      timestamp: Date.now(),
      requestId: "msg-id",
      payload: { connected: true },
    };

    // Resolve before timeout
    await manager.resolveAuthRequest(req.id, mockResponse);

    // Advance time past timeout
    vi.advanceTimersByTime(120000);

    // Callback should only be called once (from resolution, not timeout)
    expect(mockCallback).toHaveBeenCalledTimes(1);
    expect(mockCallback.mock.calls[0][0]).toEqual(mockResponse);
  });

  it("should track pending request count", async () => {
    expect(manager.getPendingCount()).toBe(0);

    const req1 = await manager.createAuthRequest("https://example.com", 123, "msg-1");
    expect(manager.getPendingCount()).toBe(1);

    const req2 = await manager.createAuthRequest("https://another.com", 124, "msg-2");
    expect(manager.getPendingCount()).toBe(2);

    await manager.resolveAuthRequest(req1.id, {} as any);
    expect(manager.getPendingCount()).toBe(1);

    await manager.resolveAuthRequest(req2.id, {} as any);
    expect(manager.getPendingCount()).toBe(0);
  });

  it("should cleanup expired requests", async () => {
    const req1 = await manager.createAuthRequest("https://example.com", 123, "msg-1");
    const req2 = await manager.createAuthRequest("https://another.com", 124, "msg-2");

    expect(manager.getPendingCount()).toBe(2);

    // Advance time past timeout
    vi.advanceTimersByTime(125000);

    // Manual cleanup (timeouts should have already fired)
    manager.cleanupExpired();

    expect(manager.getPendingCount()).toBe(0);
  });

  it("should generate unique request IDs", async () => {
    const req1 = await manager.createAuthRequest("https://example.com", 123, "msg-1");
    const req2 = await manager.createAuthRequest("https://example.com", 123, "msg-1");

    expect(req1.id).not.toBe(req2.id);
  });
});
