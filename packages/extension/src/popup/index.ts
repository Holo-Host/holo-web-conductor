/**
 * Main popup UI - domain-centric view
 *
 * Shows authorized websites, each linking to a detail page
 * with per-domain hApps and permission management.
 */

import { createRequest, MessageType, type ResponseMessage } from "../lib/messaging";
import type { Permission } from "../lib/permissions";

interface HappContext {
  id: string;
  domain: string;
  appName?: string;
  enabled: boolean;
  status?: "enabled" | "disabled" | "awaitingMemproofs";
}

interface DomainInfo {
  origin: string;
  hostname: string;
  permission: Permission;
  happs: HappContext[];
}

async function updateConnectionStatus(): Promise<void> {
  const dot = document.getElementById("status-dot");
  const text = document.getElementById("status-text");
  if (!dot || !text) return;

  try {
    const currentWindow = await chrome.windows.getCurrent();
    if (currentWindow.type === "popup") {
      dot.className = "status-dot connected";
      text.textContent = "Extension active";
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url) {
      const url = new URL(tab.url);
      dot.className = "status-dot connected";
      text.textContent = url.hostname;
    } else {
      dot.className = "status-dot disconnected";
      text.textContent = "No active page";
    }
  } catch {
    dot.className = "status-dot disconnected";
    text.textContent = "Error";
  }
}

async function checkStorageStatus(): Promise<void> {
  const warningEl = document.getElementById("storage-warning");
  const storageBtn = document.getElementById("btn-storage");
  if (!warningEl || !storageBtn) return;

  try {
    if (navigator.storage?.persist) {
      const persisted = await navigator.storage.persist();
      if (!persisted) {
        warningEl.classList.remove("hidden");
        storageBtn.classList.add("warning-active");
        return;
      }
    } else {
      warningEl.classList.remove("hidden");
      storageBtn.classList.add("warning-active");
      return;
    }
  } catch {
    warningEl.classList.remove("hidden");
    storageBtn.classList.add("warning-active");
    return;
  }
  // Storage is fine - hide the storage button entirely
  storageBtn.classList.add("hidden");
}

async function loadDomains(): Promise<void> {
  const listEl = document.getElementById("domain-list");
  const emptyEl = document.getElementById("empty-state");
  const loadingEl = document.getElementById("loading-state");
  if (!listEl || !emptyEl || !loadingEl) return;

  try {
    // Load permissions and hApps in parallel
    const [permResponse, happsResponse] = await Promise.all([
      chrome.runtime.sendMessage(
        createRequest(MessageType.PERMISSION_LIST, {})
      ) as Promise<ResponseMessage>,
      chrome.runtime.sendMessage(
        createRequest(MessageType.LIST_HAPPS, null)
      ) as Promise<ResponseMessage>,
    ]);

    const permissions: Permission[] =
      permResponse.type !== MessageType.ERROR
        ? (permResponse.payload as { permissions: Permission[] }).permissions
        : [];

    const happs: HappContext[] =
      happsResponse.type !== MessageType.ERROR
        ? (happsResponse.payload as { contexts: HappContext[] }).contexts
        : [];

    // Build domain map from permissions (only granted)
    const domainMap = new Map<string, DomainInfo>();

    for (const perm of permissions) {
      if (!perm.granted) continue;
      let hostname: string;
      try {
        hostname = new URL(perm.origin).hostname;
      } catch {
        hostname = perm.origin;
      }
      domainMap.set(perm.origin, {
        origin: perm.origin,
        hostname,
        permission: perm,
        happs: [],
      });
    }

    // Associate hApps with domains
    for (const happ of happs) {
      // Try to match hApp domain to a permission origin
      let matched = false;
      for (const [origin, info] of domainMap) {
        try {
          const originHost = new URL(origin).hostname;
          if (happ.domain === origin || happ.domain === originHost) {
            info.happs.push(happ);
            matched = true;
            break;
          }
        } catch {
          if (happ.domain === origin) {
            info.happs.push(happ);
            matched = true;
            break;
          }
        }
      }
      // If hApp has no matching permission, create an entry for its domain
      if (!matched && happ.domain) {
        const existing = domainMap.get(happ.domain);
        if (existing) {
          existing.happs.push(happ);
        } else {
          domainMap.set(happ.domain, {
            origin: happ.domain,
            hostname: happ.domain,
            permission: { origin: happ.domain, granted: false, timestamp: 0 },
            happs: [happ],
          });
        }
      }
    }

    loadingEl.classList.add("hidden");

    if (domainMap.size === 0) {
      emptyEl.classList.remove("hidden");
      listEl.innerHTML = "";
      return;
    }

    emptyEl.classList.add("hidden");

    // Sort by most recent permission timestamp
    const sorted = [...domainMap.values()].sort(
      (a, b) => b.permission.timestamp - a.permission.timestamp
    );

    listEl.innerHTML = sorted.map(renderDomainItem).join("");
  } catch (error) {
    console.error("[Popup] Error loading domains:", error);
    loadingEl.classList.add("hidden");
    emptyEl.classList.remove("hidden");
  }
}

function renderDomainItem(domain: DomainInfo): string {
  const initial = domain.hostname.charAt(0).toUpperCase();
  const happCount = domain.happs.length;
  const enabledCount = domain.happs.filter(
    (h) => h.enabled || h.status === "enabled"
  ).length;

  let meta = "";
  if (happCount > 0) {
    meta = `${happCount} hApp${happCount !== 1 ? "s" : ""}`;
    if (enabledCount < happCount) {
      meta += ` (${enabledCount} active)`;
    }
  } else {
    meta = "No hApps installed";
  }

  const encodedOrigin = encodeURIComponent(domain.origin);

  return `
    <li>
      <a class="domain-item" href="site.html?origin=${encodedOrigin}">
        <div class="domain-icon">${initial}</div>
        <div class="domain-info">
          <div class="domain-name">${domain.hostname}</div>
          <div class="domain-meta">${meta}</div>
        </div>
        <div class="domain-arrow">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="9 18 15 12 9 6"/>
          </svg>
        </div>
      </a>
    </li>
  `;
}

async function revokeAllPermissions(): Promise<void> {
  const confirmed = confirm(
    "Revoke ALL permissions?\n\nAll sites will need to request permission again."
  );
  if (!confirmed) return;

  try {
    const response = (await chrome.runtime.sendMessage(
      createRequest(MessageType.PERMISSION_LIST, {})
    )) as ResponseMessage;

    if (response.type === MessageType.ERROR) return;

    const { permissions } = response.payload as { permissions: Permission[] };
    for (const perm of permissions) {
      await chrome.runtime.sendMessage(
        createRequest(MessageType.PERMISSION_REVOKE, { origin: perm.origin })
      );
    }

    await loadDomains();
  } catch (error) {
    console.error("[Popup] Error revoking all:", error);
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  // Navigation buttons - all use page navigation (unified pattern)
  document.getElementById("btn-keystore")?.addEventListener("click", () => {
    window.location.href = "lair.html";
  });

  document.getElementById("btn-revoke-all")?.addEventListener("click", () => {
    revokeAllPermissions();
  });

  document.getElementById("btn-storage")?.addEventListener("click", () => {
    window.location.href = "lair.html";
  });

  document.getElementById("btn-about")?.addEventListener("click", () => {
    window.location.href = "about.html";
  });

  await Promise.all([
    updateConnectionStatus(),
    checkStorageStatus(),
    loadDomains(),
  ]);
});
