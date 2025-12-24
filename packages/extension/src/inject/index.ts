/**
 * Injected script that runs in the page context (not isolated world)
 *
 * This script is injected into web pages to provide the window.holochain API.
 * It communicates with the content script via window.postMessage.
 */

interface HolochainAPI {
  isFishy: boolean;
  version: string;
  connect(): Promise<any>;
  disconnect(): Promise<any>;
  callZome(params: any): Promise<any>;
  appInfo(installed_app_id: string): Promise<any>;
}

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

// Create the Holochain API
const holochainAPI: HolochainAPI = {
  isFishy: true,
  version: "0.0.1",

  async connect(): Promise<any> {
    return sendToContentScript("connect", null);
  },

  async disconnect(): Promise<any> {
    return sendToContentScript("disconnect", null);
  },

  async callZome(params: any): Promise<any> {
    return sendToContentScript("call_zome", params);
  },

  async appInfo(installed_app_id: string): Promise<any> {
    return sendToContentScript("app_info", { installed_app_id });
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
