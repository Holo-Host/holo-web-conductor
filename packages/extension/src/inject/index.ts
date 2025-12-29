/**
 * Injected script that runs in the page context (not isolated world)
 *
 * This script is injected into web pages to provide the window.holochain API.
 * It communicates with the content script via window.postMessage.
 */

interface HolochainAPI {
  isFishy: boolean;
  version: string;
  readonly myPubKey: Uint8Array | null;
  readonly installedAppId: string | null;
  connect(): Promise<any>;
  disconnect(): Promise<any>;
  callZome(params: any): Promise<any>;
  appInfo(): Promise<any>;
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
  on(event: "signal", callback: (signal: any) => void): () => void;
}

// Signal subscription handlers
const signalHandlers = new Set<(signal: any) => void>();

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

// Send message to content script via postMessage
function sendToContentScript(type: string, payload: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = generateId();

    // Store promise callbacks
    pendingRequests.set(id, { resolve, reject });

    // Send message to content script
    window.postMessage(
      {
        source: "fishy-page",
        type,
        id,
        payload,
      },
      "*"
    );

    // Timeout after 30 seconds
    setTimeout(() => {
      const callbacks = pendingRequests.get(id);
      if (callbacks) {
        pendingRequests.delete(id);
        callbacks.reject(new Error("Request timeout"));
      }
    }, 30000);
  });
}

// Listen for responses from content script
window.addEventListener("message", (event) => {
  // Only accept messages from same window
  if (event.source !== window) return;

  const message = event.data;

  // Only handle fishy-content messages
  if (!message || message.source !== "fishy-content") return;

  // Handle signal messages (push from extension)
  if (message.type === "signal") {
    console.log("[Fishy] Signal received:", message.payload);
    signalHandlers.forEach((handler) => {
      try {
        handler(message.payload);
      } catch (e) {
        console.error("[Fishy] Signal handler error:", e);
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

// Create the Holochain API
const holochainAPI: HolochainAPI = {
  isFishy: true,
  version: "0.0.1",

  get myPubKey(): Uint8Array | null {
    return _myPubKey;
  },

  get installedAppId(): string | null {
    return _installedAppId;
  },

  async connect(): Promise<any> {
    const result = await sendToContentScript("connect", null);
    // Fetch app info to populate myPubKey and installedAppId
    try {
      const appInfo = await sendToContentScript("app_info", null);
      if (appInfo?.agentPubKey) {
        _myPubKey = toUint8Array(appInfo.agentPubKey);
      }
      if (appInfo?.contextId) {
        _installedAppId = appInfo.contextId;
      }
    } catch (e) {
      console.warn("[Fishy] Could not fetch app info after connect:", e);
    }
    return result;
  },

  async disconnect(): Promise<any> {
    return sendToContentScript("disconnect", null);
  },

  async callZome(params: any): Promise<any> {
    return sendToContentScript("call_zome", params);
  },

  async appInfo(): Promise<any> {
    return sendToContentScript("app_info", null);
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
};

// Expose the API on window
Object.defineProperty(window, "holochain", {
  value: holochainAPI,
  writable: false,
  configurable: false,
});

// Notify page that Fishy is ready
window.dispatchEvent(new Event("fishy:ready"));

console.log("Fishy API injected into page");
