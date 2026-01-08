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
      gatewayWsUrl: "ws://localhost:8090/ws",
      sessionToken: "test-token",
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
    it("should connect to the gateway", () => {
      const service = new WebSocketNetworkService(options);
      const stateCallback = vi.fn();
      service.onStateChange(stateCallback);

      service.connect();
      expect(service.getState()).toBe("connecting");
      expect(mockWs.url).toBe("ws://localhost:8090/ws");

      // Simulate connection open
      mockWs.simulateOpen();
      expect(stateCallback).toHaveBeenCalledWith("authenticating");
    });

    it("should disconnect gracefully", () => {
      const service = new WebSocketNetworkService(options);
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
    it("should send auth message after connecting", () => {
      const service = new WebSocketNetworkService(options);
      service.connect();
      mockWs.simulateOpen();

      expect(mockWs.sentMessages).toContainEqual(
        JSON.stringify({ type: "auth", session_token: "test-token" })
      );
    });

    it("should handle auth_ok", () => {
      const service = new WebSocketNetworkService(options);
      const stateCallback = vi.fn();
      service.onStateChange(stateCallback);

      service.connect();
      mockWs.simulateOpen();
      mockWs.simulateMessage({ type: "auth_ok" });

      expect(service.isConnected()).toBe(true);
      expect(stateCallback).toHaveBeenCalledWith("connected");
    });

    it("should handle auth_error", () => {
      const service = new WebSocketNetworkService(options);
      service.connect();
      mockWs.simulateOpen();

      mockWs.simulateMessage({ type: "auth_error", message: "Invalid token" });

      expect(service.isConnected()).toBe(false);
      expect(service.getState()).toBe("connected"); // Still connected, just not authenticated
    });

    it("should send empty auth if no token provided", () => {
      const service = new WebSocketNetworkService({
        ...options,
        sessionToken: undefined,
      });

      service.connect();
      mockWs.simulateOpen();

      // Should send auth with empty token (gateway accepts this when no authenticator configured)
      expect(mockWs.sentMessages).toContainEqual(
        JSON.stringify({ type: "auth", session_token: "" })
      );
    });
  });

  describe("agent registration", () => {
    it("should register agent after authentication", () => {
      const service = new WebSocketNetworkService(options);
      service.connect();
      mockWs.simulateOpen();
      mockWs.simulateMessage({ type: "auth_ok" });

      service.registerAgent("dna123", "agent456");

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

      // Should not have sent yet (not authenticated)
      expect(
        mockWs.sentMessages.find(
          (m) => m.includes("register") && !m.includes("auth")
        )
      ).toBeUndefined();

      // Authenticate
      mockWs.simulateMessage({ type: "auth_ok" });

      // Now should have sent
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
      service.connect();
      mockWs.simulateOpen();
      mockWs.simulateMessage({ type: "auth_ok" });

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

    it("should always send registration (for gateway sync) but not duplicate internal tracking", () => {
      const service = new WebSocketNetworkService(options);
      service.connect();
      mockWs.simulateOpen();
      mockWs.simulateMessage({ type: "auth_ok" });

      service.registerAgent("dna123", "agent456");
      service.registerAgent("dna123", "agent456"); // Duplicate call

      // Messages are always sent - gateway may have lost state
      const registerMessages = mockWs.sentMessages.filter(
        (m) => m.includes('"type":"register"')
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
      service.connect();
      mockWs.simulateOpen();
      mockWs.simulateMessage({ type: "auth_ok" });

      service.registerAgent("dna1", "agent1");
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

      service.connect();
      mockWs.simulateOpen();
      mockWs.simulateMessage({ type: "auth_ok" });

      // Simulate signal from gateway (signal is base64 encoded)
      const signalData = btoa("test signal data");
      mockWs.simulateMessage({
        type: "signal",
        dna_hash: "dna123",
        from_agent: "agent789",
        zome_name: "test_zome",
        signal: signalData,
      });

      expect(signalCallback).toHaveBeenCalledWith({
        dna_hash: "dna123",
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

      service.connect();
      mockWs.simulateOpen();
      mockWs.simulateMessage({ type: "auth_ok" });

      // Should not throw
      mockWs.simulateMessage({
        type: "signal",
        dna_hash: "dna123",
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
      service.connect();
      mockWs.simulateOpen();
      mockWs.simulateMessage({ type: "auth_ok" });

      // Simulate connection loss
      mockWs.simulateClose(1006);

      expect(service.getState()).toBe("reconnecting");

      vi.useRealTimers();
    });

    it("should not reconnect after intentional disconnect", () => {
      const service = new WebSocketNetworkService(options);
      service.connect();
      mockWs.simulateOpen();
      mockWs.simulateMessage({ type: "auth_ok" });

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
      service.connect();
      mockWs.simulateOpen();
      mockWs.simulateMessage({ type: "auth_ok" });

      // Should not throw
      mockWs.simulateMessage({
        type: "registered",
        dna_hash: "dna123",
        agent_pubkey: "agent456",
      });
    });

    it("should handle unregistered message", () => {
      const service = new WebSocketNetworkService(options);
      service.connect();
      mockWs.simulateOpen();
      mockWs.simulateMessage({ type: "auth_ok" });

      // Should not throw
      mockWs.simulateMessage({
        type: "unregistered",
        dna_hash: "dna123",
        agent_pubkey: "agent456",
      });
    });

    it("should handle error message", () => {
      const service = new WebSocketNetworkService(options);
      service.connect();
      mockWs.simulateOpen();
      mockWs.simulateMessage({ type: "auth_ok" });

      // Should not throw
      mockWs.simulateMessage({
        type: "error",
        message: "Something went wrong",
      });
    });

    it("should handle pong message", () => {
      const service = new WebSocketNetworkService(options);
      service.connect();
      mockWs.simulateOpen();
      mockWs.simulateMessage({ type: "auth_ok" });

      // Should not throw
      mockWs.simulateMessage({ type: "pong" });
    });
  });
});
