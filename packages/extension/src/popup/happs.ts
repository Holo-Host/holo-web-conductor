/**
 * hApp Management UI
 *
 * Displays and manages installed hApp contexts
 */

import {
  MessageType,
  createRequest,
  type ResponseMessage,
} from "../lib/messaging";

interface HappContext {
  id: string;
  domain: string;
  appName?: string;
  appVersion?: string;
  agentPubKey: Uint8Array;
  installedAt: number;
  lastUsed: number;
  enabled: boolean;
  dnaCount: number;
}

let contexts: HappContext[] = [];

/**
 * Display error message
 */
function showError(message: string): void {
  const messageEl = document.getElementById("message")!;
  messageEl.innerHTML = `<div class="message error">${message}</div>`;
  setTimeout(() => {
    messageEl.innerHTML = "";
  }, 5000);
}

/**
 * Display success message
 */
function showSuccess(message: string): void {
  const messageEl = document.getElementById("message")!;
  messageEl.innerHTML = `<div class="message success">${message}</div>`;
  setTimeout(() => {
    messageEl.innerHTML = "";
  }, 3000);
}

/**
 * Format timestamp to readable string
 */
function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const now = Date.now();
  const diff = now - timestamp;

  // Less than 1 minute
  if (diff < 60000) {
    return "Just now";
  }

  // Less than 1 hour
  if (diff < 3600000) {
    const minutes = Math.floor(diff / 60000);
    return `${minutes}m ago`;
  }

  // Less than 24 hours
  if (diff < 86400000) {
    const hours = Math.floor(diff / 3600000);
    return `${hours}h ago`;
  }

  // Less than 7 days
  if (diff < 604800000) {
    const days = Math.floor(diff / 86400000);
    return `${days}d ago`;
  }

  // Otherwise show full date
  return date.toLocaleDateString();
}

/**
 * Format public key for display (truncated)
 */
