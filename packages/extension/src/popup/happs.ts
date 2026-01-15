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
let debugStatusInterval: number | null = null;
const openDebugSections = new Set<string>();

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
        <button class="secondary debug-btn" data-id="${context.id}">Debug</button>
        <button class="danger uninstall-btn" data-id="${context.id}">Uninstall</button>
      </div>

      <div class="debug-section" id="debug-${context.id}" style="display: none;">
        <div class="debug-status">
          <span class="badge pending" data-id="${context.id}">0 pending</span>
          <span class="badge in-flight" data-id="${context.id}">0 in-flight</span>
          <span class="badge failed" data-id="${context.id}">0 failed</span>
        </div>
        <div class="debug-actions">
          <button class="secondary retry-failed-btn" data-id="${context.id}">Retry Failed</button>
          <button class="primary republish-all-btn" data-id="${context.id}">Republish All</button>
        </div>
        <div class="gateway-control" style="margin-top: 10px; padding-top: 10px; border-top: 1px dashed #e5e7eb;">
          <span style="font-size: 12px; color: #6b7280;">WebSocket:</span>
          <button class="secondary gateway-toggle-btn" style="margin-left: 8px;">Loading...</button>
        </div>
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

  // Clear debug section tracking when re-rendering
  openDebugSections.clear();
  stopDebugStatusPolling();

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

  // Debug buttons - toggle debug section visibility
  document.querySelectorAll(".debug-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const target = e.target as HTMLButtonElement;
      const contextId = target.dataset.id!;
      await toggleDebugSection(contextId);
    });
  });

  // Retry Failed buttons
  document.querySelectorAll(".retry-failed-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const target = e.target as HTMLButtonElement;
      const contextId = target.dataset.id!;
      await retryFailedPublishes(contextId);
    });
  });

  // Republish All buttons
  document.querySelectorAll(".republish-all-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const target = e.target as HTMLButtonElement;
      const contextId = target.dataset.id!;
      await republishAllRecords(contextId);
    });
  });

  // Gateway Toggle buttons
  document.querySelectorAll(".gateway-toggle-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const target = e.target as HTMLButtonElement;
      await toggleGatewayConnection(target);
    });
  });

  // Update all gateway toggle buttons on initial render
  updateAllGatewayToggleButtons();
}

/**
 * Fetch and update publish status for a context
 */
async function fetchPublishStatus(contextId: string): Promise<void> {
  try {
    const message = createRequest(MessageType.PUBLISH_GET_STATUS, { contextId });
    const response: ResponseMessage = await chrome.runtime.sendMessage(message);

    if (response.type === MessageType.ERROR) {
      console.error("Failed to get publish status:", response.error);
      return;
    }

    const { pending, inFlight, failed } = response.payload;

    // Update the badges
    const pendingBadge = document.querySelector(
      `.debug-section#debug-${contextId} .badge.pending`
    ) as HTMLElement;
    const inFlightBadge = document.querySelector(
      `.debug-section#debug-${contextId} .badge.in-flight`
    ) as HTMLElement;
    const failedBadge = document.querySelector(
      `.debug-section#debug-${contextId} .badge.failed`
    ) as HTMLElement;

    if (pendingBadge) pendingBadge.textContent = `${pending} pending`;
    if (inFlightBadge) inFlightBadge.textContent = `${inFlight} in-flight`;
    if (failedBadge) failedBadge.textContent = `${failed} failed`;
  } catch (error) {
    console.error("Error fetching publish status:", error);
  }
}

/**
 * Start polling for open debug sections
 */
function startDebugStatusPolling(): void {
  if (debugStatusInterval) return; // Already polling

  debugStatusInterval = window.setInterval(async () => {
    for (const contextId of openDebugSections) {
      await fetchPublishStatus(contextId);
    }
  }, 2000);
}

/**
 * Stop polling if no debug sections are open
 */
