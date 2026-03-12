/**
 * Site detail page - shows hApps and permission for a specific domain
 */

import {
  MessageType,
  createRequest,
  type ResponseMessage,
  type PublishStatusPayload,
} from "../lib/messaging";
import type { Permission } from "../lib/permissions";
import { encodeHashToBase64 } from "@holochain/client";

interface HappContext {
  id: string;
  domain: string;
  appName?: string;
  appVersion?: string;
  agentPubKey: Uint8Array;
  installedAt: number;
  lastUsed: number;
  enabled: boolean;
  status?: "enabled" | "disabled" | "awaitingMemproofs";
  dnaCount: number;
  recoverySealed?: boolean;
}

let siteOrigin = "";
let siteHostname = "";
let contexts: HappContext[] = [];
let debugStatusInterval: number | null = null;
const openDebugSections = new Set<string>();

function getOriginFromUrl(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get("origin") || "";
}

function toUint8Array(
  data: Uint8Array | number[] | Record<string, number>
): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (Array.isArray(data)) return new Uint8Array(data);
  return new Uint8Array(Object.values(data));
}

function formatPubKey(
  pubKey: Uint8Array | number[] | Record<string, number>
): string {
  const b64 = encodeHashToBase64(toUint8Array(pubKey));
  return `${b64.substring(0, 12)}...${b64.substring(b64.length - 8)}`;
}

function formatPubKeyFull(
  pubKey: Uint8Array | number[] | Record<string, number>
): string {
  return encodeHashToBase64(toUint8Array(pubKey));
}

function formatTimestamp(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60000) return "Just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function showMessage(type: "error" | "success", text: string): void {
  const el = document.getElementById("message");
  if (!el) return;
  el.innerHTML = `<div class="message ${type}">${text}</div>`;
  setTimeout(() => {
    el.innerHTML = "";
  }, 4000);
}

async function copyToClipboard(
  text: string,
  element: HTMLElement
): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    element.classList.add("copied");
    setTimeout(() => element.classList.remove("copied"), 2000);
  } catch {
    // ignore
  }
}

async function loadPermission(): Promise<Permission | null> {
  try {
    const response = (await chrome.runtime.sendMessage(
      createRequest(MessageType.PERMISSION_LIST, {})
    )) as ResponseMessage;

    if (response.type === MessageType.ERROR) return null;

    const { permissions } = response.payload as { permissions: Permission[] };
    return permissions.find((p) => p.origin === siteOrigin) || null;
  } catch {
    return null;
  }
}

async function loadHapps(): Promise<void> {
  try {
    const response = (await chrome.runtime.sendMessage(
      createRequest(MessageType.LIST_HAPPS, null)
    )) as ResponseMessage;

    if (response.type === MessageType.ERROR) {
      contexts = [];
      return;
    }

    const allContexts = (response.payload as { contexts: HappContext[] })
      .contexts;

    // Filter to this domain
    contexts = allContexts.filter((c) => {
      if (c.domain === siteOrigin) return true;
      if (c.domain === siteHostname) return true;
      try {
        return new URL(siteOrigin).hostname === c.domain;
      } catch {
        return false;
      }
    });
  } catch {
    contexts = [];
  }
}

function renderPermission(permission: Permission | null): void {
  const badge = document.getElementById("permission-badge");
  const dateEl = document.getElementById("permission-date");
  const revokeBtn = document.getElementById("revoke-btn");

  if (!permission || !permission.granted) {
    if (badge) {
      badge.textContent = "No Permission";
      badge.className = "permission-badge denied";
    }
    if (dateEl) dateEl.textContent = "";
    if (revokeBtn) revokeBtn.classList.add("hidden");
    return;
  }

  if (badge) {
    badge.textContent = "Granted";
    badge.className = "permission-badge granted";
  }
  if (dateEl) dateEl.textContent = formatDate(permission.timestamp);
  if (revokeBtn) revokeBtn.classList.remove("hidden");
}

