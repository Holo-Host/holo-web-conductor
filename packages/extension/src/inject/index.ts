/**
 * Injected script that runs in the page context (not isolated world)
 *
 * This script is injected into web pages to provide the window.holochain API.
 * It communicates with the content script via window.postMessage.
 */

interface ConnectionStatus {
  httpHealthy: boolean;
  wsHealthy: boolean;
  authenticated: boolean;
  linkerUrl: string | null;
  lastChecked: number;
  lastError?: string;
}

interface HolochainAPI {
  isWebConductor: boolean;
  version: string;
  readonly myPubKey: Uint8Array | null;
  readonly installedAppId: string | null;
  connect(): Promise<any>;
  disconnect(): Promise<any>;
  callZome(params: any): Promise<any>;
  appInfo(installedAppId?: string): Promise<any>;
  installHapp(request: {
    appName?: string;
    appVersion?: string;
    dnas: Array<{
      hash: Uint8Array;
      wasm: Uint8Array;
      name?: string;
      properties?: Record<string, unknown>;
    }>;
  }): Promise<any>;
  installApp(request: {
    bundle: Uint8Array | number[];
    installedAppId?: string;
    membraneProofs?: Record<string, Uint8Array | number[]>;
    agentKeyTag?: string;
  }): Promise<any>;
  provideMemproofs(params: {
    contextId?: string;
    memproofs: Record<string, Uint8Array | number[]>;
  }): Promise<any>;
  on(event: "signal", callback: (signal: any) => void): () => void;
  configureNetwork(config: { linkerUrl: string }): Promise<any>;
  getNetworkStatus(): Promise<any>;
  // Connection status APIs
  getConnectionStatus(): Promise<ConnectionStatus>;
  onConnectionChange(callback: (status: ConnectionStatus) => void): () => void;
  // Joining service signing
  signReconnectChallenge(timestamp: string): Promise<Uint8Array>;
  signJoiningNonce(nonce: Uint8Array): Promise<Uint8Array>;
}

// Signal subscription handlers
const signalHandlers = new Set<(signal: any) => void>();

// Connection status subscription handlers
const connectionStatusHandlers = new Set<(status: ConnectionStatus) => void>();
let isSubscribedToConnectionStatus = false;

// Cached state from connection
let _myPubKey: Uint8Array | null = null;
let _installedAppId: string | null = null;

// Generate unique request ID
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

// Pending requests waiting for responses
const pendingRequests = new Map<
  string,
  {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }
>();

// Deep-copy payload for postMessage: strips Vue/framework Proxy wrappers
// and converts Uint8Arrays to plain Arrays (content script handles the reverse).
function normalizeForPostMessage(data: any): any {
  if (data === null || data === undefined) return data;
  if (typeof data === "function") return undefined;
  if (data instanceof Uint8Array) return Array.from(data);
  if (Array.isArray(data)) return data.map(normalizeForPostMessage);
  if (typeof data === "object") {
    const result: Record<string, any> = {};
    for (const key of Object.keys(data)) {
      result[key] = normalizeForPostMessage(data[key]);
    }
    return result;
  }
  return data;
}

// Send message to content script via postMessage
function sendToContentScript(type: string, payload: any, timeoutMs = 30000): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = generateId();

    // Store promise callbacks
    pendingRequests.set(id, { resolve, reject });

    // Normalize payload to strip Proxy wrappers and convert Uint8Arrays
    // to plain arrays for structured clone compatibility
    const normalizedPayload = normalizeForPostMessage(payload);

    // Send message to content script
    window.postMessage(
      {
        source: "hwc-page",
        type,
        id,
        payload: normalizedPayload,
      },
      "*"
    );

    setTimeout(() => {
      const callbacks = pendingRequests.get(id);
      if (callbacks) {
        pendingRequests.delete(id);
        callbacks.reject(new Error("Request timeout"));
      }
    }, timeoutMs);
  });
}