function stopDebugStatusPolling(): void {
  if (debugStatusInterval && openDebugSections.size === 0) {
    window.clearInterval(debugStatusInterval);
    debugStatusInterval = null;
  }
}

/**
 * Toggle debug section visibility
 */
async function toggleDebugSection(contextId: string): Promise<void> {
  const debugSection = document.getElementById(`debug-${contextId}`);
  if (!debugSection) return;

  const isVisible = debugSection.style.display !== "none";

  if (isVisible) {
    debugSection.style.display = "none";
    openDebugSections.delete(contextId);
    stopDebugStatusPolling();
  } else {
    debugSection.style.display = "block";
    openDebugSections.add(contextId);
    // Fetch status immediately when opening
    await fetchPublishStatus(contextId);
    // Start polling if not already
    startDebugStatusPolling();
  }
}

/**
 * Retry failed publishes for a context
 */
async function retryFailedPublishes(contextId: string): Promise<void> {
  try {
    const message = createRequest(MessageType.PUBLISH_RETRY_FAILED, { contextId });
    const response: ResponseMessage = await chrome.runtime.sendMessage(message);

    if (response.type === MessageType.ERROR) {
      throw new Error(response.error || "Failed to retry publishes");
    }

    const { resetCount } = response.payload;
    showSuccess(`Reset ${resetCount} failed ops to pending`);

    // Refresh status
    await fetchPublishStatus(contextId);
  } catch (error) {
    console.error("Error retrying failed publishes:", error);
    showError(error instanceof Error ? error.message : "Failed to retry publishes");
  }
}

/**
 * Republish all records for a context
 */