function renderHapps(): void {
  const listEl = document.getElementById("happ-list");
  const emptyEl = document.getElementById("empty-happs");
  if (!listEl || !emptyEl) return;

  if (contexts.length === 0) {
    emptyEl.classList.remove("hidden");
    listEl.innerHTML = "";
    return;
  }

  emptyEl.classList.add("hidden");
  const sorted = [...contexts].sort((a, b) => b.lastUsed - a.lastUsed);
  listEl.innerHTML = sorted.map(renderHappCard).join("");
  attachEventListeners();
}

function renderHappCard(ctx: HappContext): string {
  const status = ctx.status || (ctx.enabled ? "enabled" : "disabled");
  const statusClass =
    status === "enabled"
      ? "enabled"
      : status === "awaitingMemproofs"
        ? "awaiting"
        : "disabled";
  const statusText =
    status === "enabled"
      ? "Enabled"
      : status === "awaitingMemproofs"
        ? "Awaiting Memproof"
        : "Disabled";
  const disabledClass = status === "enabled" ? "" : "disabled";

  return `
    <div class="happ-card ${disabledClass}" data-id="${ctx.id}">
      <div class="happ-header">
        <div class="happ-name">${ctx.appName || "Unnamed hApp"}</div>
        <span class="status-badge ${statusClass}">${statusText}</span>
      </div>
      <div class="happ-details">
        <div class="detail-item">
          <div class="detail-label">Context ID</div>
          <div class="detail-value">${ctx.id.substring(0, 8)}...</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">Version</div>
          <div class="detail-value">${ctx.appVersion || "N/A"}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">Installed</div>
          <div class="detail-value">${formatTimestamp(ctx.installedAt)}</div>
        </div>
        <div class="detail-item">
          <div class="detail-label">Last Used</div>
          <div class="detail-value">${formatTimestamp(ctx.lastUsed)}</div>
        </div>
        <div class="detail-item" style="grid-column: 1 / -1;">
          <div class="detail-label">Agent Public Key</div>
          <div class="detail-value pubkey" data-full="${formatPubKeyFull(ctx.agentPubKey)}" title="Click to copy">
            ${formatPubKey(ctx.agentPubKey)}
          </div>
        </div>
        <div class="detail-item">
          <div class="detail-label">DNAs</div>
          <div class="detail-value">${ctx.dnaCount} DNA${ctx.dnaCount !== 1 ? "s" : ""}</div>
        </div>
      </div>
      <div class="happ-actions">
        ${
          status === "awaitingMemproofs"
            ? `<button class="primary provide-memproof-btn" data-id="${ctx.id}">Provide Memproof</button>`
            : status === "enabled"
              ? `<button class="secondary disable-btn" data-id="${ctx.id}">Disable</button>`
              : `<button class="primary enable-btn" data-id="${ctx.id}">Enable</button>`
        }
        <button class="secondary debug-btn" data-id="${ctx.id}">Debug</button>
        ${
          ctx.recoverySealed !== true
            ? `<button class="secondary recover-btn" data-context-id="${ctx.id}">Recover</button>`
            : ""
        }
        <button class="danger uninstall-btn" data-id="${ctx.id}">Uninstall</button>
      </div>
      <div class="debug-section hidden" id="debug-${ctx.id}" style="margin-top: 10px; padding-top: 10px; border-top: 1px dashed #e5e7eb; font-size: 12px;">
        <div style="display: flex; gap: 6px; margin-bottom: 8px; flex-wrap: wrap;">
          <span style="padding: 3px 8px; border-radius: 10px; background: #fef3c7; color: #92400e; font-size: 11px;" class="badge-pending" data-id="${ctx.id}">0 pending</span>
          <span style="padding: 3px 8px; border-radius: 10px; background: #dbeafe; color: #1e40af; font-size: 11px;" class="badge-inflight" data-id="${ctx.id}">0 in-flight</span>
          <span style="padding: 3px 8px; border-radius: 10px; background: #fee2e2; color: #991b1b; font-size: 11px;" class="badge-failed" data-id="${ctx.id}">0 failed</span>
        </div>
        <div style="display: flex; gap: 6px; justify-content: flex-end;">
          <button class="secondary retry-failed-btn" data-id="${ctx.id}">Retry Failed</button>
          <button class="primary republish-all-btn" data-id="${ctx.id}">Republish All</button>
        </div>
      </div>
    </div>
  `;
}

