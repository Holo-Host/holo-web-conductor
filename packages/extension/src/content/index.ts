/**
 * Content script for Fishy extension
 *
 * Injected into web pages to provide the bridge between
 * web page JavaScript and the extension's background service worker.
 *
 * Similar to how MetaMask injects window.ethereum, this will
 * inject a Holochain client interface.
 */

import {
  type Message,
  type RequestMessage,
  type ResponseMessage,
  MessageType,
  createRequest,
  isResponseMessage,
  serializeMessage,
  deserializeMessage,
} from "../lib/messaging";

console.log("Fishy content script loaded");

/**
 * Pending requests waiting for responses from background
 */
const pendingRequests = new Map<
  string,
  {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }
>();

/**
 * Send a message to the background service worker
 */
async function sendToBackground(message: RequestMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    // Store promise callbacks
    pendingRequests.set(message.id, { resolve, reject });

    // Send to background
    chrome.runtime.sendMessage(message, (response: ResponseMessage) => {
      const callbacks = pendingRequests.get(message.id);
      if (!callbacks) {
        console.warn("Received response for unknown request:", message.id);
        return;
      }

      pendingRequests.delete(message.id);

      if (response.type === MessageType.ERROR) {
        callbacks.reject(new Error(response.error || "Unknown error"));
      } else {
        callbacks.resolve(response.payload);
      }
    });
  });
}

/**
 * Holochain client API injected into page context
 */
const holochainAPI = {
  /**
   * Connect to the extension
   */
  async connect(): Promise<any> {
    const message = createRequest(MessageType.CONNECT);
    return sendToBackground(message);
  },

  /**
   * Disconnect from the extension
   */
  async disconnect(): Promise<any> {
    const message = createRequest(MessageType.DISCONNECT);
    return sendToBackground(message);
  },

  /**
   * Call a zome function
   */
  async callZome(params: {
    cell_id: [Uint8Array, Uint8Array];
    zome_name: string;
    fn_name: string;
    payload: any;
    provenance: Uint8Array;
    cap_secret?: Uint8Array | null;
  }): Promise<any> {
    const message = createRequest(MessageType.CALL_ZOME, params);
    return sendToBackground(message);
  },

  /**
   * Get app info
   */
  async appInfo(installed_app_id: string): Promise<any> {
    const message = createRequest(MessageType.APP_INFO, { installed_app_id });
    return sendToBackground(message);
  },

  /**
   * Check if Fishy extension is installed
   */
  isFishy: true,

  /**
   * Extension version
   */
  version: "0.0.1",
};

/**
 * Inject the API into the page context
 * We use a script tag injection to bypass the isolated world of content scripts
 */
function injectAPI() {
  // Create a script that will run in the page context
  const script = document.createElement("script");
  script.textContent = `
    (function() {
      // Define the Holochain API that pages can use
      const holochainAPI = {
        isFishy: true,
        version: "0.0.1",

        async connect() {
          return window.__fishy_bridge__.sendMessage("${MessageType.CONNECT}", null);
        },

        async disconnect() {
          return window.__fishy_bridge__.sendMessage("${MessageType.DISCONNECT}", null);
        },

        async callZome(params) {
          return window.__fishy_bridge__.sendMessage("${MessageType.CALL_ZOME}", params);
        },

        async appInfo(installed_app_id) {
          return window.__fishy_bridge__.sendMessage("${MessageType.APP_INFO}", { installed_app_id });
        }
      };

      // Expose the API
      Object.defineProperty(window, 'holochain', {
        value: holochainAPI,
        writable: false,
        configurable: false
      });

      // Dispatch event to notify page that Fishy is ready
      window.dispatchEvent(new Event('fishy:ready'));

      console.log('Fishy API injected into page');
    })();
  `;

  (document.head || document.documentElement).appendChild(script);
  script.remove();
}

/**
 * Bridge for page → content script → background communication
 */
const bridge = {
  async sendMessage(type: string, payload: any): Promise<any> {
    const message = createRequest(type as any, payload);
    return sendToBackground(message);
  },
};

// Expose bridge to page context
Object.defineProperty(window, "__fishy_bridge__", {
  value: bridge,
  writable: false,
  configurable: false,
});

// Inject the API
injectAPI();
