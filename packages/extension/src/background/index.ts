/**
 * Background service worker for Fishy extension
 *
 * This is the main entry point for the extension's background process.
 * It handles:
 * - Message routing from content scripts
 * - Lair keystore operations
 * - Conductor operations
 * - Authorization management
 */

// Placeholder - to be implemented in Step 1
console.log("Fishy background service worker loaded");

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("Received message:", message, "from:", sender);

  // TODO: Implement message routing
  sendResponse({ status: "not_implemented" });

  return true; // Keep channel open for async response
});
