/**
 * Tests for WebSocket Network Service
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  WebSocketNetworkService,
  type ServerMessage,
  type WebSocketServiceOptions,
} from "./websocket-service";

// Polyfill CloseEvent for Node.js
class MockCloseEvent extends Event {
  code: number;
  reason: string;
  wasClean: boolean;

  constructor(
    type: string,
    init?: { code?: number; reason?: string; wasClean?: boolean }
  ) {
    super(type);
    this.code = init?.code ?? 1000;
    this.reason = init?.reason ?? "";
    this.wasClean = init?.wasClean ?? true;
  }
}

// Make CloseEvent available globally
(globalThis as any).CloseEvent = MockCloseEvent;

// Store original WebSocket
const originalWebSocket = globalThis.WebSocket;

// Helper to create a mock WebSocket that opens immediately
function createMockWebSocket() {
  const mockWs = {
    readyState: 0, // CONNECTING
    url: "",
    sentMessages: [] as string[],
    onopen: null as ((event: Event) => void) | null,
    onmessage: null as ((event: MessageEvent) => void) | null,
    onerror: null as ((event: Event) => void) | null,
    onclose: null as ((event: MockCloseEvent) => void) | null,

    send(data: string): void {
      this.sentMessages.push(data);
    },

    close(): void {
      this.readyState = 3; // CLOSED
      this.onclose?.(new MockCloseEvent("close", { code: 1000 }));
    },

    // Test helpers
    simulateOpen(): void {
      this.readyState = 1; // OPEN
      this.onopen?.(new Event("open"));
    },

    simulateMessage(data: ServerMessage): void {
      this.onmessage?.(
        new MessageEvent("message", { data: JSON.stringify(data) })
      );
    },

    simulateClose(code = 1006, reason = ""): void {
      this.readyState = 3; // CLOSED
      this.onclose?.(new MockCloseEvent("close", { code, reason }));
    },
  };

  return mockWs;
}

describe("WebSocketNetworkService", () => {
  let mockWs: ReturnType<typeof createMockWebSocket>;
  let options: WebSocketServiceOptions;
  let wsConstructorCalls: string[];

  beforeEach(() => {
    wsConstructorCalls = [];

    // Replace global WebSocket with mock that doesn't auto-open
    (globalThis as any).WebSocket = vi.fn((url: string) => {
      wsConstructorCalls.push(url);
      mockWs = createMockWebSocket();
      mockWs.url = url;
      return mockWs;
    });
    (globalThis.WebSocket as any).CONNECTING = 0;
    (globalThis.WebSocket as any).OPEN = 1;
    (globalThis.WebSocket as any).CLOSING = 2;
    (globalThis.WebSocket as any).CLOSED = 3;

    options = {
      linkerWsUrl: "ws://localhost:8090/ws",
      heartbeatInterval: 30000, // Long enough to not interfere
      heartbeatTimeout: 5000,
      reconnectBaseDelay: 1000,
      reconnectMaxDelay: 30000,
    };
  });

  afterEach(() => {
    (globalThis as any).WebSocket = originalWebSocket;
  });

  describe("connection", () => {
    it("should connect to the linker", () => {
      const service = new WebSocketNetworkService(options);
      service.connect();
      expect(service.getState()).toBe("connecting");
      expect(mockWs.url).toBe("ws://localhost:8090/ws");
    });

    it("should disconnect gracefully", () => {
      const service = new WebSocketNetworkService(options);
      service.registerAgent("dna123", "agent456");
      service.connect();
      mockWs.simulateOpen();

      service.disconnect();
      expect(service.getState()).toBe("disconnected");
    });

    it("should be disconnected initially", () => {
      const service = new WebSocketNetworkService(options);
      expect(service.getState()).toBe("disconnected");
      expect(service.isConnected()).toBe(false);
    });
  });

  describe("authentication", () => {
    it("should send auth with agent pubkey on open when pending registrations exist", () => {
      const service = new WebSocketNetworkService(options);
      const stateCallback = vi.fn();
      service.onStateChange(stateCallback);

      service.registerAgent("dna123", "agent456");
      service.connect();
      mockWs.simulateOpen();

      expect(stateCallback).toHaveBeenCalledWith("authenticating");
      expect(mockWs.sentMessages).toContainEqual(
        JSON.stringify({ type: "auth", agent_pubkey: "agent456" })
      );
    });

    it("should defer auth when no pending registrations", () => {
      const service = new WebSocketNetworkService(options);
      service.connect();
      mockWs.simulateOpen();

      // No auth message sent - waiting for registerAgent()
      const authMessages = mockWs.sentMessages.filter(
        (m) => JSON.parse(m).type === "auth"
      );
      expect(authMessages).toHaveLength(0);
    });

    it("should trigger auth when registerAgent called on open unauthenticated connection", () => {
      const service = new WebSocketNetworkService(options);
      service.connect();
      mockWs.simulateOpen();

      // No auth yet
      expect(mockWs.sentMessages.filter(m => JSON.parse(m).type === "auth")).toHaveLength(0);

      // registerAgent triggers auth
      service.registerAgent("dna123", "agent456");

      expect(mockWs.sentMessages).toContainEqual(
        JSON.stringify({ type: "auth", agent_pubkey: "agent456" })
      );
      expect(service.getState()).toBe("authenticating");
    });

    it("should handle auth_ok", () => {
      const service = new WebSocketNetworkService(options);
      const stateCallback = vi.fn();
      service.onStateChange(stateCallback);

      service.registerAgent("dna123", "agent456");
      service.connect();
      mockWs.simulateOpen();
      mockWs.simulateMessage({ type: "auth_ok", session_token: "" });

      expect(service.isConnected()).toBe(true);
      expect(stateCallback).toHaveBeenCalledWith("connected");
    });

    it("should handle auth_error", () => {
      const service = new WebSocketNetworkService(options);
      service.registerAgent("dna123", "agent456");
      service.connect();
      mockWs.simulateOpen();

      mockWs.simulateMessage({ type: "auth_error", message: "Invalid agent" });

      expect(service.isConnected()).toBe(false);
      expect(service.getState()).toBe("connected"); // Still connected, just not authenticated
    });
  });

  describe("agent registration", () => {
    it("should register agent after authentication", () => {
      const service = new WebSocketNetworkService(options);
      service.registerAgent("dna123", "agent456");
      service.connect();
      mockWs.simulateOpen();
      mockWs.simulateMessage({ type: "auth_ok", session_token: "" });

      // Pending registration should have been sent after auth_ok
      expect(mockWs.sentMessages).toContainEqual(
        JSON.stringify({
          type: "register",
          dna_hash: "dna123",
          agent_pubkey: "agent456",
        })
      );
    });

    it("should queue registrations before authentication", () => {
      const service = new WebSocketNetworkService(options);

      // Register before connecting
      service.registerAgent("dna123", "agent456");

      service.connect();
      mockWs.simulateOpen();

      // Should have sent auth but not register yet
      expect(
        mockWs.sentMessages.find(
          (m) => JSON.parse(m).type === "register"
        )
      ).toBeUndefined();

      // Authenticate
      mockWs.simulateMessage({ type: "auth_ok", session_token: "" });

      // Now should have sent registration
      expect(mockWs.sentMessages).toContainEqual(
        JSON.stringify({
          type: "register",
          dna_hash: "dna123",
          agent_pubkey: "agent456",
        })
      );
    });

    it("should unregister agent", () => {
      const service = new WebSocketNetworkService(options);
      service.registerAgent("dna123", "agent456");
      service.connect();
      mockWs.simulateOpen();
      mockWs.simulateMessage({ type: "auth_ok", session_token: "" });

      service.registerAgent("dna123", "agent456");
      service.unregisterAgent("dna123", "agent456");

      expect(mockWs.sentMessages).toContainEqual(
        JSON.stringify({
          type: "unregister",
          dna_hash: "dna123",
          agent_pubkey: "agent456",
        })
      );
    });

    it("should always send registration (for linker sync) but not duplicate internal tracking", () => {
      const service = new WebSocketNetworkService(options);
      service.registerAgent("dna123", "agent456");
      service.connect();
      mockWs.simulateOpen();
      mockWs.simulateMessage({ type: "auth_ok", session_token: "" });

      // First registration came from pending, now send a duplicate
      service.registerAgent("dna123", "agent456");

      // Messages are always sent - linker may have lost state
      const registerMessages = mockWs.sentMessages.filter(
        (m) => JSON.parse(m).type === "register"
      );
      expect(registerMessages).toHaveLength(2);

      // But internal tracking should not have duplicates
      expect(service.getRegistrations()).toHaveLength(1);
      expect(service.getRegistrations()[0]).toEqual({
        dna_hash: "dna123",
        agent_pubkey: "agent456",
      });
    });

    it("should track registrations", () => {
      const service = new WebSocketNetworkService(options);
      service.registerAgent("dna1", "agent1");
      service.connect();
      mockWs.simulateOpen();
      mockWs.simulateMessage({ type: "auth_ok", session_token: "" });

      service.registerAgent("dna2", "agent2");

      expect(service.getRegistrations()).toHaveLength(2);

      service.unregisterAgent("dna1", "agent1");
      expect(service.getRegistrations()).toHaveLength(1);
    });
  });

  describe("signals", () => {
    it("should receive and forward signals", () => {
      const service = new WebSocketNetworkService(options);
      const signalCallback = vi.fn();
      service.onSignal(signalCallback);

      service.registerAgent("dna123", "agent456");
      service.connect();
      mockWs.simulateOpen();
      mockWs.simulateMessage({ type: "auth_ok", session_token: "" });

      // Simulate signal from linker (signal is base64 encoded)
      const signalData = btoa("test signal data");
      mockWs.simulateMessage({
        type: "signal",
        dna_hash: "dna123",
        to_agent: "agent456",
        from_agent: "agent789",
        zome_name: "test_zome",
        signal: signalData,
      });

      expect(signalCallback).toHaveBeenCalledWith({
        dna_hash: "dna123",
        to_agent: "agent456",
        from_agent: "agent789",
        zome_name: "test_zome",
        signal: expect.any(Uint8Array),
      });

      // Verify decoded bytes
      const call = signalCallback.mock.calls[0][0];
      const decoded = new TextDecoder().decode(call.signal);
      expect(decoded).toBe("test signal data");
    });

    it("should not call callback if not set", () => {
      const service = new WebSocketNetworkService(options);
      // No signal callback set

      service.registerAgent("dna123", "agent456");
      service.connect();
      mockWs.simulateOpen();
      mockWs.simulateMessage({ type: "auth_ok", session_token: "" });

      // Should not throw
      mockWs.simulateMessage({
        type: "signal",
        dna_hash: "dna123",
        to_agent: "agent456",
        from_agent: "agent789",
        zome_name: "test_zome",
        signal: btoa("test"),
      });
    });
  });

  describe("reconnection", () => {
    it("should set state to reconnecting after connection loss", () => {
      vi.useFakeTimers();

      const service = new WebSocketNetworkService({
        ...options,
        maxReconnectAttempts: 1,
      });
      service.registerAgent("dna123", "agent456");
      service.connect();
      mockWs.simulateOpen();
      mockWs.simulateMessage({ type: "auth_ok", session_token: "" });

      // Simulate connection loss
      mockWs.simulateClose(1006);

      expect(service.getState()).toBe("reconnecting");

      vi.useRealTimers();
    });

    it("should not reconnect after intentional disconnect", () => {
      const service = new WebSocketNetworkService(options);
      service.registerAgent("dna123", "agent456");
      service.connect();
      mockWs.simulateOpen();
      mockWs.simulateMessage({ type: "auth_ok", session_token: "" });

      // Intentional disconnect
      service.disconnect();
      expect(service.getState()).toBe("disconnected");

      // Verify only one WebSocket was created
      expect(wsConstructorCalls).toHaveLength(1);
    });
  });

  describe("messages", () => {
    it("should handle registered message", () => {
      const service = new WebSocketNetworkService(options);
      service.registerAgent("dna123", "agent456");
      service.connect();
      mockWs.simulateOpen();
      mockWs.simulateMessage({ type: "auth_ok", session_token: "" });

      // Should not throw
      mockWs.simulateMessage({
        type: "registered",
        dna_hash: "dna123",
        agent_pubkey: "agent456",
      });
    });

    it("should handle unregistered message", () => {
      const service = new WebSocketNetworkService(options);
      service.registerAgent("dna123", "agent456");
      service.connect();
      mockWs.simulateOpen();
      mockWs.simulateMessage({ type: "auth_ok", session_token: "" });

      // Should not throw
      mockWs.simulateMessage({
        type: "unregistered",
        dna_hash: "dna123",
        agent_pubkey: "agent456",
      });
    });

    it("should handle error message", () => {
      const service = new WebSocketNetworkService(options);
      service.registerAgent("dna123", "agent456");
      service.connect();
      mockWs.simulateOpen();
      mockWs.simulateMessage({ type: "auth_ok", session_token: "" });

      // Should not throw
      mockWs.simulateMessage({
        type: "error",
        message: "Something went wrong",
      });
    });

    it("should handle pong message", () => {
      const service = new WebSocketNetworkService(options);
      service.registerAgent("dna123", "agent456");
      service.connect();
      mockWs.simulateOpen();
      mockWs.simulateMessage({ type: "auth_ok", session_token: "" });

      // Should not throw
      mockWs.simulateMessage({ type: "pong" });
    });

    it("should track peer count from pong", () => {
      const service = new WebSocketNetworkService(options);
      service.registerAgent("dna123", "agent456");
      service.connect();
      mockWs.simulateOpen();
      mockWs.simulateMessage({ type: "auth_ok", session_token: "" });

      expect(service.getPeerCount()).toBeUndefined();

      mockWs.simulateMessage({ type: "pong", peer_count: 5 });
      expect(service.getPeerCount()).toBe(5);

      mockWs.simulateMessage({ type: "pong", peer_count: 12 });
      expect(service.getPeerCount()).toBe(12);
    });

    it("should handle pong without peer_count (older linker)", () => {
      const service = new WebSocketNetworkService(options);
      service.registerAgent("dna123", "agent456");
      service.connect();
      mockWs.simulateOpen();
      mockWs.simulateMessage({ type: "auth_ok", session_token: "" });

      // Simulate older linker that doesn't include peer_count
      mockWs.simulateMessage({ type: "pong" });
      expect(service.getPeerCount()).toBeUndefined();
    });
  });
});
