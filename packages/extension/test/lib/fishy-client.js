var E = Object.defineProperty;
var I = (i, e, t) => e in i ? E(i, e, { enumerable: !0, configurable: !0, writable: !0, value: t }) : i[e] = t;
var o = (i, e, t) => I(i, typeof e != "symbol" ? e + "" : e, t);
import { SignalType as S, CellType as F } from "@holochain/client";
import { CellType as ne, SignalType as ie } from "@holochain/client";
var a = /* @__PURE__ */ ((i) => (i.Disconnected = "disconnected", i.Connecting = "connecting", i.Connected = "connected", i.Reconnecting = "reconnecting", i.Error = "error", i))(a || {});
class C {
  constructor(e) {
    o(this, "state");
    o(this, "listeners", /* @__PURE__ */ new Map());
    o(this, "healthCheckTimer");
    o(this, "consecutiveFailures", 0);
    o(this, "MAX_FAILURES_BEFORE_UNHEALTHY", 1);
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
      var n;
      (n = this.listeners.get(e)) == null || n.delete(t);
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
  setGatewayHealth(e, t, n) {
    this.updateState({
      httpHealthy: e,
      wsHealthy: t,
      lastError: n
    });
  }
  async checkHealth() {
    var e;
    try {
      if ((e = window.holochain) != null && e.getConnectionStatus) {
        const t = await window.holochain.getConnectionStatus(), n = this.state.httpHealthy, s = t.httpHealthy;
        n && !s ? (this.updateState({
          status: a.Error,
          httpHealthy: t.httpHealthy,
          wsHealthy: t.wsHealthy,
          lastError: t.lastError || "Gateway connection lost"
        }), this.emit("connection:error", {
          error: t.lastError || "Gateway connection lost",
          recoverable: !0
        })) : !n && s ? (this.updateState({
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
    const n = this.listeners.get(e);
    n && n.forEach((s) => {
      try {
        s(t);
      } catch (r) {
        console.error(`[ConnectionMonitor] Error in ${e} listener:`, r);
      }
    });
  }
}
class T {
  constructor(e, t, n) {
    o(this, "attempt", 0);
    o(this, "timer");
    o(this, "isReconnecting", !1);
    o(this, "cancelled", !1);
    this.config = e, this.reconnectFn = t, this.onStateChange = n;
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
    const e = this.config.reconnectDelayMs ?? 1e3, t = this.config.maxReconnectDelayMs ?? 3e4, n = Math.min(e * Math.pow(2, this.attempt - 1), t), s = Math.random() * 0.2 * n;
    return Math.floor(n + s);
  }
  wait(e) {
    return new Promise((t) => {
      this.timer = setTimeout(t, e);
    });
  }
}
function h(i) {
  if (!i) return new Uint8Array();
  if (i instanceof Uint8Array) return i;
  if (Array.isArray(i)) return new Uint8Array(i);
  if (typeof i == "object") {
    const e = Object.values(i);
    return new Uint8Array(e);
  }
  return new Uint8Array();
}
function m(i) {
  if (i.length === 0 || !i.every(
    (t) => typeof t == "number" && Number.isInteger(t) && t >= 0 && t <= 255
  )) return !1;
  if (i.length === 39 && i[0] === 132 && i[2] === 36) {
    const t = i[1];
    if (t === 32 || t === 33 || t === 41 || t === 36)
      return !0;
  }
  return i.length > 39;
}
function y(i) {
  if (i == null || i instanceof Uint8Array)
    return i;
  if (typeof i == "object" && !Array.isArray(i)) {
    const e = i, t = Object.keys(e);
    if (t.length > 0 && t.every((s) => /^\d+$/.test(s))) {
      const s = t.map((r) => parseInt(r, 10)).sort((r, c) => r - c);
      if (s[0] === 0 && s[s.length - 1] === s.length - 1) {
        const r = s.map((c) => e[c.toString()]);
        if (m(r))
          return new Uint8Array(r);
      }
    }
    const n = {};
    for (const s of Object.keys(e))
      n[s] = y(e[s]);
    return n;
  }
  return Array.isArray(i) ? m(i) ? new Uint8Array(i) : i.map((e) => y(e)) : i;
}
function _(i) {
  const e = i.length;
  let t = 0, n = 0;
  for (; n < e; ) {
    let s = i.charCodeAt(n++);
    if (s & 4294967168)
      if (!(s & 4294965248))
        t += 2;
      else {
        if (s >= 55296 && s <= 56319 && n < e) {
          const r = i.charCodeAt(n);
          (r & 64512) === 56320 && (++n, s = ((s & 1023) << 10) + (r & 1023) + 65536);
        }
        s & 4294901760 ? t += 4 : t += 3;
      }
    else {
      t++;
      continue;
    }
  }
  return t;
}
function B(i, e, t) {
  const n = i.length;
  let s = t, r = 0;
  for (; r < n; ) {
    let c = i.charCodeAt(r++);
    if (c & 4294967168)
      if (!(c & 4294965248))
        e[s++] = c >> 6 & 31 | 192;
      else {
        if (c >= 55296 && c <= 56319 && r < n) {
          const l = i.charCodeAt(r);
          (l & 64512) === 56320 && (++r, c = ((c & 1023) << 10) + (l & 1023) + 65536);
        }
        c & 4294901760 ? (e[s++] = c >> 18 & 7 | 240, e[s++] = c >> 12 & 63 | 128, e[s++] = c >> 6 & 63 | 128) : (e[s++] = c >> 12 & 15 | 224, e[s++] = c >> 6 & 63 | 128);
      }
    else {
      e[s++] = c;
      continue;
    }
    e[s++] = c & 63 | 128;
  }
}
const b = new TextEncoder(), v = 50;
function H(i, e, t) {
  b.encodeInto(i, e.subarray(t));
}
function M(i, e, t) {
  i.length > v ? H(i, e, t) : B(i, e, t);
}
new TextDecoder();
class d {
  constructor(e, t) {
    o(this, "type");
    o(this, "data");
    this.type = e, this.data = t;
  }
}
class u extends Error {
  constructor(e) {
    super(e);
    const t = Object.create(u.prototype);
    Object.setPrototypeOf(this, t), Object.defineProperty(this, "name", {
      configurable: !0,
      enumerable: !1,
      value: u.name
    });
  }
}
function z(i, e, t) {
  const n = t / 4294967296, s = t;
  i.setUint32(e, n), i.setUint32(e + 4, s);
}
function x(i, e, t) {
  const n = Math.floor(t / 4294967296), s = t;
  i.setUint32(e, n), i.setUint32(e + 4, s);
}
function R(i, e) {
  const t = i.getInt32(e), n = i.getUint32(e + 4);
  return t * 4294967296 + n;
}
const D = -1, k = 4294967296 - 1, N = 17179869184 - 1;
function P({ sec: i, nsec: e }) {
  if (i >= 0 && e >= 0 && i <= N)
    if (e === 0 && i <= k) {
      const t = new Uint8Array(4);
      return new DataView(t.buffer).setUint32(0, i), t;
    } else {
      const t = i / 4294967296, n = i & 4294967295, s = new Uint8Array(8), r = new DataView(s.buffer);
      return r.setUint32(0, e << 2 | t & 3), r.setUint32(4, n), s;
    }
  else {
    const t = new Uint8Array(12), n = new DataView(t.buffer);
    return n.setUint32(0, e), x(n, 4, i), t;
  }
}
function W(i) {
  const e = i.getTime(), t = Math.floor(e / 1e3), n = (e - t * 1e3) * 1e6, s = Math.floor(n / 1e9);
  return {
    sec: t + s,
    nsec: n - s * 1e9
  };
}
function K(i) {
  if (i instanceof Date) {
    const e = W(i);
    return P(e);
  } else
    return null;
}
function O(i) {
  const e = new DataView(i.buffer, i.byteOffset, i.byteLength);
  switch (i.byteLength) {
    case 4:
      return { sec: e.getUint32(0), nsec: 0 };
    case 8: {
      const t = e.getUint32(0), n = e.getUint32(4), s = (t & 3) * 4294967296 + n, r = t >>> 2;
      return { sec: s, nsec: r };
    }
    case 12: {
      const t = R(e, 4), n = e.getUint32(0);
      return { sec: t, nsec: n };
    }
    default:
      throw new u(`Unrecognized data size for timestamp (expected 4, 8, or 12): ${i.length}`);
  }
}
function $(i) {
  const e = O(i);
  return new Date(e.sec * 1e3 + e.nsec / 1e6);
}
const L = {
  type: D,
  encode: K,
  decode: $
}, w = class w {
  constructor() {
    // ensures ExtensionCodecType<X> matches ExtensionCodec<X>
    // this will make type errors a lot more clear
    // eslint-disable-next-line @typescript-eslint/naming-convention
    o(this, "__brand");
    // built-in extensions
    o(this, "builtInEncoders", []);
    o(this, "builtInDecoders", []);
    // custom extensions
    o(this, "encoders", []);
    o(this, "decoders", []);
    this.register(L);
  }
  register({ type: e, encode: t, decode: n }) {
    if (e >= 0)
      this.encoders[e] = t, this.decoders[e] = n;
    else {
      const s = -1 - e;
      this.builtInEncoders[s] = t, this.builtInDecoders[s] = n;
    }
  }
  tryToEncode(e, t) {
    for (let n = 0; n < this.builtInEncoders.length; n++) {
      const s = this.builtInEncoders[n];
      if (s != null) {
        const r = s(e, t);
        if (r != null) {
          const c = -1 - n;
          return new d(c, r);
        }
      }
    }
    for (let n = 0; n < this.encoders.length; n++) {
      const s = this.encoders[n];
      if (s != null) {
        const r = s(e, t);
        if (r != null) {
          const c = n;
          return new d(c, r);
        }
      }
    }
    return e instanceof d ? e : null;
  }
  decode(e, t, n) {
    const s = t < 0 ? this.builtInDecoders[-1 - t] : this.decoders[t];
    return s ? s(e, t, n) : new d(t, e);
  }
};
o(w, "defaultCodec", new w());
let p = w;
function V(i) {
  return i instanceof ArrayBuffer || typeof SharedArrayBuffer < "u" && i instanceof SharedArrayBuffer;
}
function X(i) {
  return i instanceof Uint8Array ? i : ArrayBuffer.isView(i) ? new Uint8Array(i.buffer, i.byteOffset, i.byteLength) : V(i) ? new Uint8Array(i) : Uint8Array.from(i);
}
const G = 100, Z = 2048;
class g {
  constructor(e) {
    o(this, "extensionCodec");
    o(this, "context");
    o(this, "useBigInt64");
    o(this, "maxDepth");
    o(this, "initialBufferSize");
    o(this, "sortKeys");
    o(this, "forceFloat32");
    o(this, "ignoreUndefined");
    o(this, "forceIntegerToFloat");
    o(this, "pos");
    o(this, "view");
    o(this, "bytes");
    o(this, "entered", !1);
    this.extensionCodec = (e == null ? void 0 : e.extensionCodec) ?? p.defaultCodec, this.context = e == null ? void 0 : e.context, this.useBigInt64 = (e == null ? void 0 : e.useBigInt64) ?? !1, this.maxDepth = (e == null ? void 0 : e.maxDepth) ?? G, this.initialBufferSize = (e == null ? void 0 : e.initialBufferSize) ?? Z, this.sortKeys = (e == null ? void 0 : e.sortKeys) ?? !1, this.forceFloat32 = (e == null ? void 0 : e.forceFloat32) ?? !1, this.ignoreUndefined = (e == null ? void 0 : e.ignoreUndefined) ?? !1, this.forceIntegerToFloat = (e == null ? void 0 : e.forceIntegerToFloat) ?? !1, this.pos = 0, this.view = new DataView(new ArrayBuffer(this.initialBufferSize)), this.bytes = new Uint8Array(this.view.buffer);
  }
  clone() {
    return new g({
      extensionCodec: this.extensionCodec,
      context: this.context,
      useBigInt64: this.useBigInt64,
      maxDepth: this.maxDepth,
      initialBufferSize: this.initialBufferSize,
      sortKeys: this.sortKeys,
      forceFloat32: this.forceFloat32,
      ignoreUndefined: this.ignoreUndefined,
      forceIntegerToFloat: this.forceIntegerToFloat
    });
  }
  reinitializeState() {
    this.pos = 0;
  }
  /**
   * This is almost equivalent to {@link Encoder#encode}, but it returns an reference of the encoder's internal buffer and thus much faster than {@link Encoder#encode}.
   *
   * @returns Encodes the object and returns a shared reference the encoder's internal buffer.
   */
  encodeSharedRef(e) {
    if (this.entered)
      return this.clone().encodeSharedRef(e);
    try {
      return this.entered = !0, this.reinitializeState(), this.doEncode(e, 1), this.bytes.subarray(0, this.pos);
    } finally {
      this.entered = !1;
    }
  }
  /**
   * @returns Encodes the object and returns a copy of the encoder's internal buffer.
   */
  encode(e) {
    if (this.entered)
      return this.clone().encode(e);
    try {
      return this.entered = !0, this.reinitializeState(), this.doEncode(e, 1), this.bytes.slice(0, this.pos);
    } finally {
      this.entered = !1;
    }
  }
  doEncode(e, t) {
    if (t > this.maxDepth)
      throw new Error(`Too deep objects in depth ${t}`);
    e == null ? this.encodeNil() : typeof e == "boolean" ? this.encodeBoolean(e) : typeof e == "number" ? this.forceIntegerToFloat ? this.encodeNumberAsFloat(e) : this.encodeNumber(e) : typeof e == "string" ? this.encodeString(e) : this.useBigInt64 && typeof e == "bigint" ? this.encodeBigInt64(e) : this.encodeObject(e, t);
  }
  ensureBufferSizeToWrite(e) {
    const t = this.pos + e;
    this.view.byteLength < t && this.resizeBuffer(t * 2);
  }
  resizeBuffer(e) {
    const t = new ArrayBuffer(e), n = new Uint8Array(t), s = new DataView(t);
    n.set(this.bytes), this.view = s, this.bytes = n;
  }
  encodeNil() {
    this.writeU8(192);
  }
  encodeBoolean(e) {
    e === !1 ? this.writeU8(194) : this.writeU8(195);
  }
  encodeNumber(e) {
    !this.forceIntegerToFloat && Number.isSafeInteger(e) ? e >= 0 ? e < 128 ? this.writeU8(e) : e < 256 ? (this.writeU8(204), this.writeU8(e)) : e < 65536 ? (this.writeU8(205), this.writeU16(e)) : e < 4294967296 ? (this.writeU8(206), this.writeU32(e)) : this.useBigInt64 ? this.encodeNumberAsFloat(e) : (this.writeU8(207), this.writeU64(e)) : e >= -32 ? this.writeU8(224 | e + 32) : e >= -128 ? (this.writeU8(208), this.writeI8(e)) : e >= -32768 ? (this.writeU8(209), this.writeI16(e)) : e >= -2147483648 ? (this.writeU8(210), this.writeI32(e)) : this.useBigInt64 ? this.encodeNumberAsFloat(e) : (this.writeU8(211), this.writeI64(e)) : this.encodeNumberAsFloat(e);
  }
  encodeNumberAsFloat(e) {
    this.forceFloat32 ? (this.writeU8(202), this.writeF32(e)) : (this.writeU8(203), this.writeF64(e));
  }
  encodeBigInt64(e) {
    e >= BigInt(0) ? (this.writeU8(207), this.writeBigUint64(e)) : (this.writeU8(211), this.writeBigInt64(e));
  }
  writeStringHeader(e) {
    if (e < 32)
      this.writeU8(160 + e);
    else if (e < 256)
      this.writeU8(217), this.writeU8(e);
    else if (e < 65536)
      this.writeU8(218), this.writeU16(e);
    else if (e < 4294967296)
      this.writeU8(219), this.writeU32(e);
    else
      throw new Error(`Too long string: ${e} bytes in UTF-8`);
  }
  encodeString(e) {
    const n = _(e);
    this.ensureBufferSizeToWrite(5 + n), this.writeStringHeader(n), M(e, this.bytes, this.pos), this.pos += n;
  }
  encodeObject(e, t) {
    const n = this.extensionCodec.tryToEncode(e, this.context);
    if (n != null)
      this.encodeExtension(n);
    else if (Array.isArray(e))
      this.encodeArray(e, t);
    else if (ArrayBuffer.isView(e))
      this.encodeBinary(e);
    else if (typeof e == "object")
      this.encodeMap(e, t);
    else
      throw new Error(`Unrecognized object: ${Object.prototype.toString.apply(e)}`);
  }
  encodeBinary(e) {
    const t = e.byteLength;
    if (t < 256)
      this.writeU8(196), this.writeU8(t);
    else if (t < 65536)
      this.writeU8(197), this.writeU16(t);
    else if (t < 4294967296)
      this.writeU8(198), this.writeU32(t);
    else
      throw new Error(`Too large binary: ${t}`);
    const n = X(e);
    this.writeU8a(n);
  }
  encodeArray(e, t) {
    const n = e.length;
    if (n < 16)
      this.writeU8(144 + n);
    else if (n < 65536)
      this.writeU8(220), this.writeU16(n);
    else if (n < 4294967296)
      this.writeU8(221), this.writeU32(n);
    else
      throw new Error(`Too large array: ${n}`);
    for (const s of e)
      this.doEncode(s, t + 1);
  }
  countWithoutUndefined(e, t) {
    let n = 0;
    for (const s of t)
      e[s] !== void 0 && n++;
    return n;
  }
  encodeMap(e, t) {
    const n = Object.keys(e);
    this.sortKeys && n.sort();
    const s = this.ignoreUndefined ? this.countWithoutUndefined(e, n) : n.length;
    if (s < 16)
      this.writeU8(128 + s);
    else if (s < 65536)
      this.writeU8(222), this.writeU16(s);
    else if (s < 4294967296)
      this.writeU8(223), this.writeU32(s);
    else
      throw new Error(`Too large map object: ${s}`);
    for (const r of n) {
      const c = e[r];
      this.ignoreUndefined && c === void 0 || (this.encodeString(r), this.doEncode(c, t + 1));
    }
  }
  encodeExtension(e) {
    if (typeof e.data == "function") {
      const n = e.data(this.pos + 6), s = n.length;
      if (s >= 4294967296)
        throw new Error(`Too large extension object: ${s}`);
      this.writeU8(201), this.writeU32(s), this.writeI8(e.type), this.writeU8a(n);
      return;
    }
    const t = e.data.length;
    if (t === 1)
      this.writeU8(212);
    else if (t === 2)
      this.writeU8(213);
    else if (t === 4)
      this.writeU8(214);
    else if (t === 8)
      this.writeU8(215);
    else if (t === 16)
      this.writeU8(216);
    else if (t < 256)
      this.writeU8(199), this.writeU8(t);
    else if (t < 65536)
      this.writeU8(200), this.writeU16(t);
    else if (t < 4294967296)
      this.writeU8(201), this.writeU32(t);
    else
      throw new Error(`Too large extension object: ${t}`);
    this.writeI8(e.type), this.writeU8a(e.data);
  }
  writeU8(e) {
    this.ensureBufferSizeToWrite(1), this.view.setUint8(this.pos, e), this.pos++;
  }
  writeU8a(e) {
    const t = e.length;
    this.ensureBufferSizeToWrite(t), this.bytes.set(e, this.pos), this.pos += t;
  }
  writeI8(e) {
    this.ensureBufferSizeToWrite(1), this.view.setInt8(this.pos, e), this.pos++;
  }
  writeU16(e) {
    this.ensureBufferSizeToWrite(2), this.view.setUint16(this.pos, e), this.pos += 2;
  }
  writeI16(e) {
    this.ensureBufferSizeToWrite(2), this.view.setInt16(this.pos, e), this.pos += 2;
  }
  writeU32(e) {
    this.ensureBufferSizeToWrite(4), this.view.setUint32(this.pos, e), this.pos += 4;
  }
  writeI32(e) {
    this.ensureBufferSizeToWrite(4), this.view.setInt32(this.pos, e), this.pos += 4;
  }
  writeF32(e) {
    this.ensureBufferSizeToWrite(4), this.view.setFloat32(this.pos, e), this.pos += 4;
  }
  writeF64(e) {
    this.ensureBufferSizeToWrite(8), this.view.setFloat64(this.pos, e), this.pos += 8;
  }
  writeU64(e) {
    this.ensureBufferSizeToWrite(8), z(this.view, this.pos, e), this.pos += 8;
  }
  writeI64(e) {
    this.ensureBufferSizeToWrite(8), x(this.view, this.pos, e), this.pos += 8;
  }
  writeBigUint64(e) {
    this.ensureBufferSizeToWrite(8), this.view.setBigUint64(this.pos, e), this.pos += 8;
  }
  writeBigInt64(e) {
    this.ensureBufferSizeToWrite(8), this.view.setBigInt64(this.pos, e), this.pos += 8;
  }
}
function q(i, e) {
  return new g(e).encodeSharedRef(i);
}
class U {
  constructor(e) {
    o(this, "_myPubKey", null);
    o(this, "_installedAppId", "");
    o(this, "_cellId", null);
    o(this, "_roleName");
    o(this, "signalHandlers", /* @__PURE__ */ new Set());
    o(this, "unsubscribeFishy", null);
    /** Connection monitor for health status */
    o(this, "connection");
    /** Reconnection manager */
    o(this, "reconnectionManager");
    /** Connection configuration */
    o(this, "connectionConfig");
    /** Cached AppInfo for ZomeClient compatibility */
    o(this, "cachedAppInfo", null);
    this.connectionConfig = {
      autoReconnect: !0,
      reconnectDelayMs: 1e3,
      maxReconnectDelayMs: 3e4,
      healthCheckIntervalMs: 1e4,
      ...e
    }, this._roleName = e.roleName ?? "default", this.connection = new C(this.connectionConfig), this.reconnectionManager = new T(
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
    const t = typeof e == "string" ? { gatewayUrl: e } : e, n = new U(t);
    return await n.initialize(), n;
  }
  async initialize() {
    var n;
    const e = window.holochain;
    if (!(e != null && e.isFishy))
      throw new Error("Fishy extension not detected. Please install the Fishy browser extension.");
    await e.configureNetwork({ gatewayUrl: this.connectionConfig.gatewayUrl }), await e.connect();
    try {
      const s = await e.appInfo();
      if (s != null && s.agentPubKey && ((n = s == null ? void 0 : s.cells) == null ? void 0 : n.length) > 0) {
        await this.setupFromAppInfo(s), this.connection.setConnected(), this.subscribeToExtensionConnectionStatus();
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
    if (this._myPubKey = h(e.agentPubKey), this._installedAppId = e.contextId || "default", !e.cells || e.cells.length === 0)
      throw new Error("No cells available in app info");
    this._cellId = [h(e.cells[0][0]), h(e.cells[0][1])], this.connectionConfig.roleName || (this._roleName = ((t = e.contextId) == null ? void 0 : t.split(".")[0]) || "default"), this.cachedAppInfo = await this.appInfo(), this.setupSignalForwarding();
  }
  async installHapp() {
    const e = window.holochain;
    if (!e) throw new Error("Fishy extension not available");
    const t = this.connectionConfig.happBundlePath ? [this.connectionConfig.happBundlePath] : ["./app.happ", `./${this._roleName}.happ`, "./bundle.happ"];
    let n = null;
    for (const s of t)
      try {
        const r = await fetch(s);
        if (r.ok) {
          n = new Uint8Array(await r.arrayBuffer()), console.log(`[FishyAppClient] Found hApp bundle at ${s}`);
          break;
        }
      } catch {
      }
    if (!n)
      throw new Error(
        `Failed to fetch hApp bundle. Tried: ${t.join(", ")}. Provide happBundlePath in config or place bundle at one of these locations.`
      );
    console.log("[FishyAppClient] Installing hApp..."), await e.installApp({
      bundle: n,
      installedAppId: this._roleName
    }), console.log("[FishyAppClient] hApp installed successfully");
  }
  setupSignalForwarding() {
    const e = window.holochain;
    e && (this.unsubscribeFishy && this.unsubscribeFishy(), this.unsubscribeFishy = e.on("signal", (t) => {
      var r, c, l;
      const n = t, s = {
        type: S.App,
        value: {
          cell_id: (r = n.value) != null && r.cell_id ? [h(n.value.cell_id[0]), h(n.value.cell_id[1])] : this._cellId,
          zome_name: ((c = n.value) == null ? void 0 : c.zome_name) || "",
          payload: (l = n.value) == null ? void 0 : l.payload
        }
      };
      this.signalHandlers.forEach((f) => {
        try {
          f(s);
        } catch (A) {
          console.error("[FishyAppClient] Signal handler error:", A);
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
    const n = window.holochain;
    if (!n) throw new Error("Fishy extension not available");
    let s;
    if ("role_name" in e) {
      if (!this._cellId)
        throw new Error("No cell_id available - not connected");
      s = this._cellId;
    } else
      s = e.cell_id;
    try {
      const r = await n.callZome({
        cell_id: s,
        zome_name: e.zome_name,
        fn_name: e.fn_name,
        payload: e.payload,
        provenance: e.provenance || this._myPubKey || void 0,
        cap_secret: e.cap_secret
      });
      return this.connection.reportCallSuccess(), y(r);
    } catch (r) {
      throw this.connection.reportCallFailure(r), r;
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
    var f;
    const e = window.holochain;
    if (!e) throw new Error("Fishy extension not available");
    const t = await e.appInfo();
    if (!t) return null;
    const n = h(t.agentPubKey), s = [h(t.cells[0][0]), h(t.cells[0][1])], r = ((f = t.dnaProperties) == null ? void 0 : f[this._roleName]) ?? null, c = new Uint8Array(q(r));
    return {
      installed_app_id: t.contextId || this._installedAppId,
      agent_pub_key: n,
      cell_info: {
        [this._roleName]: [
          {
            type: F.Provisioned,
            value: {
              cell_id: s,
              dna_modifiers: {
                network_seed: "",
                properties: c,
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
function Q(i = 5e3) {
  return new Promise((e, t) => {
    var s;
    if ((s = window.holochain) != null && s.isFishy) {
      e();
      return;
    }
    const n = setTimeout(() => {
      t(
        new Error("Fishy extension not detected. Please install the Fishy browser extension.")
      );
    }, i);
    window.addEventListener(
      "fishy:ready",
      () => {
        clearTimeout(n), e();
      },
      { once: !0 }
    );
  });
}
function j() {
  var i;
  return ((i = window.holochain) == null ? void 0 : i.isFishy) === !0;
}
export {
  ne as CellType,
  C as ConnectionMonitor,
  a as ConnectionStatus,
  U as FishyAppClient,
  T as ReconnectionManager,
  ie as SignalType,
  y as deepConvertByteArrays,
  j as isFishyAvailable,
  m as looksLikeByteArray,
  h as toUint8Array,
  Q as waitForFishy
};
//# sourceMappingURL=index.js.map