function formatPubKey(pubKey: Uint8Array): string {
  const hex = Array.from(pubKey)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.substring(0, 8)}...${hex.substring(hex.length - 8)}`;
}

/**
 * Format public key to full hex
 */
function formatPubKeyFull(pubKey: Uint8Array): string {
  return Array.from(pubKey)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Copy text to clipboard
 */
async function copyToClipboard(text: string, element: HTMLElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    element.classList.add("copied");
    setTimeout(() => {
      element.classList.remove("copied");
    }, 2000);
  } catch (error) {
    console.error("Failed to copy:", error);
  }
}

/**
 * Render hApp card
 */
function renderHappCard(context: HappContext): string {
  const statusClass = context.enabled ? "enabled" : "disabled";
  const statusText = context.enabled ? "Enabled" : "Disabled";
  const disabledClass = context.enabled ? "" : "disabled";

  return `
    <div class="happ-card ${disabledClass}" data-id="${context.id}">
      <div class="happ-header">
        <div class="happ-title">
          <div class="happ-name">${context.appName || "Unnamed hApp"}</div>
          <div class="happ-domain">${context.domain}</div>
        </div>
        <div class="happ-status">
          <span class="status-badge ${statusClass}">${statusText}</span>
        </div>
      </div>

      <div class="happ-details">
        <div class="detail-item">
          <div class="detail-label">Context ID</div>
          <div class="detail-value">${context.id.substring(0, 8)}...</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">Version</div>
          <div class="detail-value">${context.appVersion || "N/A"}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">Installed</div>
          <div class="detail-value">${formatTimestamp(context.installedAt)}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">Last Used</div>
          <div class="detail-value">${formatTimestamp(context.lastUsed)}</div>
        </div>
        <div class="detail-item" style="grid-column: 1 / -1;">
          <div class="detail-label">Agent Public Key</div>
          <div class="detail-value pubkey" data-full="${formatPubKeyFull(context.agentPubKey)}" title="Click to copy">
            ${formatPubKey(context.agentPubKey)}
          </div>
        </div>
        <div class="detail-item">
          <div class="detail-label">DNAs</div>
          <div class="detail-value">${context.dnaCount} DNA${context.dnaCount !== 1 ? "s" : ""}</div>
        </div>
      </div>

      <div class="happ-actions">
        ${
          context.enabled
            ? `<button class="secondary disable-btn" data-id="${context.id}">Disable</button>`
            : `<button class="primary enable-btn" data-id="${context.id}">Enable</button>`
        }
        <button class="danger uninstall-btn" data-id="${context.id}">Uninstall</button>
      </div>
    </div>
  `;
}

/**
 * Update statistics
 */
function updateStats(): void {
  const total = contexts.length;
  const enabled = contexts.filter((c) => c.enabled).length;
  const disabled = total - enabled;

  document.getElementById("totalCount")!.textContent = total.toString();
  document.getElementById("enabledCount")!.textContent = enabled.toString();
  document.getElementById("disabledCount")!.textContent = disabled.toString();
}

/**
 * Render all hApps
 */
function renderHapps(): void {
  const loadingEl = document.getElementById("loading")!;
  const emptyStateEl = document.getElementById("emptyState")!;
  const listEl = document.getElementById("happList")!;

  loadingEl.style.display = "none";

  if (contexts.length === 0) {
    emptyStateEl.style.display = "block";
    listEl.style.display = "none";
    return;
  }

  emptyStateEl.style.display = "none";
  listEl.style.display = "flex";

  // Sort by last used (most recent first)
  const sorted = [...contexts].sort((a, b) => b.lastUsed - a.lastUsed);

  listEl.innerHTML = sorted.map(renderHappCard).join("");

  // Add event listeners
  attachEventListeners();
  updateStats();
}

/**
 * Attach event listeners to buttons
 */
function attachEventListeners(): void {
  // Enable buttons
  document.querySelectorAll(".enable-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const target = e.target as HTMLButtonElement;
      const contextId = target.dataset.id!;
      await toggleContext(contextId, true);
    });
  });

  // Disable buttons
  document.querySelectorAll(".disable-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const target = e.target as HTMLButtonElement;
      const contextId = target.dataset.id!;
      await toggleContext(contextId, false);
    });
  });

  // Uninstall buttons
  document.querySelectorAll(".uninstall-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const target = e.target as HTMLButtonElement;
      const contextId = target.dataset.id!;
      await uninstallHapp(contextId);
    });
  });

  // Copy public key on click
  document.querySelectorAll(".pubkey").forEach((el) => {
    el.addEventListener("click", async (e) => {
      const target = e.target as HTMLElement;
      const fullKey = target.dataset.full!;
      await copyToClipboard(fullKey, target);
    });
  });
}

/**
 * Load all installed hApps
 */
async function loadHapps(): Promise<void> {
  try {
    const message = createRequest(MessageType.LIST_HAPPS, null);
    const response: ResponseMessage = await chrome.runtime.sendMessage(message);

    if (response.type === MessageType.ERROR) {
      throw new Error(response.error || "Failed to load hApps");
    }

    contexts = response.payload.contexts;
    renderHapps();
  } catch (error) {
    console.error("Error loading hApps:", error);
    showError(error instanceof Error ? error.message : "Failed to load hApps");
    document.getElementById("loading")!.style.display = "none";
  }
}

/**
 * Toggle context enabled/disabled
 */
async function toggleContext(contextId: string, enabled: boolean): Promise<void> {
  try {
    const messageType = enabled ? MessageType.ENABLE_HAPP : MessageType.DISABLE_HAPP;
    const message = createRequest(messageType, { contextId });
    const response: ResponseMessage = await chrome.runtime.sendMessage(message);

    if (response.type === MessageType.ERROR) {
      throw new Error(response.error || "Failed to update context");
    }

    // Update local state
    const context = contexts.find((c) => c.id === contextId);
    if (context) {
      context.enabled = enabled;
      renderHapps();
      showSuccess(`hApp ${enabled ? "enabled" : "disabled"} successfully`);
    }
  } catch (error) {
    console.error("Error toggling context:", error);
    showError(error instanceof Error ? error.message : "Failed to update context");
  }
}

/**
 * Uninstall a hApp
 */
async function uninstallHapp(contextId: string): Promise<void> {
  const context = contexts.find((c) => c.id === contextId);
  if (!context) return;

  const appName = context.appName || "this hApp";
  if (!confirm(`Are you sure you want to uninstall "${appName}"?\n\nThis will delete the context and agent key. This action cannot be undone.`)) {
    return;
  }

  try {
    const message = createRequest(MessageType.UNINSTALL_HAPP, { contextId });
    const response: ResponseMessage = await chrome.runtime.sendMessage(message);

    if (response.type === MessageType.ERROR) {
      throw new Error(response.error || "Failed to uninstall hApp");
    }

    // Remove from local state
    contexts = contexts.filter((c) => c.id !== contextId);
    renderHapps();
    showSuccess(`"${appName}" uninstalled successfully`);
  } catch (error) {
    console.error("Error uninstalling hApp:", error);
    showError(error instanceof Error ? error.message : "Failed to uninstall hApp");
  }
}

// Load hApps on page load
document.addEventListener("DOMContentLoaded", () => {
  loadHapps();
});