function attachEventListeners(): void {
  // Enable/Disable
  document.querySelectorAll(".enable-btn").forEach((btn) =>
    btn.addEventListener("click", async (e) => {
      const id = (e.target as HTMLButtonElement).dataset.id!;
      await toggleContext(id, true);
    })
  );
  document.querySelectorAll(".disable-btn").forEach((btn) =>
    btn.addEventListener("click", async (e) => {
      const id = (e.target as HTMLButtonElement).dataset.id!;
      await toggleContext(id, false);
    })
  );

  // Uninstall
  document.querySelectorAll(".uninstall-btn").forEach((btn) =>
    btn.addEventListener("click", async (e) => {
      const id = (e.target as HTMLButtonElement).dataset.id!;
      await uninstallHapp(id);
    })
  );

  // Copy pubkey
  document.querySelectorAll(".pubkey").forEach((el) =>
    el.addEventListener("click", async (e) => {
      const target = e.target as HTMLElement;
      await copyToClipboard(target.dataset.full!, target);
    })
  );

  // Debug toggle
  document.querySelectorAll(".debug-btn").forEach((btn) =>
    btn.addEventListener("click", async (e) => {
      const id = (e.target as HTMLButtonElement).dataset.id!;
      await toggleDebugSection(id);
    })
  );

  // Retry / Republish
  document.querySelectorAll(".retry-failed-btn").forEach((btn) =>
    btn.addEventListener("click", async (e) => {
      const id = (e.target as HTMLButtonElement).dataset.id!;
      await retryFailed(id);
    })
  );
  document.querySelectorAll(".republish-all-btn").forEach((btn) =>
    btn.addEventListener("click", async (e) => {
      const id = (e.target as HTMLButtonElement).dataset.id!;
      await republishAll(id);
    })
  );

  // Provide memproof
  document.querySelectorAll(".provide-memproof-btn").forEach((btn) =>
    btn.addEventListener("click", async (e) => {
      const id = (e.target as HTMLButtonElement).dataset.id!;
      await showMemproofDialog(id);
    })
  );

  // Recover chain
  document.querySelectorAll(".recover-btn").forEach((btn) =>
    btn.addEventListener("click", async (e) => {
      const contextId = (e.target as HTMLElement).dataset.contextId;
      if (!contextId) return;
      if (
        !confirm(
          "Recover chain data from the DHT? This requires an active linker connection."
        )
      )
        return;
      await recoverChain(contextId);
    })
  );
}

async function toggleContext(id: string, enabled: boolean): Promise<void> {
  try {
    const msgType = enabled ? MessageType.ENABLE_HAPP : MessageType.DISABLE_HAPP;
    const response = (await chrome.runtime.sendMessage(
      createRequest(msgType, { contextId: id })
    )) as ResponseMessage;

    if (response.type === MessageType.ERROR) {
      throw new Error(response.error || "Failed");
    }

    const ctx = contexts.find((c) => c.id === id);
    if (ctx) {
      ctx.enabled = enabled;
      ctx.status = enabled ? "enabled" : "disabled";
    }
    renderHapps();
    showMessage("success", `hApp ${enabled ? "enabled" : "disabled"}`);
  } catch (error) {
    showMessage(
      "error",
      error instanceof Error ? error.message : "Failed to update"
    );
  }
}

async function uninstallHapp(id: string): Promise<void> {
  const ctx = contexts.find((c) => c.id === id);
  const name = ctx?.appName || "this hApp";
  if (
    !confirm(
      `Uninstall "${name}"?\n\nThis deletes the context and agent key permanently.`
    )
  )
    return;

  try {
    const response = (await chrome.runtime.sendMessage(
      createRequest(MessageType.UNINSTALL_HAPP, { contextId: id })
    )) as ResponseMessage;

    if (response.type === MessageType.ERROR) {
      throw new Error(response.error || "Failed");
    }

    contexts = contexts.filter((c) => c.id !== id);
    renderHapps();
    showMessage("success", `"${name}" uninstalled`);
  } catch (error) {
    showMessage(
      "error",
      error instanceof Error ? error.message : "Failed to uninstall"
    );
  }
}

