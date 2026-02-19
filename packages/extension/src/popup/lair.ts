/**
 * Lair management popup UI
 *
 * Handles lock/unlock, keypair management, signing/verification, and export/import
 */

import {
  createRequest,
  MessageType,
  type RequestMessage,
  type ResponseMessage,
  type Message,
} from "../lib/messaging";
import type { EntryInfo, EncryptedExport } from "@hwc/lair";

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Send a message to the background service worker
 */
async function sendMessage(
  type: RequestMessage["type"],
  payload?: unknown
): Promise<ResponseMessage> {
  const request = createRequest(type, payload);
  return chrome.runtime.sendMessage(request);
}

/**
 * Convert Uint8Array to base64 string
 * Handles both actual Uint8Arrays and serialized objects from Chrome messaging
 */
function toBase64(data: Uint8Array | any): string {
  let bytes: number[];

  if (data instanceof Uint8Array) {
    bytes = Array.from(data);
  } else if (Array.isArray(data)) {
    bytes = data;
  } else if (typeof data === 'object' && data !== null) {
    // Serialized Uint8Array comes back as object with numeric keys
    bytes = Object.values(data) as number[];
  } else {
    throw new Error('Invalid data type for toBase64');
  }

  return btoa(String.fromCharCode(...bytes));
}

/**
 * Convert base64 string to Uint8Array
 */
