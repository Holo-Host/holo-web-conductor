/**
 * Permission management UI logic
 *
 * Allows users to view and revoke domain permissions
 */

import { createRequest, MessageType, type ResponseMessage } from "../lib/messaging";
import type { Permission } from "../lib/permissions";
import { formatDate, showConfirm } from "./utils";

/**
 * Show error message
 */
function showError(message: string): void {
  const errorContainer = document.getElementById("error-container");
  const errorMessage = document.getElementById("error-message");

  if (errorContainer) errorContainer.classList.remove("hidden");
  if (errorMessage) errorMessage.textContent = message;
}

/**
 * Hide error message
 */
function hideError(): void {
  const errorContainer = document.getElementById("error-container");
  if (errorContainer) errorContainer.classList.add("hidden");
}

/**
 * Revoke permission for a specific origin
 */
async function revokePermission(origin: string): Promise<void> {
  const confirmed = await showConfirm(
    `Disconnect ${origin} from the Holo Web Conductor?\n\nThis will require re-authorization if the site attempts to connect again.`,
    { variant: "danger" }
  );

  if (!confirmed) {
    return;
  }

  try {
    const response = (await chrome.runtime.sendMessage(
      createRequest(MessageType.PERMISSION_REVOKE, { origin })
    )) as ResponseMessage;

    if (response.type === MessageType.ERROR) {
      showError(`Failed to revoke permission: ${response.error}`);
      return;
    }

    console.log(`[Permissions] Revoked permission for ${origin}`);

    // Reload permissions list
    await loadPermissions();
  } catch (error) {
    console.error("[Permissions] Error revoking:", error);
    showError(
      `Error revoking permission: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Revoke all permissions
 */
async function revokeAllPermissions(): Promise<void> {
  const confirmed = await showConfirm(
    "Disconnect ALL sites from the Holo Web Conductor?\n\nThis will clear all authorized domains. They will need to request permission again.",
    { variant: "danger" }
  );

  if (!confirmed) {
    return;
  }

  try {
    // Get all permissions and revoke them one by one
    const response = (await chrome.runtime.sendMessage(
      createRequest(MessageType.PERMISSION_LIST, {})
    )) as ResponseMessage;

    if (response.type === MessageType.ERROR) {
      showError(`Failed to load permissions: ${response.error}`);
      return;
    }

    const { permissions } = response.payload as { permissions: Permission[] };

    // Revoke each permission
    for (const permission of permissions) {
      await chrome.runtime.sendMessage(
        createRequest(MessageType.PERMISSION_REVOKE, { origin: permission.origin })
      );
    }

    console.log(`[Permissions] Revoked all ${permissions.length} permissions`);

    // Reload permissions list
    await loadPermissions();
  } catch (error) {
    console.error("[Permissions] Error revoking all:", error);
    showError(
      `Error revoking all permissions: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Render permissions table
 */
function renderPermissions(permissions: Permission[]): void {
  const loadingState = document.getElementById("loading-state");
  const emptyState = document.getElementById("empty-state");
  const tableContainer = document.getElementById("permissions-table-container");
  const tbody = document.getElementById("permissions-tbody");

  // Hide loading
  if (loadingState) loadingState.classList.add("hidden");

  if (permissions.length === 0) {
    // Show empty state
    if (emptyState) emptyState.classList.remove("hidden");
    if (tableContainer) tableContainer.classList.add("hidden");
    return;
  }

  // Show table
  if (emptyState) emptyState.classList.add("hidden");
  if (tableContainer) tableContainer.classList.remove("hidden");

  if (!tbody) return;

  // Clear existing rows
  tbody.innerHTML = "";

  // Sort by timestamp (most recent first)
  const sorted = [...permissions].sort((a, b) => b.timestamp - a.timestamp);

  // Create rows
  sorted.forEach((permission) => {
    const row = document.createElement("tr");

    // Domain cell
    const domainCell = document.createElement("td");
    domainCell.className = "origin";
    domainCell.textContent = permission.origin;
    row.appendChild(domainCell);

    // Status cell
    const statusCell = document.createElement("td");
    const statusBadge = document.createElement("span");
    statusBadge.className = `status ${permission.granted ? "granted" : "denied"}`;
    statusBadge.textContent = permission.granted ? "Connected" : "Denied";
    statusCell.appendChild(statusBadge);
    row.appendChild(statusCell);

    // Timestamp cell
    const timestampCell = document.createElement("td");
    timestampCell.className = "timestamp";
    timestampCell.textContent = formatDate(permission.timestamp);
    row.appendChild(timestampCell);

    // Action cell
    const actionCell = document.createElement("td");
    const revokeBtn = document.createElement("button");
    revokeBtn.className = "revoke-btn";
    revokeBtn.textContent = "Disconnect";
    revokeBtn.title = `Disconnect ${permission.origin} from the Holo Web Conductor`;
    revokeBtn.addEventListener("click", async () => {
      revokeBtn.disabled = true;
      await revokePermission(permission.origin);
    });
    actionCell.appendChild(revokeBtn);
    row.appendChild(actionCell);

    tbody.appendChild(row);
  });
}

/**
 * Load permissions from background
 */
async function loadPermissions(): Promise<void> {
  hideError();

  try {
    const response = (await chrome.runtime.sendMessage(
      createRequest(MessageType.PERMISSION_LIST, {})
    )) as ResponseMessage;

    if (response.type === MessageType.ERROR) {
      showError(`Failed to load permissions: ${response.error}`);
      return;
    }

    const { permissions } = response.payload as { permissions: Permission[] };
    console.log(`[Permissions] Loaded ${permissions.length} permissions`);

    renderPermissions(permissions);
  } catch (error) {
    console.error("[Permissions] Error loading permissions:", error);
    showError(
      `Failed to load permissions: ${error instanceof Error ? error.message : String(error)}`
    );

    // Show empty state on error
    const loadingState = document.getElementById("loading-state");
    const emptyState = document.getElementById("empty-state");
    if (loadingState) loadingState.classList.add("hidden");
    if (emptyState) emptyState.classList.remove("hidden");
  }
}

/**
 * Initialize permissions page
 */
async function initialize(): Promise<void> {
  // Set up clear all button
  const clearAllBtn = document.getElementById("clear-all-btn");
  if (clearAllBtn) {
    clearAllBtn.addEventListener("click", async () => {
      clearAllBtn.setAttribute("disabled", "true");
      await revokeAllPermissions();
      clearAllBtn.removeAttribute("disabled");
    });
  }

  // Load permissions
  await loadPermissions();
}

// Initialize on DOMContentLoaded
document.addEventListener("DOMContentLoaded", initialize);
