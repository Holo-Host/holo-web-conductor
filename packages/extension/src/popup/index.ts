/**
 * Popup UI script for Holochain extension
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
    // Check if we're running in a popup window (no tab association)
    const currentWindow = await chrome.windows.getCurrent();
    const isPopupWindow = currentWindow.type === "popup";

    if (isPopupWindow) {
      // Running as a standalone window - show extension status instead of tab status
      activePageEl.textContent = "Running in standalone window";
      statusEl.className = "status connected";
      statusTextEl.textContent = "Extension Active";
      return;
    }

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

async function checkStorageStatus(): Promise<void> {
  const warningEl = document.getElementById('storage-warning');
  if (!warningEl) return;

  try {
    if (navigator.storage?.persist) {
      const persisted = await navigator.storage.persist();
      if (!persisted) {
        warningEl.classList.remove('hidden');
      }
    } else {
      // persist() not available - show warning to be safe
      warningEl.classList.remove('hidden');
    }
  } catch {
    // On error, show warning to be safe
    warningEl.classList.remove('hidden');
  }
}

// Update on load
document.addEventListener("DOMContentLoaded", async () => {
  await updatePopupState();
  await checkStorageStatus();
});
