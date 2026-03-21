/**
 * Tests for FirefoxDirectExecutor
 *
 * Validates:
 * - HTTP 401 from worker triggers WebSocket re-auth
 * - triggerReauth skips if WS is already reconnecting
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { FirefoxDirectExecutor } from "./firefox-direct-executor";

// ============================================================================
// Mocks
// ============================================================================

function setupChromeMocks() {
  global.chrome = {
    runtime: {
      getURL: vi.fn((path: string) => `moz-extension://fake-id/${path}`),
    },
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
      },
    },
  } as any;
}

describe("FirefoxDirectExecutor", () => {
  let executor: FirefoxDirectExecutor;

  beforeEach(() => {
    vi.clearAllMocks();
    setupChromeMocks();
    executor = new FirefoxDirectExecutor();
  });

  describe("triggerReauth", () => {
    it("calls disconnect and connect on wsService", () => {
      const mockWsService = {
        getState: vi.fn().mockReturnValue("connected"),
        disconnect: vi.fn(),
        connect: vi.fn(),
      };

      // Inject mock wsService via the protected field
      (executor as any).wsService = mockWsService;

      executor.triggerReauth();

      expect(mockWsService.disconnect).toHaveBeenCalledOnce();
      expect(mockWsService.connect).toHaveBeenCalledOnce();
    });

    it("skips re-auth if already connecting", () => {
      const mockWsService = {
        getState: vi.fn().mockReturnValue("connecting"),
        disconnect: vi.fn(),
        connect: vi.fn(),
      };
      (executor as any).wsService = mockWsService;

      executor.triggerReauth();

      expect(mockWsService.disconnect).not.toHaveBeenCalled();
      expect(mockWsService.connect).not.toHaveBeenCalled();
    });

    it("skips re-auth if already authenticating", () => {
      const mockWsService = {
        getState: vi.fn().mockReturnValue("authenticating"),
        disconnect: vi.fn(),
        connect: vi.fn(),
      };
      (executor as any).wsService = mockWsService;

      executor.triggerReauth();

      expect(mockWsService.disconnect).not.toHaveBeenCalled();
      expect(mockWsService.connect).not.toHaveBeenCalled();
    });

    it("skips re-auth if already reconnecting", () => {
      const mockWsService = {
        getState: vi.fn().mockReturnValue("reconnecting"),
        disconnect: vi.fn(),
        connect: vi.fn(),
      };
      (executor as any).wsService = mockWsService;

      executor.triggerReauth();

      expect(mockWsService.disconnect).not.toHaveBeenCalled();
      expect(mockWsService.connect).not.toHaveBeenCalled();
    });

    it("is a no-op if wsService is null", () => {
      (executor as any).wsService = null;
      // Should not throw
      executor.triggerReauth();
    });
  });

  describe("HTTP_401_DETECTED worker message", () => {
    it("triggers re-auth when worker sends HTTP_401_DETECTED", () => {
      const mockWsService = {
        getState: vi.fn().mockReturnValue("connected"),
        disconnect: vi.fn(),
        connect: vi.fn(),
      };
      (executor as any).wsService = mockWsService;

      // Simulate the worker message handler directly
      const handleWorkerMessage = (executor as any).handleWorkerMessage.bind(executor);
      handleWorkerMessage({ data: { type: "HTTP_401_DETECTED" } });

      expect(mockWsService.disconnect).toHaveBeenCalledOnce();
      expect(mockWsService.connect).toHaveBeenCalledOnce();
    });
  });
});