function fromBase64(base64: string): Uint8Array {
  if (!base64 || typeof base64 !== 'string') {
    throw new Error('Invalid base64 string');
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Convert text to Uint8Array
 */
function textToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * Show/hide element
 */
function setVisible(id: string, visible: boolean): void {
  const el = document.getElementById(id);
  if (el) {
    if (visible) {
      el.classList.remove("hidden");
    } else {
      el.classList.add("hidden");
    }
  }
}

/**
 * Set text content
 */
function setText(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = text;
  }
}

/**
 * Get input value
 */
function getValue(id: string): string {
  const el = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement;
  return el ? el.value : "";
}

/**
 * Set input value
 */
function setValue(id: string, value: string): void {
  const el = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement;
  if (el) {
    el.value = value;
  }
}

/**
 * Get checkbox checked state
 */
function isChecked(id: string): boolean {
  const el = document.getElementById(id) as HTMLInputElement;
  return el ? el.checked : false;
}

// ============================================================================
// Lock State Management
// ============================================================================

interface LockState {
  isLocked: boolean;
  passphraseHash?: string;
  salt?: string;
  lastUnlocked?: number;
}

let currentLockState: LockState | null = null;

/**
 * Update the UI based on lock state
 */
async function updateLockState(): Promise<void> {
  try {
    const response = await sendMessage(MessageType.LAIR_GET_LOCK_STATE);

    if (response.type === MessageType.ERROR) {
      console.error("Failed to get lock state:", response.error);
      return;
    }

    currentLockState = response.payload as LockState;
    const isLocked = currentLockState.isLocked;
    const hasPassphrase = !!currentLockState.passphraseHash;

    // Update lock status display
    const lockStatusEl = document.getElementById("lock-status");
    const lockStatusTextEl = document.getElementById("lock-status-text");

    if (lockStatusEl && lockStatusTextEl) {
      if (isLocked) {
        lockStatusEl.className = "lock-status locked";
        lockStatusTextEl.textContent = "🔒 Locked";
      } else {
        lockStatusEl.className = "lock-status unlocked";
        lockStatusTextEl.textContent = "🔓 Unlocked";
      }
    }

    // Show appropriate lock/unlock sections
    if (!hasPassphrase) {
      // No passphrase set - show setup
      setVisible("passphrase-setup", true);
      setVisible("unlock-section", false);
      setVisible("lock-section", false);
    } else if (isLocked) {
      // Locked - show unlock
      setVisible("passphrase-setup", false);
      setVisible("unlock-section", true);
      setVisible("lock-section", false);
    } else {
      // Unlocked - show lock
      setVisible("passphrase-setup", false);
      setVisible("unlock-section", false);
      setVisible("lock-section", true);
    }

    // Enable/disable other sections based on lock state
    const sections = ["keypair-section", "sign-verify-section", "export-import-section", "seed-phrase-section"];
    sections.forEach((sectionId) => {
      const el = document.getElementById(sectionId);
      if (el) {
        if (isLocked) {
          el.classList.add("disabled");
        } else {
          el.classList.remove("disabled");
        }
      }
    });

    // Refresh keypair list if unlocked
    if (!isLocked) {
      await refreshKeypairList();
    }
  } catch (error) {
    console.error("Error updating lock state:", error);
  }
}

/**
 * Set passphrase
 */
async function setPassphrase(): Promise<void> {
  const passphrase = getValue("new-passphrase");
  setVisible("set-passphrase-error", false);

  if (!passphrase || passphrase.length < 8) {
    setText("set-passphrase-error", "Passphrase must be at least 8 characters");
    setVisible("set-passphrase-error", true);
    return;
  }

  try {
    const response = await sendMessage(MessageType.LAIR_SET_PASSPHRASE, {
      passphrase,
    });

    if (response.type === MessageType.ERROR) {
      setText("set-passphrase-error", response.error || "Failed to set passphrase");
      setVisible("set-passphrase-error", true);
      return;
    }

    // Clear input and refresh state
    setValue("new-passphrase", "");
    await updateLockState();
  } catch (error) {
    setText("set-passphrase-error", String(error));
    setVisible("set-passphrase-error", true);
  }
}

/**
 * Unlock keystore
 */
async function unlock(): Promise<void> {
  const passphrase = getValue("unlock-passphrase");
  setVisible("unlock-error", false);

  if (!passphrase) {
    setText("unlock-error", "Passphrase is required");
    setVisible("unlock-error", true);
    return;
  }

  try {
    const response = await sendMessage(MessageType.LAIR_UNLOCK, { passphrase });

    if (response.type === MessageType.ERROR) {
      setText("unlock-error", response.error || "Failed to unlock");
      setVisible("unlock-error", true);
      return;
    }

    // Clear input and refresh state
    setValue("unlock-passphrase", "");
    await updateLockState();
  } catch (error) {
    setText("unlock-error", String(error));
    setVisible("unlock-error", true);
  }
}

/**
 * Lock keystore
 */
async function lock(): Promise<void> {
  try {
    await sendMessage(MessageType.LAIR_LOCK);
    await updateLockState();
  } catch (error) {
    console.error("Error locking:", error);
  }
}

// ============================================================================
// Keypair Management
// ============================================================================

let keypairs: EntryInfo[] = [];

/**
 * Refresh the list of keypairs
 */
async function refreshKeypairList(): Promise<void> {
  try {
    console.log("[Lair UI] Refreshing keypair list...");
    const response = await sendMessage(MessageType.LAIR_LIST_ENTRIES);

    if (response.type === MessageType.ERROR) {
      console.error("[Lair UI] Failed to list entries:", response.error);
      return;
    }

    keypairs = (response.payload as { entries: EntryInfo[] }).entries;
    console.log("[Lair UI] Received keypairs:", keypairs.length, keypairs);
    renderKeypairList();
    updateKeypairSelects();
    populateBackupKeySelect(keypairs);
  } catch (error) {
    console.error("[Lair UI] Error refreshing keypair list:", error);
  }
}

/**
 * Render the keypair list as a table
 */
function renderKeypairList(): void {
  const listEl = document.getElementById("keypair-list");
  if (!listEl) return;

  if (keypairs.length === 0) {
    listEl.innerHTML = '<p style="font-size: 12px; color: #666;">No keypairs yet.</p>';
    return;
  }

  const table = document.createElement("table");
  table.innerHTML = `
    <thead>
      <tr>
        <th>Tag</th>
        <th>Public Key (Ed25519)</th>
        <th>Created</th>
        <th>Exportable</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody>
      ${keypairs
        .map(
          (kp) => `
        <tr>
          <td><strong>${kp.tag}</strong></td>
          <td class="pubkey"
              data-pubkey="${toBase64(kp.ed25519_pub_key)}"
              title="Click to copy: ${toBase64(kp.ed25519_pub_key)}"
              style="cursor: pointer;">
            ${toBase64(kp.ed25519_pub_key).substring(0, 20)}...
          </td>
          <td>${new Date(kp.created_at).toLocaleString()}</td>
          <td>
            <span class="badge ${kp.exportable ? "exportable" : "non-exportable"}">
              ${kp.exportable ? "Yes" : "No"}
            </span>
          </td>
          <td>
            <button class="danger delete-btn" data-tag="${kp.tag}">Delete</button>
          </td>
        </tr>
      `
        )
        .join("")}
    </tbody>
  `;

  listEl.innerHTML = "";
  listEl.appendChild(table);

  // Add click handlers to public key cells
  table.querySelectorAll('.pubkey').forEach((cell) => {
    cell.addEventListener('click', async () => {
      const pubkey = (cell as HTMLElement).dataset.pubkey;
      if (pubkey) {
        try {
          await navigator.clipboard.writeText(pubkey);
          // Show feedback
          const originalText = cell.textContent;
          cell.textContent = '✓ Copied!';
          setTimeout(() => {
            cell.textContent = originalText;
          }, 1000);
        } catch (error) {
          console.error('Failed to copy:', error);
          alert('Failed to copy to clipboard');
        }
      }
    });
  });

  // Add click handlers to delete buttons
  table.querySelectorAll('.delete-btn').forEach((button) => {
    button.addEventListener('click', async () => {
      const tag = (button as HTMLElement).dataset.tag;
      if (tag) {
        await deleteKeypair(tag);
      }
    });
  });
}

/**
 * Update keypair select dropdowns
 */
function updateKeypairSelects(): void {
  // Sign keypair select
  const signSelect = document.getElementById("sign-keypair") as HTMLSelectElement;
  if (signSelect) {
    signSelect.innerHTML =
      '<option value="">-- Select keypair --</option>' +
      keypairs
        .map(
          (kp) =>
            `<option value="${toBase64(kp.ed25519_pub_key)}">${kp.tag}</option>`
        )
        .join("");
  }

  // Export keypair select (only exportable ones)
  const exportSelect = document.getElementById("export-keypair") as HTMLSelectElement;
  if (exportSelect) {
    const exportableKeypairs = keypairs.filter((kp) => kp.exportable);
    exportSelect.innerHTML =
      '<option value="">-- Select keypair --</option>' +
      exportableKeypairs
        .map((kp) => `<option value="${kp.tag}">${kp.tag}</option>`)
        .join("");
  }
}

/**
 * Populate the backup key select with exportable keypairs
 */
function populateBackupKeySelect(entries: EntryInfo[]): void {
  const select = document.getElementById("backup-key-select") as HTMLSelectElement;
  if (!select) return;
  select.innerHTML = '<option value="">-- Select a key --</option>';
  for (const entry of entries) {
    if (entry.exportable) {
      const option = document.createElement("option");
      option.value = entry.tag;
      option.textContent = entry.tag;
      select.appendChild(option);
    }
  }
}

/**
 * Show a message in the seed phrase message area
 */
function showSeedMessage(text: string, type: "success" | "error"): void {
  const el = document.getElementById("seed-phrase-message");
  if (el) {
    el.textContent = text;
    el.className = `message ${type}`;
    el.classList.remove("hidden");
    setTimeout(() => el.classList.add("hidden"), 5000);
  }
}

/**
 * Create a new keypair
 */
async function createKeypair(): Promise<void> {
  const tag = getValue("new-tag");
  const exportable = isChecked("new-exportable");

  console.log("[Lair UI] Creating keypair:", { tag, exportable });

  setVisible("create-keypair-error", false);
  setVisible("create-keypair-success", false);

  if (!tag) {
    setText("create-keypair-error", "Tag is required");
    setVisible("create-keypair-error", true);
    return;
  }

  try {
    const response = await sendMessage(MessageType.LAIR_NEW_SEED, {
      tag,
      exportable,
    });

    console.log("[Lair UI] Create keypair response:", response);

    if (response.type === MessageType.ERROR) {
      setText("create-keypair-error", response.error || "Failed to create keypair");
      setVisible("create-keypair-error", true);
      return;
    }

    // Clear inputs and show success
    setValue("new-tag", "");
    setText("create-keypair-success", `Keypair "${tag}" created successfully`);
    setVisible("create-keypair-success", true);

    // Refresh list
    console.log("[Lair UI] Refreshing list after create...");
    await refreshKeypairList();

    // Hide success message after 3 seconds
    setTimeout(() => setVisible("create-keypair-success", false), 3000);
  } catch (error) {
    console.error("[Lair UI] Error creating keypair:", error);
    setText("create-keypair-error", String(error));
    setVisible("create-keypair-error", true);
  }
}

/**
 * Delete a keypair
 */
async function deleteKeypair(tag: string): Promise<void> {
  if (!confirm(`Are you sure you want to delete keypair "${tag}"? This cannot be undone.`)) {
    return;
  }

  try {
    const response = await sendMessage(MessageType.LAIR_DELETE_ENTRY, { tag });

    if (response.type === MessageType.ERROR) {
      alert(`Failed to delete: ${response.error}`);
      return;
    }

    await refreshKeypairList();
  } catch (error) {
    alert(`Error deleting keypair: ${error}`);
  }
}

// ============================================================================
// Sign/Verify Operations
// ============================================================================

/**
 * Sign data with selected keypair
 */
async function signData(): Promise<void> {
  const pubKeyBase64 = getValue("sign-keypair");
  const data = getValue("sign-data");

  setVisible("sign-error", false);
  setVisible("sign-result", false);

  if (!pubKeyBase64) {
    setText("sign-error", "Please select a keypair");
    setVisible("sign-error", true);
    return;
  }

  if (!data) {
    setText("sign-error", "Data is required");
    setVisible("sign-error", true);
    return;
  }

  try {
    const pubKey = fromBase64(pubKeyBase64);
    const dataBytes = textToBytes(data);

    const response = await sendMessage(MessageType.LAIR_SIGN, {
      pub_key: pubKey,
      data: dataBytes,
    });

    if (response.type === MessageType.ERROR) {
      setText("sign-error", response.error || "Failed to sign");
      setVisible("sign-error", true);
      return;
    }

    const signature = (response.payload as { signature: Uint8Array }).signature;
    const signatureBase64 = toBase64(signature);

    setText("sign-result", `Signature:\n${signatureBase64}`);
    setVisible("sign-result", true);
  } catch (error) {
    setText("sign-error", String(error));
    setVisible("sign-error", true);
  }
}

/**
 * Verify a signature
 */
async function verifySignature(): Promise<void> {
  const pubKeyBase64 = getValue("verify-pubkey");
  const data = getValue("verify-data");
  const signatureBase64 = getValue("verify-signature");

  setVisible("verify-error", false);
  setVisible("verify-result", false);

  if (!pubKeyBase64 || !data || !signatureBase64) {
    setText("verify-error", "All fields are required");
    setVisible("verify-error", true);
    return;
  }

  try {
    const pubKey = fromBase64(pubKeyBase64);
    const dataBytes = textToBytes(data);
    const signature = fromBase64(signatureBase64);

    const response = await sendMessage(MessageType.LAIR_VERIFY, {
      pub_key: pubKey,
      data: dataBytes,
      signature,
    });

    if (response.type === MessageType.ERROR) {
      setText("verify-error", response.error || "Failed to verify");
      setVisible("verify-error", true);
      return;
    }

    const valid = (response.payload as { valid: boolean }).valid;

    if (valid) {
      setText("verify-result", "✓ Signature is valid");
    } else {
      setText("verify-result", "✗ Signature is invalid");
    }
    setVisible("verify-result", true);
  } catch (error) {
    setText("verify-error", String(error));
    setVisible("verify-error", true);
  }
}

// ============================================================================
// Export/Import Operations
// ============================================================================

/**
 * Export a keypair
 */
async function exportKeypair(): Promise<void> {
  const tag = getValue("export-keypair");
  const passphrase = getValue("export-passphrase");

  setVisible("export-error", false);
  setVisible("export-result", false);

  if (!tag) {
    setText("export-error", "Please select a keypair");
    setVisible("export-error", true);
    return;
  }

  if (!passphrase || passphrase.length < 8) {
    setText("export-error", "Passphrase must be at least 8 characters");
    setVisible("export-error", true);
    return;
  }

  try {
    const response = await sendMessage(MessageType.LAIR_EXPORT_SEED, {
      tag,
      passphrase,
    });

    if (response.type === MessageType.ERROR) {
      setText("export-error", response.error || "Failed to export");
      setVisible("export-error", true);
      return;
    }

    const encrypted = (response.payload as { encrypted: EncryptedExport }).encrypted;

    // Convert Uint8Arrays to base64 for JSON serialization
    const exportData = {
      version: encrypted.version,
      tag: encrypted.tag,
      ed25519_pub_key: toBase64(encrypted.ed25519_pub_key),
      x25519_pub_key: toBase64(encrypted.x25519_pub_key),
      salt: toBase64(encrypted.salt),
      nonce: toBase64(encrypted.nonce),
      cipher: toBase64(encrypted.cipher),
      exportable: encrypted.exportable,
      created_at: encrypted.created_at,
    };

    const json = JSON.stringify(exportData, null, 2);

    setText("export-result", json);
    setVisible("export-result", true);

    // Clear passphrase
    setValue("export-passphrase", "");
  } catch (error) {
    setText("export-error", String(error));
    setVisible("export-error", true);
  }
}

/**
 * Import a keypair
 */
async function importKeypair(): Promise<void> {
  const importData = getValue("import-data");
  const passphrase = getValue("import-passphrase");
  const newTag = getValue("import-tag");
  const exportable = isChecked("import-exportable");

  setVisible("import-error", false);
  setVisible("import-success", false);

  if (!importData || !passphrase || !newTag) {
    setText("import-error", "All fields are required");
    setVisible("import-error", true);
    return;
  }

  try {
    // Parse JSON and convert base64 back to Uint8Arrays
    const parsed = JSON.parse(importData);
    const encrypted: EncryptedExport = {
      version: parsed.version,
      tag: parsed.tag,
      ed25519_pub_key: fromBase64(parsed.ed25519_pub_key),
      x25519_pub_key: fromBase64(parsed.x25519_pub_key),
      salt: fromBase64(parsed.salt),
      nonce: fromBase64(parsed.nonce),
      cipher: fromBase64(parsed.cipher),
      exportable: parsed.exportable,
      created_at: parsed.created_at,
    };

    const response = await sendMessage(MessageType.LAIR_IMPORT_SEED, {
      encrypted,
      passphrase,
      tag: newTag,
      exportable,
    });

    if (response.type === MessageType.ERROR) {
      setText("import-error", response.error || "Failed to import");
      setVisible("import-error", true);
      return;
    }

    // Clear inputs and show success
    setValue("import-data", "");
    setValue("import-passphrase", "");
    setValue("import-tag", "");
    setText("import-success", `Keypair imported as "${newTag}" successfully`);
    setVisible("import-success", true);

    // Refresh list
    await refreshKeypairList();

    // Hide success message after 3 seconds
    setTimeout(() => setVisible("import-success", false), 3000);
  } catch (error) {
    setText("import-error", String(error));
    setVisible("import-error", true);
  }
}

// ============================================================================
// Event Handlers
// ============================================================================

document.addEventListener("DOMContentLoaded", async () => {
  // Lock/Unlock handlers
  document.getElementById("set-passphrase-btn")?.addEventListener("click", setPassphrase);
  document.getElementById("unlock-btn")?.addEventListener("click", unlock);
  document.getElementById("lock-btn")?.addEventListener("click", lock);

  // Keypair management handlers
  document.getElementById("create-keypair-btn")?.addEventListener("click", createKeypair);

  // Sign/Verify handlers
  document.getElementById("sign-btn")?.addEventListener("click", signData);
  document.getElementById("verify-btn")?.addEventListener("click", verifySignature);

  // Export/Import handlers
  document.getElementById("export-btn")?.addEventListener("click", exportKeypair);
  document.getElementById("import-btn")?.addEventListener("click", importKeypair);

  // Seed phrase backup handler
  document.getElementById("show-seed-phrase-btn")?.addEventListener("click", async () => {
    const select = document.getElementById("backup-key-select") as HTMLSelectElement;
    const tag = select?.value;
    if (!tag) {
      showSeedMessage("Select a key first", "error");
      return;
    }

    try {
      const message = createRequest(MessageType.LAIR_EXPORT_MNEMONIC, { tag });
      const response: ResponseMessage = await chrome.runtime.sendMessage(message);
      if (response.type === MessageType.ERROR) {
        showSeedMessage((response.payload as { error?: string })?.error || "Export failed", "error");
        return;
      }

      const mnemonic = (response.payload as { mnemonic?: string })?.mnemonic || response.payload;
      if (typeof mnemonic !== "string") {
        showSeedMessage("Unexpected response format", "error");
        return;
      }

      const words = mnemonic.split(" ");
      const grid = document.getElementById("seed-phrase-words");
      if (grid) {
        grid.innerHTML = words
          .map(
            (word: string, i: number) =>
              `<div class="word"><span class="word-num">${i + 1}.</span>${word}</div>`
          )
          .join("");
      }

      const display = document.getElementById("seed-phrase-display");
      if (display) display.classList.remove("hidden");
    } catch (err) {
      showSeedMessage(`Error: ${err}`, "error");
    }
  });

  // Copy seed phrase to clipboard handler
  document.getElementById("copy-seed-phrase-btn")?.addEventListener("click", () => {
    const grid = document.getElementById("seed-phrase-words");
    if (!grid) return;
    const words = Array.from(grid.querySelectorAll(".word")).map((el) => {
      // Strip the number prefix (e.g. "1.")
      return el.textContent?.replace(/^\d+\./, "").trim() || "";
    });
    navigator.clipboard.writeText(words.join(" ")).then(() => {
      showSeedMessage("Copied to clipboard", "success");
      // Auto-hide display after 3 seconds
      setTimeout(() => {
        const display = document.getElementById("seed-phrase-display");
        if (display) display.classList.add("hidden");
      }, 3000);
    });
  });

  // Restore key from seed phrase handler
  document.getElementById("restore-seed-btn")?.addEventListener("click", async () => {
    const tagInput = document.getElementById("restore-tag") as HTMLInputElement;
    const mnemonicInput = document.getElementById("restore-mnemonic") as HTMLTextAreaElement;

    const tag = tagInput?.value?.trim();
    const mnemonic = mnemonicInput?.value?.trim();

    if (!tag) {
      showSeedMessage("Enter a tag for the restored key", "error");
      return;
    }
    if (!mnemonic) {
      showSeedMessage("Enter the 24-word seed phrase", "error");
      return;
    }

    const words = mnemonic.split(/\s+/);
    if (words.length !== 24) {
      showSeedMessage(`Expected 24 words, got ${words.length}`, "error");
      return;
    }

    try {
      const message = createRequest(MessageType.LAIR_IMPORT_MNEMONIC, {
        mnemonic: words.join(" "),
        tag,
        exportable: true,
      });
      const response: ResponseMessage = await chrome.runtime.sendMessage(message);
      if (response.type === MessageType.ERROR) {
        showSeedMessage((response.payload as { error?: string })?.error || "Import failed", "error");
        return;
      }

      showSeedMessage("Key restored successfully", "success");
      tagInput.value = "";
      mnemonicInput.value = "";
      // Refresh keypair list
      await refreshKeypairList();
    } catch (err) {
      showSeedMessage(`Error: ${err}`, "error");
    }
  });

  // Initial state update
  await updateLockState();
});