async function republishAllRecords(contextId: string): Promise<void> {
  const context = contexts.find((c) => c.id === contextId);
  if (!context) return;

  const appName = context.appName || "this hApp";
  if (
    !confirm(
      `Are you sure you want to republish all records for "${appName}"?\n\n` +
        `This will regenerate and re-queue all DHT operations from local chain data.`
    )
  ) {
    return;
  }

  try {
    const message = createRequest(MessageType.PUBLISH_ALL_RECORDS, { contextId });
    const response: ResponseMessage = await chrome.runtime.sendMessage(message);

    if (response.type === MessageType.ERROR) {
      throw new Error(response.error || "Failed to republish records");
    }

    const { cellsProcessed, opsQueued, errors } = response.payload;
    if (errors && errors.length > 0) {
      showError(`Republished with errors: ${errors.join(", ")}`);
    } else {
      showSuccess(`Queued ${opsQueued} ops from ${cellsProcessed} cells`);
    }

    // Refresh status
    await fetchPublishStatus(contextId);
  } catch (error) {
    console.error("Error republishing records:", error);
    showError(error instanceof Error ? error.message : "Failed to republish records");
  }
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

// Gateway state tracking
type WsState = "connected" | "disconnected" | "connecting" | "not_configured" | "unknown";
type HttpState = "available" | "unavailable" | "not_configured" | "unknown";
let currentWsState: WsState = "unknown";
let currentHttpState: HttpState = "unknown";
let gatewayUrl: string | null = null;

/**
 * Check HTTP availability of gateway
 */
async function checkHttpStatus(): Promise<void> {
  const indicator = document.getElementById("httpIndicator")!;
  const statusText = document.getElementById("httpStatusText")!;

  try {
    // First check if gateway is configured
    const configMessage = createRequest(MessageType.GATEWAY_GET_STATUS, null);
    const configResponse: ResponseMessage = await chrome.runtime.sendMessage(configMessage);

    if (configResponse.type === MessageType.ERROR) {
      indicator.className = "status-indicator unknown";
      statusText.textContent = "HTTP: Error";
      currentHttpState = "unknown";
      return;
    }

    const payload = configResponse.payload as { configured: boolean; gatewayUrl: string | null };
    if (!payload.configured) {
      indicator.className = "status-indicator unknown";
      statusText.textContent = "HTTP: Not configured";
      currentHttpState = "not_configured";
      return;
    }

    gatewayUrl = payload.gatewayUrl;

    // Check gateway health endpoint
    try {
      const healthUrl = gatewayUrl!.replace(/\/$/, "") + "/health";
      const healthResponse = await fetch(healthUrl, { method: "GET", signal: AbortSignal.timeout(3000) });
      if (healthResponse.ok) {
        indicator.className = "status-indicator connected";
        statusText.textContent = "HTTP: OK";
        currentHttpState = "available";
      } else {
        indicator.className = "status-indicator disconnected";
        statusText.textContent = "HTTP: Error";
        currentHttpState = "unavailable";
      }
    } catch (fetchError) {
      indicator.className = "status-indicator disconnected";
      statusText.textContent = "HTTP: Offline";
      currentHttpState = "unavailable";
    }
  } catch (error) {
    console.error("Error checking HTTP status:", error);
    indicator.className = "status-indicator unknown";
    statusText.textContent = "HTTP: Error";
    currentHttpState = "unknown";
  }
}

/**
 * Check WebSocket connection status
 */
async function checkWsStatus(): Promise<void> {
  const indicator = document.getElementById("wsIndicator")!;
  const statusText = document.getElementById("wsStatusText")!;

  try {
    // First check if gateway is configured
    const configMessage = createRequest(MessageType.GATEWAY_GET_STATUS, null);
    const configResponse: ResponseMessage = await chrome.runtime.sendMessage(configMessage);

    if (configResponse.type === MessageType.ERROR) {
      indicator.className = "status-indicator unknown";
      statusText.textContent = "WS: Error";
      currentWsState = "unknown";
      return;
    }

    const { configured } = configResponse.payload as { configured: boolean };
    if (!configured) {
      indicator.className = "status-indicator unknown";
      statusText.textContent = "WS: Not configured";
      currentWsState = "not_configured";
      return;
    }

    // Get actual WebSocket state from offscreen
    const wsMessage = { target: "offscreen", type: "GET_WS_STATE" };
    const wsResponse = await chrome.runtime.sendMessage(wsMessage);

    if (wsResponse?.success) {
      const state = wsResponse.state || "disconnected";
      const isConnected = wsResponse.isConnected || false;

      if (isConnected || state === "connected" || state === "authenticated") {
        indicator.className = "status-indicator connected";
        statusText.textContent = "WS: Connected";
        currentWsState = "connected";
      } else if (state === "connecting" || state === "authenticating") {
        indicator.className = "status-indicator unknown";
        statusText.textContent = "WS: Connecting";
        currentWsState = "connecting";
      } else {
        indicator.className = "status-indicator disconnected";
        statusText.textContent = "WS: Disconnected";
        currentWsState = "disconnected";
      }
    } else {
      indicator.className = "status-indicator unknown";
      statusText.textContent = "WS: Unknown";
      currentWsState = "unknown";
    }
  } catch (error) {
    console.error("Error checking WS status:", error);
    indicator.className = "status-indicator unknown";
    statusText.textContent = "WS: Error";
    currentWsState = "unknown";
  }

  // Update all toggle buttons
  updateAllGatewayToggleButtons();
}

/**
 * Check both HTTP and WS gateway status
 */
async function checkGatewayStatus(): Promise<void> {
  await Promise.all([checkHttpStatus(), checkWsStatus()]);
}

/**
 * Update all gateway toggle buttons based on current state
 */
function updateAllGatewayToggleButtons(): void {
  document.querySelectorAll(".gateway-toggle-btn").forEach((btn) => {
    const button = btn as HTMLButtonElement;
    updateGatewayToggleButton(button);
  });
}

/**
 * Update a single gateway toggle button based on current WS state
 */
function updateGatewayToggleButton(button: HTMLButtonElement): void {
  switch (currentWsState) {
    case "connected":
      button.textContent = "Disconnect WS";
      button.className = "secondary gateway-toggle-btn";
      button.disabled = false;
      break;
    case "disconnected":
      button.textContent = "Connect WS";
      button.className = "primary gateway-toggle-btn";
      button.disabled = false;
      break;
    case "connecting":
      button.textContent = "Connecting...";
      button.className = "secondary gateway-toggle-btn";
      button.disabled = true;
      break;
    case "not_configured":
      button.textContent = "Not Configured";
      button.className = "secondary gateway-toggle-btn";
      button.disabled = true;
      break;
    default:
      button.textContent = "Loading...";
      button.className = "secondary gateway-toggle-btn";
      button.disabled = true;
  }
}

/**
 * Toggle WebSocket connection (connect if disconnected, disconnect if connected)
 */
async function toggleGatewayConnection(button: HTMLButtonElement): Promise<void> {
  try {
    if (currentWsState === "connected") {
      // Disconnect WS
      button.textContent = "Disconnecting...";
      button.disabled = true;

      const message = createRequest(MessageType.GATEWAY_DISCONNECT, null);
      const response: ResponseMessage = await chrome.runtime.sendMessage(message);

      if (response.type === MessageType.ERROR) {
        showError(response.error || "Failed to disconnect WS");
      } else {
        showSuccess("WebSocket disconnected");
      }
    } else if (currentWsState === "disconnected") {
      // Connect WS
      button.textContent = "Connecting...";
      button.disabled = true;

      const message = createRequest(MessageType.GATEWAY_RECONNECT, null);
      const response: ResponseMessage = await chrome.runtime.sendMessage(message);

      if (response.type === MessageType.ERROR) {
        showError(response.error || "Failed to connect WS");
      } else {
        showSuccess("WebSocket connecting...");
      }
    }

    // Update status after a short delay to allow state change
    setTimeout(() => checkGatewayStatus(), 500);
  } catch (error) {
    console.error("Error toggling WS connection:", error);
    showError(error instanceof Error ? error.message : "Failed to toggle connection");
    await checkGatewayStatus();
  }
}

/**
 * Check if we're running in a popup window
 */
async function isRunningInPopupWindow(): Promise<boolean> {
  try {
    const currentWindow = await chrome.windows.getCurrent();
    return currentWindow.type === "popup";
  } catch {
    return false;
  }
}

/**
 * Open the current page in a separate browser window
 */
function openInWindow(): void {
  const url = chrome.runtime.getURL("popup/happs.html");
  chrome.windows.create({
    url,
    type: "popup",
    width: 900,
    height: 700,
    focused: true,
  });
  // Close the popup (optional - keeps it cleaner)
  window.close();
}

/**
 * Update the window toggle button based on current mode
 */
async function updateWindowToggleButton(): Promise<void> {
  const openWindowLink = document.getElementById("openInWindow");
  if (!openWindowLink) return;

  const isWindow = await isRunningInPopupWindow();

  if (isWindow) {
    openWindowLink.textContent = "Close Window";
    openWindowLink.className = "nav a"; // Reset style
  } else {
    openWindowLink.textContent = "Open in Window ↗";
    openWindowLink.className = "open-window-link";
  }
}

// Load hApps on page load
document.addEventListener("DOMContentLoaded", async () => {
  loadHapps();
  checkGatewayStatus();
  // Check gateway status every 10 seconds
  setInterval(checkGatewayStatus, 10000);

  // Update window toggle button
  await updateWindowToggleButton();

  // Handle "Open in Window" / "Close Window" link
  const openWindowLink = document.getElementById("openInWindow");
  if (openWindowLink) {
    openWindowLink.addEventListener("click", async (e) => {
      e.preventDefault();
      const isWindow = await isRunningInPopupWindow();
      if (isWindow) {
        // Close the popup window
        window.close();
      } else {
        // Open in new window
        openInWindow();
      }
    });
  }
});
