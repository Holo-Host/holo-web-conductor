/**
 * Tests for ChromeOffscreenExecutor
 *
 * Validates the executor correctly:
 * - Manages offscreen document lifecycle
 * - Sends proper messages to offscreen for each operation
 * - Routes incoming offscreen events to registered callbacks
 * - Handles errors and timeouts
 */

import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";
import { ChromeOffscreenExecutor } from "./chrome-offscreen-executor";

// ============================================================================
// Chrome API mocks
// ============================================================================

type MessageListener = (
  message: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: any) => void
) => boolean | void;

let messageListeners: MessageListener[] = [];
let sendMessageMock: Mock;
let createDocumentMock: Mock;
let closeDocumentMock: Mock;
let getContextsMock: Mock;
let getURLMock: Mock;

function setupChromeMocks() {
  messageListeners = [];
  sendMessageMock = vi.fn();
  createDocumentMock = vi.fn();
  closeDocumentMock = vi.fn();
  getContextsMock = vi.fn();
  getURLMock = vi.fn((path: string) => `chrome-extension://fake-id/${path}`);

  // crypto.randomUUID() is used by executeZomeCall but not available in Node test env
  if (typeof globalThis.crypto === "undefined") {
    (globalThis as any).crypto = { randomUUID: () => "test-uuid-1234" };
  }

  global.chrome = {
    runtime: {
      sendMessage: sendMessageMock,
      onMessage: {
        addListener: (listener: MessageListener) => {
          messageListeners.push(listener);
        },
        removeListener: (listener: MessageListener) => {
          messageListeners = messageListeners.filter((l) => l !== listener);
        },
      },
      getContexts: getContextsMock,
      getURL: getURLMock,
      ContextType: { OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT" },
    },
    offscreen: {
      createDocument: createDocumentMock,
      closeDocument: closeDocumentMock,
      Reason: { WORKERS: "WORKERS" },
    },
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
      },
    },
  } as any;
}

/**
 * Simulate an incoming message from the offscreen document to background
 */
function simulateOffscreenMessage(message: any): Promise<any> {
  return new Promise((resolve) => {
    for (const listener of messageListeners) {
      const result = listener(message, {} as any, resolve);
      if (result === true) return; // Async response pending
    }
    // Synchronous - resolve with undefined
    resolve(undefined);
  });
}

/**
 * Create an executor and simulate the offscreen document becoming ready
 */
async function createReadyExecutor(): Promise<ChromeOffscreenExecutor> {
  getContextsMock.mockResolvedValue([]); // No existing offscreen
  createDocumentMock.mockResolvedValue(undefined);

  const executor = new ChromeOffscreenExecutor();

  // Start initialization
  const initPromise = executor.initialize();

  // Simulate OFFSCREEN_READY message
  await vi.waitFor(() => {
    expect(createDocumentMock).toHaveBeenCalled();
  });
  simulateOffscreenMessage({ target: "background", type: "OFFSCREEN_READY" });

  await initPromise;

  // After initialization, mock getContexts to return an existing document
  // so subsequent ensureOffscreenDocument() calls take the fast path.
  getContextsMock.mockResolvedValue([{ documentUrl: "chrome-extension://fake-id/offscreen/offscreen.html" }]);

  return executor;
}

// ============================================================================
// Tests
// ============================================================================