// Listen for responses from content script
window.addEventListener("message", (event) => {
  // Only accept messages from same window
  if (event.source !== window) return;

  const message = event.data;

  // Only handle hwc-content messages
  if (!message || message.source !== "hwc-content") return;

  // Handle signal messages (push from extension)
  if (message.type === "signal") {
    // Restore Uint8Arrays that Chrome converted to {0: x, 1: y, ...} objects
    const restoredPayload = restoreUint8Arrays(message.payload);
    console.log("[Holochain] Signal received:", restoredPayload);
    signalHandlers.forEach((handler) => {
      try {
        handler(restoredPayload);
      } catch (e) {
        console.error("[Holochain] Signal handler error:", e);
      }
    });
    return;
  }

  // Handle connection status change messages (push from extension)
  if (message.type === "connectionStatusChange") {
    const status = message.payload as ConnectionStatus;
    connectionStatusHandlers.forEach((handler) => {
      try {
        handler(status);
      } catch (e) {
        console.error("[Holochain] Connection status handler error:", e);
      }
    });
    return;
  }

  // Find the pending request
  const callbacks = pendingRequests.get(message.id);
  if (!callbacks) return;

  pendingRequests.delete(message.id);

  // Resolve or reject based on response
  if (message.error) {
    callbacks.reject(new Error(message.error));
  } else {
    callbacks.resolve(message.payload);
  }
});

// Helper to convert array-like objects back to Uint8Array
function toUint8Array(data: any): Uint8Array | null {
  if (!data) return null;
  if (data instanceof Uint8Array) return data;
  if (Array.isArray(data)) return new Uint8Array(data);
  if (typeof data === "object") {
    // Chrome message passing converts Uint8Array to {0: x, 1: y, ...}
    const values = Object.values(data) as number[];
    return new Uint8Array(values);
  }
  return null;
}

// Helper to check if an object looks like a serialized Uint8Array
// (has numeric keys from 0 to n-1 with byte values)
function looksLikeUint8Array(obj: any): boolean {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  if (obj instanceof Uint8Array) return false; // Already a Uint8Array
  const keys = Object.keys(obj);
  if (keys.length === 0) return false;
  // Check if all keys are sequential numbers starting from 0
  // and all values are numbers in byte range
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] !== String(i)) return false;
    const val = obj[keys[i]];
    if (typeof val !== "number" || val < 0 || val > 255 || !Number.isInteger(val)) {
      return false;
    }
  }
  return true;
}

/**
 * Post-normalization pattern: Restore Uint8Arrays from Chrome's object serialization.
 * Chrome message passing (window.postMessage) converts Uint8Array to {0:x, 1:y, ...} objects.
 * This function recursively finds and converts them back to real Uint8Arrays.
 * Equivalent to normalizeUint8Arrays() in @hwc/core/utils/bytes.ts.
 */
function restoreUint8Arrays(data: any): any {
  if (data === null || data === undefined) return data;
  if (data instanceof Uint8Array) return data;

  // Check if this looks like a serialized Uint8Array
  if (looksLikeUint8Array(data)) {
    const values = Object.values(data) as number[];
    return new Uint8Array(values);
  }

  // Recurse into arrays
  if (Array.isArray(data)) {
    return data.map(item => restoreUint8Arrays(item));
  }

  // Recurse into objects
  if (typeof data === "object") {
    const restored: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      restored[key] = restoreUint8Arrays(value);
    }
    return restored;
  }

  return data;
}

