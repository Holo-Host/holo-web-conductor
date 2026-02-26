/**
 * Content script for Holochain extension
 *
 * Injected into web pages to provide the bridge between
 * web page JavaScript and the extension's background service worker.
 *
 * This script:
 * 1. Injects the Holochain API script into the page context
 * 2. Listens for messages from the injected script (via postMessage)
 * 3. Forwards messages to the background service worker
 * 4. Returns responses back to the injected script
 */

import {
  type RequestMessage,
  type ResponseMessage,
  MessageType,
  createRequest,
} from "../lib/messaging";

console.log("Holochain content script loaded");

/**
 * Pending requests waiting for responses from background
 */
const pendingRequests = new Map<
  string,
  {
    pageMessageId: string; // ID from page
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }
>();

/**
 * Send a message to the background service worker
 */
async function sendToBackground(
  type: string,
  payload: any,
  pageMessageId: string
): Promise<void> {
  const message = createRequest(type as any, payload);

  return new Promise((resolve, reject) => {
    // Store promise callbacks with page message ID
    pendingRequests.set(message.id, { pageMessageId, resolve, reject });

    // Send to background
    chrome.runtime.sendMessage(message, (response: ResponseMessage) => {
      // Check for Chrome runtime errors (e.g., service worker terminated mid-request)
      const runtimeError = chrome.runtime.lastError;

      const callbacks = pendingRequests.get(message.id);
      if (!callbacks) {
        console.warn("Received response for unknown request:", message.id);
        return;
      }

      pendingRequests.delete(message.id);

      if (runtimeError || !response) {
        const errorMsg = runtimeError?.message || "Background service worker disconnected";
        console.error("[Content] Background error:", errorMsg);
        window.postMessage({ source: "hwc-content", id: callbacks.pageMessageId, error: errorMsg }, "*");
        callbacks.reject(new Error(errorMsg));
        return;
      }

      // Send response back to page
      window.postMessage(
        {
          source: "hwc-content",
          id: callbacks.pageMessageId,
          payload: response.payload,
          error: response.type === MessageType.ERROR ? response.error : undefined,
        },
        "*"
      );

      if (response.type === MessageType.ERROR) {
        callbacks.reject(new Error(response.error || "Unknown error"));
      } else {
        callbacks.resolve(response.payload);
      }
    });
  });
}

/**
 * Listen for messages from the injected script
 */
window.addEventListener("message", (event) => {
  // Only accept messages from same window
  if (event.source !== window) return;

  const message = event.data;

  // Only handle hwc-page messages
  if (!message || message.source !== "hwc-page") return;

  // Forward to background
  sendToBackground(message.type, message.payload, message.id).catch((error) => {
    console.error("Error sending to background:", error);
    // Send error back to page
    window.postMessage(
      {
        source: "hwc-content",
        id: message.id,
        error: error.message || "Unknown error",
      },
      "*"
    );
  });
});

/**
 * Inject the Holochain API script into the page context
 * Uses src attribute to avoid CSP inline script violations
 */
function injectAPI() {
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("inject/index.js");
  script.onload = function () {
    // Remove script tag after execution
    script.remove();
  };
  (document.head || document.documentElement).appendChild(script);
}

// Inject the API
injectAPI();

/**
 * Listen for push messages from the background script (e.g., signals, connection status)
 * These are not request/response pairs but one-way messages
 */
chrome.runtime.onMessage.addListener((message, sender) => {
  // Only handle messages from our extension (not from web pages)
  if (sender.id !== chrome.runtime.id) return false;

  // Handle signal messages
  if (message.type === "signal") {
    console.log("[Content] Forwarding signal to page:", message.payload);
    window.postMessage(
      {
        source: "hwc-content",
        type: "signal",
        payload: message.payload,
      },
      "*"
    );
    return false; // No async response needed
  }

  // Handle connection status change messages
  if (message.type === "connectionStatusChange") {
    window.postMessage(
      {
        source: "hwc-content",
        type: "connectionStatusChange",
        payload: message.payload,
      },
      "*"
    );
    return false; // No async response needed
  }

  // Unknown message type - don't handle
  return false;
});
