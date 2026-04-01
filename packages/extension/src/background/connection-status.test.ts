/**
 * Tests for ConnectionStatusManager
 *
 * Covers:
 * - update() merging and lastChecked stamping
 * - Notification suppression when status is unchanged
 * - Notification on field changes
 * - lastChecked-only changes do not trigger notification
 * - statusEqual field-by-field detection (via update())
 * - Port management (addPort, removePort, sendStatusToPort)
 * - notifyConnectionStatusChange message shape and error pruning
 * - Health check lifecycle (start/stop/idempotent)
 * - checkLinkerHealth behavior under various conditions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ConnectionStatusManager } from "./connection-status";

/**
 * Flush pending microtasks (resolved promises) without advancing fake timers.
 * vi.runAllMicrotasksAsync() was added in vitest 2.2; this project uses 2.1.x.
 * Three awaited Promise.resolve() calls cover nested async chains (fetch -> then -> update).
 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ============================================================================
// Mock helpers
// ============================================================================

function createMockPort(): chrome.runtime.Port {
  return {
    postMessage: vi.fn(),
    name: "hwc-content",
    disconnect: vi.fn(),
    onDisconnect: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
      hasListener: vi.fn(),
      hasListeners: vi.fn(),
      getRules: vi.fn(),
      removeRules: vi.fn(),
      addRules: vi.fn(),
    },
    onMessage: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
      hasListener: vi.fn(),
      hasListeners: vi.fn(),
      getRules: vi.fn(),
      removeRules: vi.fn(),
      addRules: vi.fn(),
    },
  } as unknown as chrome.runtime.Port;
}

function createDeps(overrides?: {
  linkerConfig?: { linkerUrl: string } | null;
  executorReady?: boolean;
  wsState?: { isConnected: boolean; authenticated: boolean; peerCount?: number };
  wsStateError?: boolean;
}) {
  const mockLog = { info: vi.fn(), warn: vi.fn() };
  const wsState = overrides?.wsState ?? { isConnected: false, authenticated: false };
  const mockExecutor = {
    isReady: vi.fn().mockReturnValue(overrides?.executorReady ?? false),
    getWebSocketState: overrides?.wsStateError
      ? vi.fn().mockRejectedValue(new Error("ws error"))
      : vi.fn().mockResolvedValue(wsState),
  };
  const linkerConfig =
    overrides?.linkerConfig !== undefined
      ? overrides.linkerConfig
      : { linkerUrl: "http://localhost:8000" };

  const deps = {
    getLinkerConfig: vi.fn().mockReturnValue(linkerConfig),
    getExecutor: vi.fn().mockReturnValue(mockExecutor),
    log: mockLog,
  };

  return { deps, mockLog, mockExecutor };
}

// ============================================================================
// update()
// ============================================================================

describe("update()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("merges partial updates into status", () => {
    const { deps } = createDeps();
    const mgr = new ConnectionStatusManager(deps);

    mgr.update({ httpHealthy: true, linkerUrl: "http://localhost:8000" });

    const status = mgr.getStatus();
    expect(status.httpHealthy).toBe(true);
    expect(status.linkerUrl).toBe("http://localhost:8000");
    // Fields not in the partial retain their defaults
    expect(status.wsHealthy).toBe(false);
    expect(status.authenticated).toBe(false);
  });

  it("stamps lastChecked on every update", () => {
    const { deps } = createDeps();
    const mgr = new ConnectionStatusManager(deps);

    vi.setSystemTime(1000);
    mgr.update({ httpHealthy: true });
    expect(mgr.getStatus().lastChecked).toBe(1000);

    vi.setSystemTime(2000);
    // Update with same values — lastChecked still gets stamped even though no notification fires
    mgr.update({ httpHealthy: true });
    expect(mgr.getStatus().lastChecked).toBe(2000);
  });

  it("does NOT notify when status fields are unchanged", () => {
    const { deps, mockLog } = createDeps();
    const mgr = new ConnectionStatusManager(deps);
    const port = createMockPort();
    mgr.addPort(port);

    // First update changes values from default → triggers notification
    mgr.update({ httpHealthy: false, wsHealthy: false, authenticated: false, linkerUrl: null });
    const callsAfterFirst = (port.postMessage as ReturnType<typeof vi.fn>).mock.calls.length;

    // Second update with identical values → no notification
    mgr.update({ httpHealthy: false, wsHealthy: false, authenticated: false, linkerUrl: null });
    expect((port.postMessage as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFirst);
    // log.info is also not called again
    expect(mockLog.info.mock.calls.length).toBe(callsAfterFirst);
  });

  it("DOES notify when httpHealthy changes", () => {
    const { deps } = createDeps();
    const mgr = new ConnectionStatusManager(deps);
    const port = createMockPort();
    mgr.addPort(port);

    mgr.update({ httpHealthy: true });
    expect((port.postMessage as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("DOES notify when wsHealthy changes", () => {
    const { deps } = createDeps();
    const mgr = new ConnectionStatusManager(deps);
    const port = createMockPort();
    mgr.addPort(port);

    mgr.update({ wsHealthy: true });
    expect((port.postMessage as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("DOES notify when authenticated changes", () => {
    const { deps } = createDeps();
    const mgr = new ConnectionStatusManager(deps);
    const port = createMockPort();
    mgr.addPort(port);

    mgr.update({ authenticated: true });
    expect((port.postMessage as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("DOES notify when linkerUrl changes", () => {
    const { deps } = createDeps();
    const mgr = new ConnectionStatusManager(deps);
    const port = createMockPort();
    mgr.addPort(port);

    mgr.update({ linkerUrl: "http://localhost:9000" });
    expect((port.postMessage as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("DOES notify when lastError changes", () => {
    const { deps } = createDeps();
    const mgr = new ConnectionStatusManager(deps);
    const port = createMockPort();
    mgr.addPort(port);

    mgr.update({ lastError: "something went wrong" });
    expect((port.postMessage as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("DOES notify when peerCount changes", () => {
    const { deps } = createDeps();
    const mgr = new ConnectionStatusManager(deps);
    const port = createMockPort();
    mgr.addPort(port);

    mgr.update({ peerCount: 3 });
    expect((port.postMessage as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("lastChecked changes alone do NOT trigger notification", () => {
    const { deps } = createDeps();
    const mgr = new ConnectionStatusManager(deps);
    const port = createMockPort();
    mgr.addPort(port);

    // Establish a baseline that differs from the initial defaults to get a
    // clean zero count, then call update() with the same fields again
    vi.setSystemTime(100);
    mgr.update({ httpHealthy: true });
    const callsAfterChange = (port.postMessage as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfterChange).toBe(1);

    vi.setSystemTime(200);
    // Exact same field values — only lastChecked moves
    mgr.update({ httpHealthy: true });
    expect((port.postMessage as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});

// ============================================================================
// statusEqual (tested indirectly via update)
// ============================================================================

describe("statusEqual (via update)", () => {
  it("detects change in each field individually", () => {
    const fields: Array<[string, any, any]> = [
      ["httpHealthy", false, true],
      ["wsHealthy", false, true],
      ["authenticated", false, true],
      ["linkerUrl", null, "http://x"],
      ["lastError", undefined, "err"],
      ["peerCount", undefined, 5],
    ];

    for (const [field, initial, changed] of fields) {
      const { deps } = createDeps();
      const mgr = new ConnectionStatusManager(deps);
      const port = createMockPort();
      mgr.addPort(port);

      // Bring to initial state (may or may not fire)
      mgr.update({ [field]: initial });
      const countAfterInit = (port.postMessage as ReturnType<typeof vi.fn>).mock.calls.length;

      // Apply the changed value — must fire
      mgr.update({ [field]: changed });
      expect(
        (port.postMessage as ReturnType<typeof vi.fn>).mock.calls.length,
        `expected notification for field "${field}"`
      ).toBeGreaterThan(countAfterInit);

      // Apply the same changed value again — must NOT fire
      mgr.update({ [field]: changed });
      expect(
        (port.postMessage as ReturnType<typeof vi.fn>).mock.calls.length,
        `expected no extra notification for field "${field}"`
      ).toBe(countAfterInit + 1);
    }
  });

  it("treats undefined peerCount and absent peerCount as equal", () => {
    const { deps } = createDeps();
    const mgr = new ConnectionStatusManager(deps);
    const port = createMockPort();
    mgr.addPort(port);

    // Start at peerCount: undefined (default)
    mgr.update({ peerCount: undefined });
    const count = (port.postMessage as ReturnType<typeof vi.fn>).mock.calls.length;

    // Apply again — no change expected
    mgr.update({ peerCount: undefined });
    expect((port.postMessage as ReturnType<typeof vi.fn>).mock.calls.length).toBe(count);
  });
});

// ============================================================================
// notifyConnectionStatusChange (via update)
// ============================================================================

describe("notifyConnectionStatusChange", () => {
  it("sends message to all connected ports", () => {
    const { deps } = createDeps();
    const mgr = new ConnectionStatusManager(deps);
    const port1 = createMockPort();
    const port2 = createMockPort();
    mgr.addPort(port1);
    mgr.addPort(port2);

    mgr.update({ httpHealthy: true });

    expect((port1.postMessage as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect((port2.postMessage as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("sends correct message shape", () => {
    const { deps } = createDeps();
    const mgr = new ConnectionStatusManager(deps);
    const port = createMockPort();
    mgr.addPort(port);

    mgr.update({ httpHealthy: true, linkerUrl: "http://localhost:8000" });

    const call = (port.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.type).toBe("connectionStatusChange");
    expect(call.payload).toBeDefined();
    expect(call.payload.httpHealthy).toBe(true);
    expect(call.payload.linkerUrl).toBe("http://localhost:8000");
    expect(typeof call.payload.lastChecked).toBe("number");
  });

  it("removes ports that throw on postMessage", () => {
    const { deps } = createDeps();
    const mgr = new ConnectionStatusManager(deps);

    const goodPort = createMockPort();
    const badPort = createMockPort();
    (badPort.postMessage as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("port disconnected");
    });

    mgr.addPort(goodPort);
    mgr.addPort(badPort);

    // Trigger a status change
    mgr.update({ httpHealthy: true });

    // good port still received the message
    expect((goodPort.postMessage as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

    // Trigger another change — bad port should be gone now
    mgr.update({ httpHealthy: false });
    expect((goodPort.postMessage as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    // bad port was only called once (during the first notification, after which it was pruned)
    expect((badPort.postMessage as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});

// ============================================================================
// Port management
// ============================================================================

describe("port management", () => {
  it("addPort tracks the port", () => {
    const { deps } = createDeps();
    const mgr = new ConnectionStatusManager(deps);
    const port = createMockPort();

    mgr.addPort(port);
    mgr.update({ httpHealthy: true });

    expect((port.postMessage as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("removePort stops tracking the port", () => {
    const { deps } = createDeps();
    const mgr = new ConnectionStatusManager(deps);
    const port = createMockPort();

    mgr.addPort(port);
    mgr.removePort(port);
    mgr.update({ httpHealthy: true });

    expect((port.postMessage as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("addPort is idempotent (Set deduplication)", () => {
    const { deps } = createDeps();
    const mgr = new ConnectionStatusManager(deps);
    const port = createMockPort();

    mgr.addPort(port);
    mgr.addPort(port);
    mgr.update({ httpHealthy: true });

    // Only one postMessage call even though port was added twice
    expect((port.postMessage as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("sendStatusToPort sends current status to a single port", () => {
    const { deps } = createDeps();
    const mgr = new ConnectionStatusManager(deps);
    const port = createMockPort();

    mgr.update({ httpHealthy: true, linkerUrl: "http://localhost:8000" });
    // flush notification calls by using a separate port that isn't tracked
    const postMock = port.postMessage as ReturnType<typeof vi.fn>;

    mgr.sendStatusToPort(port);

    expect(postMock.mock.calls.length).toBe(1);
    const msg = postMock.mock.calls[0][0];
    expect(msg.type).toBe("connectionStatusChange");
    expect(msg.payload).toEqual(mgr.getStatus());
  });
});

// ============================================================================
// Health checks (startHealthChecks / stopHealthChecks)
// ============================================================================

describe("health checks lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("startHealthChecks runs checkLinkerHealth immediately", async () => {
    const { deps } = createDeps({ linkerConfig: null });
    const mgr = new ConnectionStatusManager(deps);

    mgr.startHealthChecks();
    // Flush microtasks so the async checkLinkerHealth resolves
    await flushMicrotasks();

    // With null linker config the update sets lastError
    expect(mgr.getStatus().lastError).toBe("No linker configured");
  });

  it("startHealthChecks is idempotent (second call does not create second interval)", async () => {
    const { deps } = createDeps({ linkerConfig: null });
    const mgr = new ConnectionStatusManager(deps);

    mgr.startHealthChecks();
    await flushMicrotasks();

    const callsAfterFirst = (deps.getLinkerConfig as ReturnType<typeof vi.fn>).mock.calls.length;

    mgr.startHealthChecks(); // second call — should be a no-op
    await flushMicrotasks();

    // getLinkerConfig is called inside checkLinkerHealth; a second start would
    // cause another immediate invocation, incrementing the count
    expect(
      (deps.getLinkerConfig as ReturnType<typeof vi.fn>).mock.calls.length
    ).toBe(callsAfterFirst);
  });

  it("stopHealthChecks clears the interval", async () => {
    const { deps } = createDeps({ linkerConfig: null });
    const mgr = new ConnectionStatusManager(deps);

    mgr.startHealthChecks();
    await flushMicrotasks();
    const callsAfterStart = (deps.getLinkerConfig as ReturnType<typeof vi.fn>).mock.calls.length;

    mgr.stopHealthChecks();

    // Advance time past the 5-second interval
    await vi.advanceTimersByTimeAsync(10000);
    await flushMicrotasks();

    // No additional calls after stop
    expect(
      (deps.getLinkerConfig as ReturnType<typeof vi.fn>).mock.calls.length
    ).toBe(callsAfterStart);
  });
});

// ============================================================================
// checkLinkerHealth behavior
// ============================================================================

describe("checkLinkerHealth", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("with no linker config sets httpHealthy=false, wsHealthy=false, authenticated=false, linkerUrl=null", async () => {
    const { deps } = createDeps({ linkerConfig: null });
    const mgr = new ConnectionStatusManager(deps);

    mgr.startHealthChecks();
    await flushMicrotasks();

    const s = mgr.getStatus();
    expect(s.httpHealthy).toBe(false);
    expect(s.wsHealthy).toBe(false);
    expect(s.authenticated).toBe(false);
    expect(s.linkerUrl).toBeNull();
    expect(s.lastError).toBe("No linker configured");
  });

  it("with healthy linker and executor ready sets httpHealthy=true, wsHealthy=true", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 200 });

    const { deps } = createDeps({
      linkerConfig: { linkerUrl: "http://localhost:8000" },
      executorReady: true,
      wsState: { isConnected: true, authenticated: true, peerCount: 4 },
    });
    const mgr = new ConnectionStatusManager(deps);

    mgr.startHealthChecks();
    await flushMicrotasks();

    const s = mgr.getStatus();
    expect(s.httpHealthy).toBe(true);
    expect(s.wsHealthy).toBe(true);
    expect(s.authenticated).toBe(true);
    expect(s.linkerUrl).toBe("http://localhost:8000");
    expect(s.peerCount).toBe(4);
    expect(s.lastError).toBeUndefined();
  });

  it("with HTTP failure sets httpHealthy=false with error message", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 503 });

    const { deps } = createDeps({
      linkerConfig: { linkerUrl: "http://localhost:8000" },
      executorReady: false,
    });
    const mgr = new ConnectionStatusManager(deps);

    mgr.startHealthChecks();
    await flushMicrotasks();

    const s = mgr.getStatus();
    expect(s.httpHealthy).toBe(false);
    expect(s.lastError).toBe("HTTP 503");
  });

  it("with fetch throwing sets httpHealthy=false with error message", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("network error"));

    const { deps } = createDeps({
      linkerConfig: { linkerUrl: "http://localhost:8000" },
      executorReady: false,
    });
    const mgr = new ConnectionStatusManager(deps);

    mgr.startHealthChecks();
    await flushMicrotasks();

    const s = mgr.getStatus();
    expect(s.httpHealthy).toBe(false);
    expect(s.lastError).toBe("network error");
  });

  it("with executor not ready keeps cached WS state", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 200 });

    const { deps, mockExecutor } = createDeps({
      linkerConfig: { linkerUrl: "http://localhost:8000" },
      executorReady: false,
    });
    const mgr = new ConnectionStatusManager(deps);

    // Pre-seed wsHealthy=true by simulating a prior state
    // We do this by making executor ready for the first call, then not ready for the second
    mockExecutor.isReady
      .mockReturnValueOnce(true) // first health check: executor ready
      .mockReturnValue(false); // subsequent: not ready
    mockExecutor.getWebSocketState.mockResolvedValue({
      isConnected: true,
      authenticated: true,
      peerCount: 2,
    });

    // First health check — executor is ready, WS state gets fetched
    mgr.startHealthChecks();
    await flushMicrotasks();
    expect(mgr.getStatus().wsHealthy).toBe(true);

    // Advance timer to trigger the interval-based second check
    await vi.advanceTimersByTimeAsync(5000);
    await flushMicrotasks();

    // Executor is no longer ready — cached wsHealthy=true should be preserved
    expect(mgr.getStatus().wsHealthy).toBe(true);
    // getWebSocketState was only called once (during first check)
    expect(mockExecutor.getWebSocketState.mock.calls.length).toBe(1);
  });

  it("with executor getWebSocketState throwing keeps cached WS state", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 200 });

    const { deps, mockExecutor } = createDeps({
      linkerConfig: { linkerUrl: "http://localhost:8000" },
      executorReady: true,
      wsStateError: true,
    });
    const mgr = new ConnectionStatusManager(deps);

    // Pre-seed a known wsHealthy value by directly calling update
    // (since getWebSocketState always throws, wsHealthy stays at whatever it was)
    // Default is false — verify the cached false is preserved
    mgr.startHealthChecks();
    await flushMicrotasks();

    const s = mgr.getStatus();
    // httpHealthy reflects the fetch result
    expect(s.httpHealthy).toBe(true);
    // wsHealthy stays at the default (false) because the exception was swallowed
    expect(s.wsHealthy).toBe(false);
  });

  it("fetch is called with /health path and GET method", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, status: 200 });

    const { deps } = createDeps({
      linkerConfig: { linkerUrl: "http://localhost:8000" },
      executorReady: false,
    });
    const mgr = new ConnectionStatusManager(deps);

    mgr.startHealthChecks();
    await flushMicrotasks();

    const [url, options] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("http://localhost:8000/health");
    expect(options.method).toBe("GET");
  });
});