// Create the Holochain API
const holochainAPI: HolochainAPI = {
  isWebConductor: true,
  version: "0.6.1",

  get myPubKey(): Uint8Array | null {
    return _myPubKey;
  },

  get installedAppId(): string | null {
    return _installedAppId;
  },

  async connect(): Promise<any> {
    const result = await sendToContentScript("connect", null);
    // Set agent key from connect response (generated/retrieved by background)
    if (result?.agentPubKey) {
      _myPubKey = toUint8Array(result.agentPubKey);
    }
    // Still try app_info for installedAppId and as fallback for agentPubKey
    try {
      const appInfo = await sendToContentScript("app_info", null);
      if (appInfo?.agentPubKey && !_myPubKey) {
        _myPubKey = toUint8Array(appInfo.agentPubKey);
      }
      if (appInfo?.contextId) {
        _installedAppId = appInfo.contextId;
      }
    } catch (e) {
      console.warn("[Holochain] Could not fetch app info after connect:", e);
    }
    return result;
  },

  async disconnect(): Promise<any> {
    return sendToContentScript("disconnect", null);
  },

  async callZome(params: any): Promise<any> {
    return sendToContentScript("call_zome", params);
  },

  async appInfo(installedAppId?: string): Promise<any> {
    return sendToContentScript("app_info", installedAppId ? { installed_app_id: installedAppId } : null);
  },

  async installHapp(request: {
    appName?: string;
    appVersion?: string;
    dnas: Array<{
      hash: Uint8Array;
      wasm: Uint8Array;
      name?: string;
      properties?: Record<string, unknown>;
    }>;
  }): Promise<any> {
    return sendToContentScript("install_happ", request);
  },

  async installApp(request: {
    bundle: Uint8Array | number[];
    installedAppId?: string;
    membraneProofs?: Record<string, Uint8Array | number[]>;
    agentKeyTag?: string;
  }): Promise<any> {
    // Convert bundle to happBundle format expected by background
    const happBundle = Array.isArray(request.bundle)
      ? new Uint8Array(request.bundle)
      : request.bundle;

    return sendToContentScript("install_happ", {
      happBundle: Array.from(happBundle),
      appName: request.installedAppId,
      membraneProofs: request.membraneProofs,
      agentKeyTag: request.agentKeyTag,
    });
  },

  async provideMemproofs(params: {
    contextId?: string;
    memproofs: Record<string, Uint8Array | number[]>;
  }): Promise<any> {
    // 120s: first-run genesis compiles 2.2MB WASM + 4 Lair sign operations
    return sendToContentScript("provide_memproofs", params, 120000);
  },

  async configureNetwork(config: { linkerUrl: string }): Promise<any> {
    return sendToContentScript("linker_configure", config);
  },

  async getNetworkStatus(): Promise<any> {
    return sendToContentScript("linker_get_status", null);
  },

  on(event: "signal", callback: (signal: any) => void): () => void {
    if (event === "signal") {
      signalHandlers.add(callback);
      return () => {
        signalHandlers.delete(callback);
      };
    }
    // For unknown events, return a no-op unsubscribe function
    return () => {};
  },

  async getConnectionStatus(): Promise<ConnectionStatus> {
    return sendToContentScript("connection_status_get", null);
  },

  onConnectionChange(callback: (status: ConnectionStatus) => void): () => void {
    connectionStatusHandlers.add(callback);

    // Subscribe to connection status updates if not already subscribed
    if (!isSubscribedToConnectionStatus) {
      isSubscribedToConnectionStatus = true;
      // Fire-and-forget subscription request
      sendToContentScript("connection_status_subscribe", null).catch((e) => {
        console.warn("[Holochain] Failed to subscribe to connection status:", e);
      });
    }

    return () => {
      connectionStatusHandlers.delete(callback);

      // Unsubscribe if no more handlers
      if (connectionStatusHandlers.size === 0 && isSubscribedToConnectionStatus) {
        isSubscribedToConnectionStatus = false;
        sendToContentScript("connection_status_unsubscribe", null).catch((e) => {
          console.warn("[Holochain] Failed to unsubscribe from connection status:", e);
        });
      }
    };
  },

  async signReconnectChallenge(timestamp: string): Promise<Uint8Array> {
    const result = await sendToContentScript("sign_reconnect_challenge", { timestamp });
    return toUint8Array(result.signature)!;
  },

  async signJoiningNonce(nonce: Uint8Array): Promise<Uint8Array> {
    const result = await sendToContentScript("sign_joining_nonce", {
      nonce: Array.from(nonce),
    });
    return toUint8Array(result.signature)!;
  },
};

// Expose the API on window
Object.defineProperty(window, "holochain", {
  value: holochainAPI,
  writable: false,
  configurable: false,
});

// Notify page that Holochain extension is ready
window.dispatchEvent(new Event("holochain:ready"));

console.log("Holochain API injected into page");
