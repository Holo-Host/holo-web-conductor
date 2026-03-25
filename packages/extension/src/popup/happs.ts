/**
 * hApp Management UI
 *
 * Displays and manages installed hApp contexts
 */

import {
  MessageType,
  createRequest,
  type ResponseMessage,
  type PublishStatusPayload,
} from "../lib/messaging";
import { formatHash, formatHashFull, formatRelativeTime, copyToClipboard, showConfirm } from "./utils";

interface HappContext {
  id: string;
  domain: string;
  appName?: string;
  appVersion?: string;
  agentPubKey: Uint8Array;
  installedAt: number;
  lastUsed: number;
  enabled: boolean;
  status?: 'enabled' | 'disabled' | 'awaitingMemproofs';
  dnas: Array<{ hash: Uint8Array | number[] | Record<string, number>; name?: string; networkSeed?: string }>;
  recoverySealed?: boolean;
}

interface RecoveryProgress {
  status: 'discovering' | 'fetching' | 'complete' | 'error';
  totalActions: number;
  recoveredActions: number;
  failedActions: number;
  errors: string[];
}

interface RecoveryResult {
  recoveredCount: number;
  failedCount: number;
  verifiedCount: number;
  unverifiedCount: number;
  errors: string[];
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
 * Render hApp card
 */
function renderHappCard(context: HappContext): string {
  const status = context.status || (context.enabled ? 'enabled' : 'disabled');
  const isEnabled = status === 'enabled';
  const isAwaiting = status === 'awaitingMemproofs';
  const statusClass = isEnabled ? "enabled" : isAwaiting ? "awaiting" : "disabled";
  const statusText = isEnabled ? "Enabled" : isAwaiting ? "Awaiting Memproof" : "Disabled";
  const disabledClass = isEnabled ? "" : "disabled";
  const toggleChecked = isEnabled ? "checked" : "";

  return `
    <div class="happ-card ${disabledClass}" data-id="${context.id}">
      <div class="happ-header">
        <div class="happ-title">
          <span class="happ-name">${context.appName || "Unnamed hApp"}</span>
          <span class="happ-version">v${context.appVersion || "?"}</span>
        </div>
        <div class="happ-status">
          ${isAwaiting
            ? `<span class="status-badge awaiting">${statusText}</span>
               <button class="primary provide-memproof-btn" data-id="${context.id}">Provide Memproof</button>`
            : `<span class="status-badge ${statusClass}">${statusText}</span>
               <label class="toggle" title="${isEnabled ? 'Disable' : 'Enable'} hApp">
                 <input type="checkbox" class="toggle-input" data-id="${context.id}" ${toggleChecked}>
                 <span class="toggle-slider"></span>
               </label>`
          }
        </div>
      </div>
      <div class="happ-domain">${context.domain}</div>

      <div class="happ-details">
        <div class="detail-row">
          <span class="detail-label">Installed</span> <span class="detail-value">${formatRelativeTime(context.installedAt)}</span>
          <span class="detail-sep"></span>
          <span class="detail-label">Last used</span> <span class="detail-value">${formatRelativeTime(context.lastUsed)}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Agent</span>
          <span class="detail-value pubkey" data-full="${formatHashFull(context.agentPubKey)}" title="Click to copy">
            ${formatHash(context.agentPubKey)}
          </span>
        </div>
        <div class="dna-list">
          <span class="detail-label">DNAs</span>
          ${context.dnas.map((dna) => `
            <div class="dna-item">
              <span class="dna-name">${dna.name || "unnamed"}</span>
              <span class="dna-hash" data-full="${formatHashFull(dna.hash)}" title="Click to copy">${formatHash(dna.hash)}</span>
              ${dna.networkSeed ? `<span class="dna-seed" title="${dna.networkSeed}">seed: ${dna.networkSeed.length > 16 ? dna.networkSeed.substring(0, 16) + "..." : dna.networkSeed}</span>` : ""}
            </div>
          `).join("")}
        </div>
      </div>

      <details class="section-debug" data-id="${context.id}">
        <summary class="section-toggle">Debug</summary>
        <div class="section-content" id="debug-${context.id}">
          <div class="subsection">
            <div class="subsection-title">Publishing</div>
            <div class="debug-status">
              <span class="badge pending" data-id="${context.id}">0 pending</span>
              <span class="badge in-flight" data-id="${context.id}">0 in-flight</span>
              <span class="badge failed" data-id="${context.id}">0 failed</span>
            </div>
            <div class="debug-actions">
              <button class="secondary retry-failed-btn" data-id="${context.id}">Retry Failed</button>
              <button class="primary republish-all-btn" data-id="${context.id}">Republish All</button>
            </div>
          </div>
          <div class="subsection">
            <div class="subsection-title">Linker</div>
            <div class="linker-control">
              <span class="linker-label">WebSocket:</span>
              <button class="secondary linker-toggle-btn">Loading...</button>
            </div>
          </div>
        </div>
      </details>

      <details class="section-danger">
        <summary class="section-toggle danger-toggle">Danger Zone</summary>
        <div class="section-content danger-content">
          ${context.recoverySealed !== true
            ? `<button class="secondary recover-btn" data-context-id="${context.id}" title="Recover chain data from DHT">Recover Chain</button>`
            : ''
          }
          <button class="danger uninstall-btn" data-id="${context.id}">Uninstall</button>
        </div>
      </details>
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
  // Toggle slider (enable/disable)
  document.querySelectorAll(".toggle-input").forEach((input) => {
    input.addEventListener("change", async (e) => {
      const target = e.target as HTMLInputElement;
      const contextId = target.dataset.id!;
      await toggleContext(contextId, target.checked);
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

  // Copy hash on click (agent keys and DNA hashes)
  document.querySelectorAll(".pubkey, .dna-hash").forEach((el) => {
    el.addEventListener("click", async (e) => {
      const target = e.target as HTMLElement;
      const fullKey = target.dataset.full!;
      await copyToClipboard(fullKey, target);
    });
  });

  // Debug section -- fetch publish status when opened
  document.querySelectorAll(".section-debug").forEach((details) => {
    details.addEventListener("toggle", async () => {
      const el = details as HTMLDetailsElement;
      const contextId = el.dataset.id!;
      if (el.open) {
        openDebugSections.add(contextId);
        await fetchPublishStatus(contextId);
        startDebugStatusPolling();
      } else {
        openDebugSections.delete(contextId);
        stopDebugStatusPolling();
      }
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

  // Provide Memproof buttons
  document.querySelectorAll(".provide-memproof-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const target = e.target as HTMLButtonElement;
      const contextId = target.dataset.id!;
      await showMemproofDialog(contextId);
    });
  });

  // Recover Chain buttons
  document.querySelectorAll('.recover-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const contextId = (e.target as HTMLElement).dataset.contextId;
      if (!contextId) return;

      if (!(await showConfirm('Recover chain data from the DHT? This requires an active linker connection.'))) return;

      const modal = document.getElementById('recovery-modal');
      const progressBar = document.getElementById('recovery-progress-bar');
      const progressText = document.getElementById('recovery-progress-text');
      const errorsDiv = document.getElementById('recovery-errors');
      const closeBtn = document.getElementById('recovery-close-btn');

      if (modal) modal.classList.add('active');
      if (progressBar) progressBar.style.width = '0%';
      if (progressText) progressText.textContent = 'Discovering agent activity...';
      if (errorsDiv) { errorsDiv.classList.add('hidden'); errorsDiv.textContent = ''; }
      if (closeBtn) closeBtn.classList.add('hidden');

      const recoverMessage = createRequest(MessageType.RECOVER_CHAIN, { contextId });
      const recoverPromise = chrome.runtime.sendMessage(recoverMessage);

      const pollInterval = setInterval(async () => {
        try {
          const progressMsg = createRequest(MessageType.GET_RECOVERY_PROGRESS, { contextId });
          const progressResp = await chrome.runtime.sendMessage(progressMsg);
          if (progressResp.type !== MessageType.ERROR && progressResp.payload) {
            const progress = progressResp.payload as RecoveryProgress;
            const total = progress.totalActions || 0;
            const recovered = progress.recoveredActions || 0;

            if (total > 0) {
              const pct = Math.round((recovered / total) * 100);
              if (progressBar) progressBar.style.width = `${pct}%`;
              if (progressText) progressText.textContent = `Recovered ${recovered} of ${total} actions (${pct}%)`;
            } else if (progress.status === 'discovering') {
              if (progressText) progressText.textContent = 'Discovering agent activity...';
            }

            if (progress.status === 'complete' || progress.status === 'error') {
              clearInterval(pollInterval);
            }
          }
        } catch {
          // Ignore polling errors
        }
      }, 500);

      try {
        const result = await recoverPromise;
        clearInterval(pollInterval);

        if (result.type === MessageType.ERROR) {
          const errorMsg = (result as ResponseMessage).payload
            ? String((result as ResponseMessage).payload)
            : 'Unknown error';
          if (progressText) progressText.textContent = `Recovery failed: ${errorMsg}`;
          if (progressBar) progressBar.style.width = '100%';
          if (progressBar) (progressBar as HTMLElement).style.background = '#dc3545';
        } else {
          const data = result.payload as RecoveryResult;
          if (progressBar) progressBar.style.width = '100%';
          if (progressText) progressText.textContent = `Recovery complete: ${data.recoveredCount || 0} records recovered (${data.verifiedCount || 0} verified), ${data.failedCount || 0} failed`;

          if (data.errors && data.errors.length > 0) {
            if (errorsDiv) {
              errorsDiv.textContent = `Errors: ${data.errors.join('; ')}`;
              errorsDiv.classList.remove('hidden');
            }
          }
        }
      } catch (err) {
        clearInterval(pollInterval);
        if (progressText) progressText.textContent = `Error: ${err}`;
      }

      if (closeBtn) {
        closeBtn.classList.remove('hidden');
        closeBtn.addEventListener('click', () => {
          if (modal) modal.classList.remove('active');
          if (progressBar) (progressBar as any).style.background = '#667eea';
        }, { once: true });
      }
    });
  });

  // Linker Toggle buttons
  document.querySelectorAll(".linker-toggle-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const target = e.target as HTMLButtonElement;
      await toggleLinkerConnection(target);
    });
  });

  // Update all linker toggle buttons on initial render
  updateAllLinkerToggleButtons();
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

    const { pending, inFlight, failed } = response.payload as PublishStatusPayload;

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
 * Retry failed publishes for a context
 */
async function retryFailedPublishes(contextId: string): Promise<void> {
  try {
    const message = createRequest(MessageType.PUBLISH_RETRY_FAILED, { contextId });
    const response: ResponseMessage = await chrome.runtime.sendMessage(message);

    if (response.type === MessageType.ERROR) {
      throw new Error(response.error || "Failed to retry publishes");
    }

    const { resetCount } = response.payload as { resetCount: number };
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
    !(await showConfirm(
      `Are you sure you want to republish all records for "${appName}"?\n\n` +
        `This will regenerate and re-queue all DHT operations from local chain data.`
    ))
  ) {
    return;
  }

  try {
    const message = createRequest(MessageType.PUBLISH_ALL_RECORDS, { contextId });
    const response: ResponseMessage = await chrome.runtime.sendMessage(message);

    if (response.type === MessageType.ERROR) {
      throw new Error(response.error || "Failed to republish records");
    }

    const { cellsProcessed, opsQueued, errors } = response.payload as { cellsProcessed: number; opsQueued: number; errors: string[] };
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

    contexts = (response.payload as { contexts: HappContext[] }).contexts;
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
  if (!(await showConfirm(`Are you sure you want to uninstall "${appName}"?\n\nThis will delete the context and agent key. This action cannot be undone.`))) {
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

/**
 * Show membrane proof input dialog for a context
 */
async function showMemproofDialog(contextId: string): Promise<void> {
  const context = contexts.find((c) => c.id === contextId);
  if (!context) return;

  const appName = context.appName || "Unnamed hApp";

  // Simple prompt for base64 or hex-encoded proof bytes
  const input = prompt(
    `Enter membrane proof for "${appName}":\n\n` +
    `Paste base64-encoded or hex-encoded proof bytes.`
  );

  if (!input || input.trim() === "") return;

  const trimmed = input.trim();

  // Try to decode as base64 first, then hex
  let proofBytes: Uint8Array;
  try {
    if (/^[A-Za-z0-9+/=]+$/.test(trimmed)) {
      // Base64
      const binary = atob(trimmed);
      proofBytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        proofBytes[i] = binary.charCodeAt(i);
      }
    } else if (/^[0-9a-fA-F]+$/.test(trimmed)) {
      // Hex
      const bytes = trimmed.match(/.{1,2}/g)!;
      proofBytes = new Uint8Array(bytes.map((b) => parseInt(b, 16)));
    } else {
      showError("Invalid format. Use base64 or hex encoding.");
      return;
    }
  } catch (e) {
    showError("Failed to decode proof bytes.");
    return;
  }

  try {
    // Send all proofs under a single "default" role key
    // In a real flow, the page API would provide role-specific proofs
    const memproofs: Record<string, Uint8Array> = { default: proofBytes };
    const message = createRequest(MessageType.PROVIDE_MEMPROOFS, {
      contextId,
      memproofs,
    });
    const response: ResponseMessage = await chrome.runtime.sendMessage(message);

    if (response.type === MessageType.ERROR) {
      throw new Error(response.error || "Failed to provide membrane proof");
    }

    // Update local state
    const ctx = contexts.find((c) => c.id === contextId);
    if (ctx) {
      ctx.status = "enabled";
      ctx.enabled = true;
    }
    renderHapps();
    showSuccess("Membrane proof accepted");
  } catch (error) {
    console.error("Error providing membrane proof:", error);
    showError(error instanceof Error ? error.message : "Failed to provide membrane proof");
  }
}

// Linker state tracking
type WsState = "connected" | "disconnected" | "connecting" | "not_configured" | "unknown";
type HttpState = "available" | "unavailable" | "not_configured" | "unknown";
let currentWsState: WsState = "unknown";
let currentHttpState: HttpState = "unknown";
let linkerUrl: string | null = null;

/**
 * Check HTTP availability of linker
 */
async function checkHttpStatus(): Promise<void> {
  const indicator = document.getElementById("httpIndicator")!;
  const statusText = document.getElementById("httpStatusText")!;

  try {
    // First check if linker is configured
    const configMessage = createRequest(MessageType.LINKER_GET_STATUS, null);
    const configResponse: ResponseMessage = await chrome.runtime.sendMessage(configMessage);

    if (configResponse.type === MessageType.ERROR) {
      indicator.className = "status-indicator unknown";
      statusText.textContent = "HTTP: Error";
      currentHttpState = "unknown";
      return;
    }

    const payload = configResponse.payload as { configured: boolean; linkerUrl: string | null };
    if (!payload.configured) {
      indicator.className = "status-indicator unknown";
      statusText.textContent = "HTTP: Not configured";
      currentHttpState = "not_configured";
      return;
    }

    linkerUrl = payload.linkerUrl;

    // Check linker health endpoint
    try {
      const healthUrl = linkerUrl!.replace(/\/$/, "") + "/health";
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
    // First check if linker is configured
    const configMessage = createRequest(MessageType.LINKER_GET_STATUS, null);
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
  updateAllLinkerToggleButtons();
}

/**
 * Check both HTTP and WS linker status
 */
async function checkLinkerStatus(): Promise<void> {
  await Promise.all([checkHttpStatus(), checkWsStatus()]);
}

/**
 * Update all linker toggle buttons based on current state
 */
function updateAllLinkerToggleButtons(): void {
  document.querySelectorAll(".linker-toggle-btn").forEach((btn) => {
    const button = btn as HTMLButtonElement;
    updateLinkerToggleButton(button);
  });
}

/**
 * Update a single linker toggle button based on current WS state
 */
function updateLinkerToggleButton(button: HTMLButtonElement): void {
  switch (currentWsState) {
    case "connected":
      button.textContent = "Disconnect WS";
      button.className = "secondary linker-toggle-btn";
      button.disabled = false;
      break;
    case "disconnected":
      button.textContent = "Connect WS";
      button.className = "primary linker-toggle-btn";
      button.disabled = false;
      break;
    case "connecting":
      button.textContent = "Connecting...";
      button.className = "secondary linker-toggle-btn";
      button.disabled = true;
      break;
    case "not_configured":
      button.textContent = "Not Configured";
      button.className = "secondary linker-toggle-btn";
      button.disabled = true;
      break;
    default:
      button.textContent = "Loading...";
      button.className = "secondary linker-toggle-btn";
      button.disabled = true;
  }
}

/**
 * Toggle WebSocket connection (connect if disconnected, disconnect if connected)
 */
async function toggleLinkerConnection(button: HTMLButtonElement): Promise<void> {
  try {
    if (currentWsState === "connected") {
      // Disconnect WS
      button.textContent = "Disconnecting...";
      button.disabled = true;

      const message = createRequest(MessageType.LINKER_DISCONNECT, null);
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

      const message = createRequest(MessageType.LINKER_RECONNECT, null);
      const response: ResponseMessage = await chrome.runtime.sendMessage(message);

      if (response.type === MessageType.ERROR) {
        showError(response.error || "Failed to connect WS");
      } else {
        showSuccess("WebSocket connecting...");
      }
    }

    // Update status after a short delay to allow state change
    setTimeout(() => checkLinkerStatus(), 500);
  } catch (error) {
    console.error("Error toggling WS connection:", error);
    showError(error instanceof Error ? error.message : "Failed to toggle connection");
    await checkLinkerStatus();
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
  checkLinkerStatus();
  // Check linker status every 10 seconds
  setInterval(checkLinkerStatus, 10000);

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