async function toggleDebugSection(id: string): Promise<void> {
  const section = document.getElementById(`debug-${id}`);
  if (!section) return;

  const isVisible = !section.classList.contains("hidden");
  if (isVisible) {
    section.classList.add("hidden");
    openDebugSections.delete(id);
    if (openDebugSections.size === 0 && debugStatusInterval) {
      clearInterval(debugStatusInterval);
      debugStatusInterval = null;
    }
  } else {
    section.classList.remove("hidden");
    openDebugSections.add(id);
    await fetchPublishStatus(id);
    if (!debugStatusInterval) {
      debugStatusInterval = window.setInterval(async () => {
        for (const cid of openDebugSections) {
          await fetchPublishStatus(cid);
        }
      }, 2000);
    }
  }
}

async function fetchPublishStatus(id: string): Promise<void> {
  try {
    const response = (await chrome.runtime.sendMessage(
      createRequest(MessageType.PUBLISH_GET_STATUS, { contextId: id })
    )) as ResponseMessage;

    if (response.type === MessageType.ERROR) return;

    const { pending, inFlight, failed } =
      response.payload as PublishStatusPayload;

    const pendingEl = document.querySelector(
      `.badge-pending[data-id="${id}"]`
    ) as HTMLElement;
    const inflightEl = document.querySelector(
      `.badge-inflight[data-id="${id}"]`
    ) as HTMLElement;
    const failedEl = document.querySelector(
      `.badge-failed[data-id="${id}"]`
    ) as HTMLElement;

    if (pendingEl) pendingEl.textContent = `${pending} pending`;
    if (inflightEl) inflightEl.textContent = `${inFlight} in-flight`;
    if (failedEl) failedEl.textContent = `${failed} failed`;
  } catch {
    // ignore
  }
}

async function retryFailed(id: string): Promise<void> {
  try {
    const response = (await chrome.runtime.sendMessage(
      createRequest(MessageType.PUBLISH_RETRY_FAILED, { contextId: id })
    )) as ResponseMessage;

    if (response.type === MessageType.ERROR) {
      throw new Error(response.error || "Failed");
    }

    const { resetCount } = response.payload as { resetCount: number };
    showMessage("success", `Reset ${resetCount} failed ops to pending`);
    await fetchPublishStatus(id);
  } catch (error) {
    showMessage(
      "error",
      error instanceof Error ? error.message : "Failed to retry"
    );
  }
}

async function republishAll(id: string): Promise<void> {
  const ctx = contexts.find((c) => c.id === id);
  const name = ctx?.appName || "this hApp";
  if (
    !confirm(
      `Republish all records for "${name}"?\n\nThis re-queues all DHT operations from local chain data.`
    )
  )
    return;

  try {
    const response = (await chrome.runtime.sendMessage(
      createRequest(MessageType.PUBLISH_ALL_RECORDS, { contextId: id })
    )) as ResponseMessage;

    if (response.type === MessageType.ERROR) {
      throw new Error(response.error || "Failed");
    }

    const { cellsProcessed, opsQueued, errors } = response.payload as {
      cellsProcessed: number;
      opsQueued: number;
      errors: string[];
    };
    if (errors?.length > 0) {
      showMessage("error", `Republished with errors: ${errors.join(", ")}`);
    } else {
      showMessage(
        "success",
        `Queued ${opsQueued} ops from ${cellsProcessed} cells`
      );
    }
    await fetchPublishStatus(id);
  } catch (error) {
    showMessage(
      "error",
      error instanceof Error ? error.message : "Failed to republish"
    );
  }
}

