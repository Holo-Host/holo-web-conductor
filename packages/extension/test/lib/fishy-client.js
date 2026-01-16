var w = Object.defineProperty;
var g = (n, e, t) => e in n ? w(n, e, { enumerable: !0, configurable: !0, writable: !0, value: t }) : n[e] = t;
var c = (n, e, t) => g(n, typeof e != "symbol" ? e + "" : e, t);
import { SignalType as m, CellType as C } from "@holochain/client";
import { CellType as S, SignalType as I } from "@holochain/client";
var a = /* @__PURE__ */ ((n) => (n.Disconnected = "disconnected", n.Connecting = "connecting", n.Connected = "connected", n.Reconnecting = "reconnecting", n.Error = "error", n))(a || {});
class b {
  constructor(e) {
    c(this, "state");
    c(this, "listeners", /* @__PURE__ */ new Map());
    c(this, "healthCheckTimer");
    c(this, "consecutiveFailures", 0);
    c(this, "MAX_FAILURES_BEFORE_UNHEALTHY", 1);
    this.config = e, this.state = {
      status: a.Disconnected,
      httpHealthy: !1,
      wsHealthy: !1
    };
  }
  /**
   * Start health monitoring.
   * Called automatically when FishyAppClient connects.
   */
  start() {
    if (this.healthCheckTimer) return;
    this.checkHealth();
    const e = this.config.healthCheckIntervalMs ?? 1e4;
    this.healthCheckTimer = setInterval(() => this.checkHealth(), e);
  }
  /**
   * Stop health monitoring.
   */
  stop() {
    this.healthCheckTimer && (clearInterval(this.healthCheckTimer), this.healthCheckTimer = void 0);
  }
  /**
   * Get current connection state.
   */
  getState() {
    return { ...this.state };
  }
  /**
   * Subscribe to connection events.
   *
   * @param event - Event name to subscribe to
   * @param callback - Function to call when event fires
   * @returns Unsubscribe function
   */
  on(e, t) {
    return this.listeners.has(e) || this.listeners.set(e, /* @__PURE__ */ new Set()), this.listeners.get(e).add(t), () => {
      var i;
      (i = this.listeners.get(e)) == null || i.delete(t);
    };
  }
  /**
   * Report a successful zome call (resets failure counter).
   * Called internally by FishyAppClient.
   */
  reportCallSuccess() {
    this.consecutiveFailures = 0, this.state.status === a.Reconnecting ? (this.updateState({
      status: a.Connected,
      httpHealthy: !0,
      reconnectAttempt: void 0,
      nextReconnectMs: void 0,
      lastError: void 0
    }), this.emit("connection:reconnected", void 0)) : this.state.status !== a.Connected && this.updateState({
      status: a.Connected,
      httpHealthy: !0
    });
  }
  /**
   * Report a failed zome call.
   * Called internally by FishyAppClient.
   */
  reportCallFailure(e) {
    this.consecutiveFailures++, (e.message.includes("network") || e.message.includes("fetch") || e.message.includes("Failed to fetch") || e.message.includes("NetworkError") || e.message.includes("gateway")) && this.consecutiveFailures >= this.MAX_FAILURES_BEFORE_UNHEALTHY && (this.updateState({
      status: a.Error,
      httpHealthy: !1,
      lastError: e.message
    }), this.emit("connection:error", { error: e.message, recoverable: !0 }));
  }
  /**
   * Update state for reconnection attempt.
   * Called by ReconnectionManager.
   */
  setReconnecting(e, t) {
    this.updateState({
      status: a.Reconnecting,
      reconnectAttempt: e,
      nextReconnectMs: t
    }), this.emit("connection:reconnecting", { attempt: e, delayMs: t });
  }
  /**
   * Mark as connected.
   */
  setConnected() {
    this.consecutiveFailures = 0, this.updateState({
      status: a.Connected,
      httpHealthy: !0,
      wsHealthy: !0,
      lastError: void 0,
      reconnectAttempt: void 0,
      nextReconnectMs: void 0
    });
  }
  /**
   * Mark as disconnected with error.
   */
  setDisconnected(e) {
    this.updateState({
      status: a.Disconnected,
      httpHealthy: !1,
      wsHealthy: !1,
      lastError: e
    });
  }
  /**
   * Update gateway health status without changing overall connection status.
   * Used when extension is connected but gateway may be unreachable.
   */
  setGatewayHealth(e, t, i) {
    this.updateState({
      httpHealthy: e,
      wsHealthy: t,
      lastError: i
    });
  }
  async checkHealth() {
    var e;
    try {
      if ((e = window.holochain) != null && e.getConnectionStatus) {
        const t = await window.holochain.getConnectionStatus(), i = this.state.httpHealthy, o = t.httpHealthy;
        i && !o ? (this.updateState({
          status: a.Error,
          httpHealthy: t.httpHealthy,
          wsHealthy: t.wsHealthy,
          lastError: t.lastError || "Gateway connection lost"
        }), this.emit("connection:error", {
          error: t.lastError || "Gateway connection lost",
          recoverable: !0
        })) : !i && o ? (this.updateState({
          status: a.Connected,
          httpHealthy: !0,
          wsHealthy: t.wsHealthy,
          lastError: void 0
        }), this.state.status === a.Reconnecting && this.emit("connection:reconnected", void 0)) : this.updateState({
          httpHealthy: t.httpHealthy,
          wsHealthy: t.wsHealthy,
          lastError: t.lastError
        });
      }
    } catch (t) {
      console.warn("[ConnectionMonitor] Health check failed:", t);
    }
  }
  updateState(e) {
    const t = { ...this.state };
    this.state = { ...this.state, ...e }, (t.status !== this.state.status || t.httpHealthy !== this.state.httpHealthy || t.wsHealthy !== this.state.wsHealthy || t.lastError !== this.state.lastError || t.reconnectAttempt !== this.state.reconnectAttempt) && this.emit("connection:change", this.getState());
  }
  emit(e, t) {
    const i = this.listeners.get(e);
    i && i.forEach((o) => {
      try {
        o(t);
      } catch (s) {
        console.error(`[ConnectionMonitor] Error in ${e} listener:`, s);
      }
    });
  }
}
class A {
  constructor(e, t, i) {
    c(this, "attempt", 0);
    c(this, "timer");
    c(this, "isReconnecting", !1);
    c(this, "cancelled", !1);
    this.config = e, this.reconnectFn = t, this.onStateChange = i;
  }
  /**
   * Trigger reconnection sequence.
   * Uses exponential backoff between attempts.
   */
  async reconnect() {
    if (this.isReconnecting || this.cancelled || this.config.autoReconnect === !1) return;
    this.isReconnecting = !0, this.cancelled = !1, this.attempt++;
    const e = this.getDelay();
    if (this.onStateChange({
      reconnectAttempt: this.attempt,
      nextReconnectMs: e
    }), console.log(
      `[ReconnectionManager] Reconnect attempt ${this.attempt} in ${e}ms`
    ), await this.wait(e), this.cancelled) {
      this.isReconnecting = !1;
      return;
    }
    try {
      await this.reconnectFn(), this.reset(), console.log("[ReconnectionManager] Reconnection successful");
    } catch (t) {
      console.error("[ReconnectionManager] Reconnection failed:", t), this.isReconnecting = !1, this.reconnect();
    }
  }
  /**
   * Cancel ongoing reconnection.
   */
  cancel() {
    this.cancelled = !0, this.timer && (clearTimeout(this.timer), this.timer = void 0), this.isReconnecting = !1;
  }
  /**
   * Reset attempt counter (call on successful connection).
   */
  reset() {
    this.attempt = 0, this.isReconnecting = !1, this.cancelled = !1, this.timer && (clearTimeout(this.timer), this.timer = void 0);
  }
  /**
   * Check if currently reconnecting.
   */
  isActive() {
    return this.isReconnecting;
  }
  /**
   * Get current attempt number.
   */
  getAttempt() {
    return this.attempt;
  }
  getDelay() {
    const e = this.config.reconnectDelayMs ?? 1e3, t = this.config.maxReconnectDelayMs ?? 3e4, i = Math.min(e * Math.pow(2, this.attempt - 1), t), o = Math.random() * 0.2 * i;
    return Math.floor(i + o);
  }
  wait(e) {
    return new Promise((t) => {
      this.timer = setTimeout(t, e);
    });
  }
}
function r(n) {
  if (!n) return new Uint8Array();
  if (n instanceof Uint8Array) return n;
  if (Array.isArray(n)) return new Uint8Array(n);
  if (typeof n == "object") {
    const e = Object.values(n);
    return new Uint8Array(e);
  }
  return new Uint8Array();
}
function p(n) {
  if (n.length === 0 || !n.every(
    (t) => typeof t == "number" && Number.isInteger(t) && t >= 0 && t <= 255
  )) return !1;
  if (n.length === 39 && n[0] === 132 && n[2] === 36) {
    const t = n[1];
    if (t === 32 || t === 33 || t === 41 || t === 36)
      return !0;
  }
  return n.length > 39;
}
function h(n) {
  if (n == null || n instanceof Uint8Array)
    return n;
  if (typeof n == "object" && !Array.isArray(n)) {
    const e = n, t = Object.keys(e);
    if (t.length > 0 && t.every((o) => /^\d+$/.test(o))) {
      const o = t.map((s) => parseInt(s, 10)).sort((s, l) => s - l);
      if (o[0] === 0 && o[o.length - 1] === o.length - 1) {
        const s = o.map((l) => e[l.toString()]);
        if (p(s))
          return new Uint8Array(s);
      }
    }
    const i = {};
    for (const o of Object.keys(e))
      i[o] = h(e[o]);
    return i;
  }
  return Array.isArray(n) ? p(n) ? new Uint8Array(n) : n.map((e) => h(e)) : n;
}
class d {
  constructor(e) {
    c(this, "_myPubKey", null);
    c(this, "_installedAppId", "");
    c(this, "_cellId", null);
    c(this, "_roleName");
    c(this, "signalHandlers", /* @__PURE__ */ new Set());
    c(this, "unsubscribeFishy", null);
    /** Connection monitor for health status */
    c(this, "connection");
    /** Reconnection manager */
    c(this, "reconnectionManager");
    /** Connection configuration */
    c(this, "connectionConfig");
    /** Cached AppInfo for ZomeClient compatibility */
    c(this, "cachedAppInfo", null);
    this.connectionConfig = {
      autoReconnect: !0,
      reconnectDelayMs: 1e3,
      maxReconnectDelayMs: 3e4,
      healthCheckIntervalMs: 1e4,
      ...e
    }, this._roleName = e.roleName ?? "default", this.connection = new b(this.connectionConfig), this.reconnectionManager = new A(
      this.connectionConfig,
      () => this.doReconnect(),
      (t) => {
        t.reconnectAttempt !== void 0 && t.nextReconnectMs !== void 0 && this.connection.setReconnecting(t.reconnectAttempt, t.nextReconnectMs);
      }
    ), this.connection.on("connection:error", ({ recoverable: t }) => {
      t && this.connectionConfig.autoReconnect !== !1 && this.reconnectionManager.reconnect();
    });
  }
  get myPubKey() {
    if (!this._myPubKey) throw new Error("Not connected - myPubKey not available");
    return this._myPubKey;
  }
  get installedAppId() {
    return this._installedAppId;
  }
  /**
   * Create and connect a FishyAppClient.
   *
   * @param config - Connection configuration (string for just gatewayUrl, or full config object)
   * @returns Connected FishyAppClient
   *
   * @example
   * ```typescript
   * // Simple usage
   * const client = await FishyAppClient.connect('http://localhost:8090');
   *
   * // With options
   * const client = await FishyAppClient.connect({
   *   gatewayUrl: 'http://localhost:8090',
   *   autoReconnect: true,
   *   reconnectDelayMs: 2000,
   * });
   * ```
   */
  static async connect(e) {
    const t = typeof e == "string" ? { gatewayUrl: e } : e, i = new d(t);
    return await i.initialize(), i;
  }
  async initialize() {
    var i;
    const e = window.holochain;
    if (!(e != null && e.isFishy))
      throw new Error("Fishy extension not detected. Please install the Fishy browser extension.");
    await e.configureNetwork({ gatewayUrl: this.connectionConfig.gatewayUrl }), await e.connect();
    try {
      const o = await e.appInfo();
      if (o != null && o.agentPubKey && ((i = o == null ? void 0 : o.cells) == null ? void 0 : i.length) > 0) {
        await this.setupFromAppInfo(o), this.connection.setConnected(), this.subscribeToExtensionConnectionStatus();
        return;
      }
    } catch {
      console.log("[FishyAppClient] hApp not installed, will install...");
    }
    await this.installHapp();
    const t = await e.appInfo();
    if (!(t != null && t.agentPubKey))
      throw new Error("Failed to get app info after installation");
    await this.setupFromAppInfo(t), this.connection.setConnected(), this.subscribeToExtensionConnectionStatus();
  }
  /**
   * Subscribe to extension's connection status updates for real-time monitoring.
   * The extension handles health checks - we just reflect its status.
   *
   * Extension connection status is separate from gateway health:
   * - Extension: Always "connected" if window.holochain exists
   * - Gateway: May be healthy or unreachable
   */
  subscribeToExtensionConnectionStatus() {
    const e = window.holochain;
    e != null && e.onConnectionChange && (this.reconnectionManager.cancel(), e.getConnectionStatus && e.getConnectionStatus().then((t) => {
      this.connection.setGatewayHealth(
        t.httpHealthy,
        t.wsHealthy,
        t.lastError
      );
    }).catch(() => {
    }), e.onConnectionChange((t) => {
      this.connection.setGatewayHealth(
        t.httpHealthy,
        t.wsHealthy,
        t.lastError
      );
    }));
  }
  async setupFromAppInfo(e) {
    var t;
    if (this._myPubKey = r(e.agentPubKey), this._installedAppId = e.contextId || "default", !e.cells || e.cells.length === 0)
      throw new Error("No cells available in app info");
    this._cellId = [r(e.cells[0][0]), r(e.cells[0][1])], this.connectionConfig.roleName || (this._roleName = ((t = e.contextId) == null ? void 0 : t.split(".")[0]) || "default"), this.cachedAppInfo = await this.appInfo(), this.setupSignalForwarding();
  }
  async installHapp() {
    const e = window.holochain;
    if (!e) throw new Error("Fishy extension not available");
    const t = this.connectionConfig.happBundlePath ? [this.connectionConfig.happBundlePath] : ["./app.happ", `./${this._roleName}.happ`, "./bundle.happ"];
    let i = null;
    for (const o of t)
      try {
        const s = await fetch(o);
        if (s.ok) {
          i = new Uint8Array(await s.arrayBuffer()), console.log(`[FishyAppClient] Found hApp bundle at ${o}`);
          break;
        }
      } catch {
      }
    if (!i)
      throw new Error(
        `Failed to fetch hApp bundle. Tried: ${t.join(", ")}. Provide happBundlePath in config or place bundle at one of these locations.`
      );
    console.log("[FishyAppClient] Installing hApp..."), await e.installApp({
      bundle: i,
      installedAppId: this._roleName
    }), console.log("[FishyAppClient] hApp installed successfully");
  }
  setupSignalForwarding() {
    const e = window.holochain;
    e && (this.unsubscribeFishy && this.unsubscribeFishy(), this.unsubscribeFishy = e.on("signal", (t) => {
      var s, l, u;
      const i = t, o = {
        type: m.App,
        value: {
          cell_id: (s = i.value) != null && s.cell_id ? [r(i.value.cell_id[0]), r(i.value.cell_id[1])] : this._cellId,
          zome_name: ((l = i.value) == null ? void 0 : l.zome_name) || "",
          payload: (u = i.value) == null ? void 0 : u.payload
        }
      };
      this.signalHandlers.forEach((y) => {
        try {
          y(o);
        } catch (f) {
          console.error("[FishyAppClient] Signal handler error:", f);
        }
      });
    }));
  }
  async doReconnect() {
    const e = window.holochain;
    if (!e) throw new Error("Fishy extension not available");
    e.reconnectWebSocket && await e.reconnectWebSocket(), await e.connect(), this.reconnectionManager.reset(), this.connection.setConnected();
  }
  // --- Public API ---
  /**
   * Subscribe to connection events.
   *
   * @param event - Event name
   * @param callback - Event handler
   * @returns Unsubscribe function
   *
   * @example
   * ```typescript
   * const unsubscribe = client.onConnection('connection:change', (state) => {
   *   console.log('Connection status:', state.status);
   *   if (state.status === ConnectionStatus.Error) {
   *     showErrorBanner(state.lastError);
   *   }
   * });
   * ```
   */
  onConnection(e, t) {
    return this.connection.on(e, t);
  }
  /**
   * Get current connection state.
   */
  getConnectionState() {
    return this.connection.getState();
  }
  /**
   * Manually trigger reconnection.
   */
  async reconnect() {
    this.reconnectionManager.cancel(), await this.doReconnect();
  }
  /**
   * Call a zome function.
   */
  async callZome(e, t) {
    const i = window.holochain;
    if (!i) throw new Error("Fishy extension not available");
    let o;
    if ("role_name" in e) {
      if (!this._cellId)
        throw new Error("No cell_id available - not connected");
      o = this._cellId;
    } else
      o = e.cell_id;
    try {
      const s = await i.callZome({
        cell_id: o,
        zome_name: e.zome_name,
        fn_name: e.fn_name,
        payload: e.payload,
        provenance: e.provenance || this._myPubKey || void 0,
        cap_secret: e.cap_secret
      });
      return this.connection.reportCallSuccess(), h(s);
    } catch (s) {
      throw this.connection.reportCallFailure(s), s;
    }
  }
  /**
   * Subscribe to signals.
   */
  on(e, t) {
    return (Array.isArray(e) ? e : [e]).includes("signal") ? (this.signalHandlers.add(t), () => {
      this.signalHandlers.delete(t);
    }) : () => {
    };
  }
  /**
   * Get app info in standard @holochain/client format.
   */
  async appInfo() {
    const e = window.holochain;
    if (!e) throw new Error("Fishy extension not available");
    const t = await e.appInfo();
    if (!t) return null;
    const i = r(t.agentPubKey), o = [r(t.cells[0][0]), r(t.cells[0][1])];
    return {
      installed_app_id: t.contextId || this._installedAppId,
      agent_pub_key: i,
      cell_info: {
        [this._roleName]: [
          {
            type: C.Provisioned,
            value: {
              cell_id: o,
              dna_modifiers: {
                network_seed: "",
                properties: {},
                origin_time: 0,
                quantum_time: { secs: 0, nanos: 0 }
              },
              name: this._roleName
            }
          }
        ]
      },
      status: { type: "running" },
      installed_at: Date.now() * 1e3
    };
  }
  /**
   * Disconnect from the extension and stop monitoring.
   */
  async disconnect() {
    this.connection.stop(), this.reconnectionManager.cancel(), this.unsubscribeFishy && (this.unsubscribeFishy(), this.unsubscribeFishy = null);
    const e = window.holochain;
    e && await e.disconnect(), this.connection.setDisconnected();
  }
  // --- Stub implementations for methods not supported by Fishy ---
  async dumpNetworkStats() {
    return console.warn("[FishyAppClient] dumpNetworkStats not supported in Fishy mode"), { peer_urls: [], connections: [] };
  }
  async dumpNetworkMetrics(e) {
    return console.warn("[FishyAppClient] dumpNetworkMetrics not supported in Fishy mode"), {};
  }
  async createCloneCell(e) {
    throw new Error("createCloneCell not supported in Fishy mode");
  }
  async enableCloneCell(e) {
    throw new Error("enableCloneCell not supported in Fishy mode");
  }
  async disableCloneCell(e) {
    throw new Error("disableCloneCell not supported in Fishy mode");
  }
}
function E(n = 5e3) {
  return new Promise((e, t) => {
    var o;
    if ((o = window.holochain) != null && o.isFishy) {
      e();
      return;
    }
    const i = setTimeout(() => {
      t(
        new Error("Fishy extension not detected. Please install the Fishy browser extension.")
      );
    }, n);
    window.addEventListener(
      "fishy:ready",
      () => {
        clearTimeout(i), e();
      },
      { once: !0 }
    );
  });
}
function H() {
  var n;
  return ((n = window.holochain) == null ? void 0 : n.isFishy) === !0;
}
export {
  S as CellType,
  b as ConnectionMonitor,
  a as ConnectionStatus,
  d as FishyAppClient,
  A as ReconnectionManager,
  I as SignalType,
  h as deepConvertByteArrays,
  H as isFishyAvailable,
  p as looksLikeByteArray,
  r as toUint8Array,
  E as waitForFishy
};
//# sourceMappingURL=index.js.map
