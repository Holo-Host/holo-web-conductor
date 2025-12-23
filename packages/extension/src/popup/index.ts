/**
 * Popup UI script for Fishy extension
 *
 * Displays connection status and basic info about the active tab
 */

interface PopupState {
  connected: boolean;
  activeTabUrl?: string;
}

async function updatePopupState(): Promise<void> {
  const statusEl = document.getElementById("status");
  const statusTextEl = document.getElementById("status-text");
  const activePageEl = document.getElementById("active-page");

  if (!statusEl || !statusTextEl || !activePageEl) {
    console.error("Required DOM elements not found");
    return;
  }

  try {
    // Get active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (tab?.url) {
      const url = new URL(tab.url);
      activePageEl.textContent = `Active page: ${url.hostname}`;

      // Check if content script is injected by sending a ping
      // For now, we'll just show as connected if extension is loaded
      statusEl.className = "status connected";
      statusTextEl.textContent = "Extension Active";
    } else {
      activePageEl.textContent = "No active page";
      statusEl.className = "status disconnected";
      statusTextEl.textContent = "No Tab";
    }
  } catch (error) {
    console.error("Error updating popup state:", error);
    statusEl.className = "status disconnected";
    statusTextEl.textContent = "Error";
    activePageEl.textContent = `Error: ${error}`;
  }
}

// Update on load
document.addEventListener("DOMContentLoaded", updatePopupState);
