/**
 * Authorization popup logic
 *
 * Handles user approval/denial of domain connection requests
 */

import { createRequest, MessageType, type ResponseMessage } from "../lib/messaging";

// Parse URL parameters
const params = new URLSearchParams(window.location.search);
const requestId = params.get("requestId");

/**
 * Show error state
 */
function showError(message: string): void {
  const loadingState = document.getElementById("loading-state");
  const mainContent = document.getElementById("main-content");
  const errorState = document.getElementById("error-state");
  const errorMessage = document.getElementById("error-message");

  if (loadingState) loadingState.classList.add("hidden");
  if (mainContent) mainContent.classList.add("hidden");
  if (errorState) errorState.classList.remove("hidden");
  if (errorMessage) errorMessage.textContent = message;
}

/**
 * Show main content
 */
function showMainContent(): void {
  const loadingState = document.getElementById("loading-state");
  const mainContent = document.getElementById("main-content");

  if (loadingState) loadingState.classList.add("hidden");
  if (mainContent) mainContent.classList.remove("hidden");
}

/**
 * Handle approve button click
 */
async function handleApprove(requestId: string, origin: string): Promise<void> {
  try {
    const response = (await chrome.runtime.sendMessage(
      createRequest(MessageType.PERMISSION_GRANT, { requestId, origin })
    )) as ResponseMessage;

    if (response.type === MessageType.ERROR) {
      console.error("[Authorize] Failed to grant permission:", response.error);
      showError(`Failed to approve: ${response.error}`);
      return;
    }

    window.close();
  } catch (error) {
    console.error("[Authorize] Error approving:", error);
    showError(
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Handle deny button click
 */
async function handleDeny(requestId: string, origin: string): Promise<void> {
  try {
    const response = (await chrome.runtime.sendMessage(
      createRequest(MessageType.PERMISSION_DENY, { requestId, origin })
    )) as ResponseMessage;

    if (response.type === MessageType.ERROR) {
      console.error("[Authorize] Failed to deny permission:", response.error);
      showError(`Failed to deny: ${response.error}`);
      return;
    }

    window.close();
  } catch (error) {
    console.error("[Authorize] Error denying:", error);
    showError(
      `Error: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Initialize authorization popup
 */
async function initialize(): Promise<void> {
  if (!requestId) {
    showError("Invalid authorization request - missing request ID");
    return;
  }

  try {
    // Get request details from background
    const response = (await chrome.runtime.sendMessage(
      createRequest(MessageType.AUTH_REQUEST_INFO, { requestId })
    )) as ResponseMessage;

    if (response.type === MessageType.ERROR) {
      showError(`Request not found: ${response.error}`);
      return;
    }

    const { origin, timestamp } = response.payload as {
      origin: string;
      timestamp: number;
    };

    // Display origin
    const originDisplay = document.getElementById("origin-display");
    if (originDisplay) {
      originDisplay.textContent = origin;
    }

    // Set up button handlers
    const approveBtn = document.getElementById("approve-btn");
    const denyBtn = document.getElementById("deny-btn");

    if (approveBtn) {
      approveBtn.addEventListener("click", async () => {
        approveBtn.setAttribute("disabled", "true");
        if (denyBtn) denyBtn.setAttribute("disabled", "true");
        await handleApprove(requestId, origin);
      });
    }

    if (denyBtn) {
      denyBtn.addEventListener("click", async () => {
        denyBtn.setAttribute("disabled", "true");
        if (approveBtn) approveBtn.setAttribute("disabled", "true");
        await handleDeny(requestId, origin);
      });
    }

    // Show main content
    showMainContent();
  } catch (error) {
    console.error("[Authorize] Error initializing:", error);
    showError(
      `Failed to load authorization request: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

// Initialize on DOMContentLoaded
document.addEventListener("DOMContentLoaded", initialize);