describe("ChromeOffscreenExecutor", () => {
  beforeEach(() => {
    setupChromeMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  describe("lifecycle", () => {
    it("creates offscreen document on initialize()", async () => {
      getContextsMock.mockResolvedValue([]);
      createDocumentMock.mockResolvedValue(undefined);

      const executor = new ChromeOffscreenExecutor();

      const initPromise = executor.initialize();

      // Simulate ready
      await vi.waitFor(() => {
        expect(createDocumentMock).toHaveBeenCalledWith({
          url: "offscreen/offscreen.html",
          reasons: ["WORKERS"],
          justification: expect.any(String),
        });
      });
      simulateOffscreenMessage({ target: "background", type: "OFFSCREEN_READY" });

      await initPromise;
      expect(executor.isReady()).toBe(true);
    });

    it("skips creation if offscreen already exists and ready", async () => {
      getContextsMock.mockResolvedValue([{ documentUrl: "chrome-extension://fake-id/offscreen/offscreen.html" }]);

      const executor = new ChromeOffscreenExecutor();

      // Simulate ready first
      simulateOffscreenMessage({ target: "background", type: "OFFSCREEN_READY" });

      await executor.initialize();
      expect(createDocumentMock).not.toHaveBeenCalled();
    });

    it("reports isReady() false before initialization", () => {
      const executor = new ChromeOffscreenExecutor();
      expect(executor.isReady()).toBe(false);
    });

    it("reports networkConfigured false initially", () => {
      const executor = new ChromeOffscreenExecutor();
      expect(executor.networkConfigured).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Network configuration
  // --------------------------------------------------------------------------

  describe("configureNetwork", () => {
    it("sends CONFIGURE_NETWORK to offscreen", async () => {
      sendMessageMock.mockResolvedValue({ success: true });
      const executor = await createReadyExecutor();

      await executor.configureNetwork({ gatewayUrl: "http://localhost:8090", sessionToken: "tok" });

      expect(sendMessageMock).toHaveBeenCalledWith({
        target: "offscreen",
        type: "CONFIGURE_NETWORK",
        gatewayUrl: "http://localhost:8090",
        sessionToken: "tok",
      });
      expect(executor.networkConfigured).toBe(true);
    });
  });

  describe("updateSessionToken", () => {
    it("sends UPDATE_SESSION_TOKEN when network is configured", async () => {
      sendMessageMock.mockResolvedValue({ success: true });
      const executor = await createReadyExecutor();
      await executor.configureNetwork({ gatewayUrl: "http://localhost:8090" });

      await executor.updateSessionToken("new-token");

      expect(sendMessageMock).toHaveBeenCalledWith({
        target: "offscreen",
        type: "UPDATE_SESSION_TOKEN",
        sessionToken: "new-token",
      });
    });

    it("skips when network is not configured", async () => {
      const executor = new ChromeOffscreenExecutor();
      sendMessageMock.mockClear();

      await executor.updateSessionToken("token");

      expect(sendMessageMock).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Agent registration
  // --------------------------------------------------------------------------

  describe("registerAgent", () => {
    it("sends REGISTER_AGENT with base64 hashes", async () => {
      sendMessageMock.mockResolvedValue({ success: true });
      const executor = await createReadyExecutor();
      await executor.configureNetwork({ gatewayUrl: "http://localhost:8090" });

      await executor.registerAgent("uhC0k_dna_hash_b64", "uhCAk_agent_b64");

      expect(sendMessageMock).toHaveBeenCalledWith({
        target: "offscreen",
        type: "REGISTER_AGENT",
        dna_hash: "uhC0k_dna_hash_b64",
        agent_pubkey: "uhCAk_agent_b64",
      });
    });

    it("skips when network is not configured", async () => {
      const executor = new ChromeOffscreenExecutor();
      sendMessageMock.mockClear();

      await executor.registerAgent("dna", "agent");

      expect(sendMessageMock).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Zome execution
  // --------------------------------------------------------------------------

  describe("executeZomeCall", () => {
    it("sends EXECUTE_ZOME_CALL with MinimalZomeCallRequest format", async () => {
      const mockResult = { success: true, result: { Ok: "test" }, signals: [] };
      sendMessageMock.mockResolvedValue(mockResult);
      const executor = await createReadyExecutor();

      const request = {
        dnaWasm: new Uint8Array(0),
        cellId: [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])] as [Uint8Array, Uint8Array],
        zome: "test_zome",
        fn: "test_fn",
        payload: new Uint8Array([7, 8, 9]),
        provenance: new Uint8Array([4, 5, 6]),
      };

      const result = await executor.executeZomeCall("ctx-1", request);

      expect(result.result).toEqual({ Ok: "test" });
      expect(result.signals).toEqual([]);

      // Verify the message format
      const call = sendMessageMock.mock.calls.find(
        (c: any[]) => c[0]?.type === "EXECUTE_ZOME_CALL"
      );
      expect(call).toBeDefined();
      expect(call![0].target).toBe("offscreen");
      expect(call![0].zomeCallRequest).toEqual({
        contextId: "ctx-1",
        dnaHashBase64: expect.any(String),
        cellId: [[1, 2, 3], [4, 5, 6]],
        zome: "test_zome",
        fn: "test_fn",
        payload: [7, 8, 9],
        provenance: [4, 5, 6],
      });
    });

    it("throws on failed response", async () => {
      sendMessageMock.mockResolvedValue({ success: false, error: "WASM trap" });
      const executor = await createReadyExecutor();

      const request = {
        dnaWasm: new Uint8Array(0),
        cellId: [new Uint8Array([1]), new Uint8Array([2])] as [Uint8Array, Uint8Array],
        zome: "z",
        fn: "f",
        payload: new Uint8Array([]),
        provenance: new Uint8Array([2]),
      };

      await expect(executor.executeZomeCall("ctx", request)).rejects.toThrow("WASM trap");
    });
  });

  // --------------------------------------------------------------------------
  // Gateway connectivity
  // --------------------------------------------------------------------------

  describe("gateway connectivity", () => {
    it("disconnectGateway sends GATEWAY_DISCONNECT", async () => {
      sendMessageMock.mockResolvedValue({ success: true });
      const executor = await createReadyExecutor();

      await executor.disconnectGateway();

      expect(sendMessageMock).toHaveBeenCalledWith({
        target: "offscreen",
        type: "GATEWAY_DISCONNECT",
      });
    });

    it("reconnectGateway sends GATEWAY_RECONNECT", async () => {
      sendMessageMock.mockResolvedValue({ success: true });
      const executor = await createReadyExecutor();

      await executor.reconnectGateway();

      expect(sendMessageMock).toHaveBeenCalledWith({
        target: "offscreen",
        type: "GATEWAY_RECONNECT",
      });
    });

    it("getWebSocketState returns parsed state", async () => {
      sendMessageMock.mockResolvedValue({
        success: true,
        state: "connected",
        isConnected: true,
        registrations: [{ dna_hash: "dna1", agent_pubkey: "agent1" }],
      });
      const executor = await createReadyExecutor();

      const state = await executor.getWebSocketState();

      expect(state.isConnected).toBe(true);
      expect(state.state).toBe("connected");
      expect(state.registrations).toHaveLength(1);
    });

    it("getWebSocketState returns disconnected on error", async () => {
      sendMessageMock.mockRejectedValue(new Error("no offscreen"));
      const executor = new ChromeOffscreenExecutor();

      const state = await executor.getWebSocketState();

      expect(state.isConnected).toBe(false);
      expect(state.state).toBe("disconnected");
    });
  });

  // --------------------------------------------------------------------------
  // Records & publishing
  // --------------------------------------------------------------------------

  describe("getAllRecords", () => {
    it("sends GET_ALL_RECORDS and returns records", async () => {
      sendMessageMock.mockResolvedValue({ success: true, records: [{ id: 1 }, { id: 2 }] });
      const executor = await createReadyExecutor();

      const result = await executor.getAllRecords([1, 2, 3], [4, 5, 6]);

      expect(sendMessageMock).toHaveBeenCalledWith({
        target: "offscreen",
        type: "GET_ALL_RECORDS",
        dnaHash: [1, 2, 3],
        agentPubKey: [4, 5, 6],
      });
      expect(result.records).toHaveLength(2);
    });

    it("throws on failure", async () => {
      sendMessageMock.mockResolvedValue({ success: false, error: "no records" });
      const executor = await createReadyExecutor();

      await expect(executor.getAllRecords([1], [2])).rejects.toThrow("no records");
    });
  });

  describe("processPublishQueue", () => {
    it("sends PROCESS_PUBLISH_QUEUE with dnaHashes", async () => {
      sendMessageMock.mockResolvedValue({ success: true });
      const executor = await createReadyExecutor();

      await executor.processPublishQueue([[1, 2], [3, 4]]);

      expect(sendMessageMock).toHaveBeenCalledWith({
        target: "offscreen",
        type: "PROCESS_PUBLISH_QUEUE",
        dnaHashes: [[1, 2], [3, 4]],
      });
    });
  });

  // --------------------------------------------------------------------------
  // Event callbacks
  // --------------------------------------------------------------------------

  describe("event callbacks", () => {
    it("onRemoteSignal fires when REMOTE_SIGNAL message arrives", async () => {
      const executor = new ChromeOffscreenExecutor();
      const callback = vi.fn();
      executor.onRemoteSignal(callback);

      const signalData = {
        target: "background",
        type: "REMOTE_SIGNAL",
        dna_hash: "dna_b64",
        to_agent: "agent_b64",
        from_agent: "sender_b64",
        zome_name: "profiles",
        signal: [1, 2, 3],
      };

      await simulateOffscreenMessage(signalData);

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          dna_hash: "dna_b64",
          to_agent: "agent_b64",
          zome_name: "profiles",
          signal: [1, 2, 3],
        })
      );
    });

    it("onSignRequest fires and returns result", async () => {
      const executor = new ChromeOffscreenExecutor();
      const callback = vi.fn().mockResolvedValue({
        success: true,
        signature: [10, 20, 30],
      });
      executor.onSignRequest(callback);

      const response = await simulateOffscreenMessage({
        target: "background",
        type: "SIGN_REQUEST",
        agent_pubkey: [1, 2, 3],
        message: [4, 5, 6],
      });

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_pubkey: [1, 2, 3],
          message: [4, 5, 6],
        })
      );
      expect(response).toEqual({ success: true, signature: [10, 20, 30] });
    });

    it("onWebSocketStateChange fires on WS_STATE_CHANGE", async () => {
      const executor = new ChromeOffscreenExecutor();
      const callback = vi.fn();
      executor.onWebSocketStateChange(callback);

      simulateOffscreenMessage({
        target: "background",
        type: "WS_STATE_CHANGE",
        state: "connected",
      });

      expect(callback).toHaveBeenCalledWith("connected");
    });

    it("ignores non-background messages", () => {
      const executor = new ChromeOffscreenExecutor();
      const callback = vi.fn();
      executor.onRemoteSignal(callback);

      // Message not targeted at background
      simulateOffscreenMessage({ target: "offscreen", type: "REMOTE_SIGNAL" });

      expect(callback).not.toHaveBeenCalled();
    });
  });
});