async function showMemproofDialog(id: string): Promise<void> {
  const ctx = contexts.find((c) => c.id === id);
  const name = ctx?.appName || "Unnamed hApp";

  const input = prompt(
    `Enter membrane proof for "${name}":\n\nPaste base64-encoded or hex-encoded proof bytes.`
  );
  if (!input?.trim()) return;

  const trimmed = input.trim();
  let proofBytes: Uint8Array;
  try {
    if (/^[A-Za-z0-9+/=]+$/.test(trimmed)) {
      const binary = atob(trimmed);
      proofBytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        proofBytes[i] = binary.charCodeAt(i);
      }
    } else if (/^[0-9a-fA-F]+$/.test(trimmed)) {
      const bytes = trimmed.match(/.{1,2}/g)!;
      proofBytes = new Uint8Array(bytes.map((b) => parseInt(b, 16)));
    } else {
      showMessage("error", "Invalid format. Use base64 or hex encoding.");
      return;
    }
  } catch {
    showMessage("error", "Failed to decode proof bytes.");
    return;
  }

  try {
    const memproofs: Record<string, Uint8Array> = { default: proofBytes };
    const response = (await chrome.runtime.sendMessage(
      createRequest(MessageType.PROVIDE_MEMPROOFS, { contextId: id, memproofs })
    )) as ResponseMessage;

    if (response.type === MessageType.ERROR) {
      throw new Error(response.error || "Failed");
    }

    const c = contexts.find((x) => x.id === id);
    if (c) {
      c.status = "enabled";
      c.enabled = true;
    }
    renderHapps();
    showMessage("success", "Membrane proof accepted");
  } catch (error) {
    showMessage(
      "error",
      error instanceof Error ? error.message : "Failed to provide membrane proof"
    );
  }
}

async function recoverChain(contextId: string): Promise<void> {
  try {
    const response = (await chrome.runtime.sendMessage(
      createRequest(MessageType.RECOVER_CHAIN, { contextId })
    )) as ResponseMessage;

    if (response.type === MessageType.ERROR) {
      showMessage("error", `Recovery failed: ${response.error || "Unknown"}`);
      return;
    }

    const data = response.payload as {
      recoveredCount: number;
      failedCount: number;
      verifiedCount: number;
    };
    showMessage(
      "success",
      `Recovered ${data.recoveredCount || 0} records (${data.verifiedCount || 0} verified), ${data.failedCount || 0} failed`
    );
  } catch (error) {
    showMessage(
      "error",
      error instanceof Error ? error.message : "Recovery failed"
    );
  }
}

async function revokePermission(): Promise<void> {
  if (
    !confirm(
      `Revoke permission for ${siteHostname}?\n\nThe site will need to request permission again.`
    )
  )
    return;

  try {
    const response = (await chrome.runtime.sendMessage(
      createRequest(MessageType.PERMISSION_REVOKE, { origin: siteOrigin })
    )) as ResponseMessage;

    if (response.type === MessageType.ERROR) {
      showMessage("error", `Failed to revoke: ${response.error}`);
      return;
    }

    // Go back to main page
    window.location.href = "index.html";
  } catch (error) {
    showMessage(
      "error",
      error instanceof Error ? error.message : "Failed to revoke"
    );
  }
}

async function initialize(): Promise<void> {
  siteOrigin = getOriginFromUrl();
  if (!siteOrigin) {
    window.location.href = "index.html";
    return;
  }

  try {
    siteHostname = new URL(siteOrigin).hostname;
  } catch {
    siteHostname = siteOrigin;
  }

  // Set header
  const hostnameEl = document.getElementById("site-hostname");
  const originEl = document.getElementById("site-origin");
  if (hostnameEl) hostnameEl.textContent = "Holo Web Conductor:";
  if (originEl) originEl.textContent = siteOrigin;

  // Revoke button
  document.getElementById("revoke-btn")?.addEventListener("click", () => {
    revokePermission();
  });

  // Load data
  const [permission] = await Promise.all([loadPermission(), loadHapps()]);
  renderPermission(permission);
  renderHapps();
}

document.addEventListener("DOMContentLoaded", initialize);
