/**
 * Keystore management popup UI
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
import type { EntryInfo, EncryptedExport } from "@holo-host/lair";
import { toUint8Array, showConfirm } from "./utils";
import {
  dhtLocationFrom32,
  HASH_TYPE_PREFIX,
  HoloHashType,
} from "@holochain/client";
import renderIdenticon from "@holo-host/identicon";
import { MIN_PASSPHRASE_LENGTH } from "@hwc/shared";

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
 * Compute 39-byte AgentPubKey from 32-byte Ed25519 public key.
 * Format: [132, 32, 36] prefix + 32-byte key + 4-byte DHT location
 */
function agentPubKeyFromEd25519(ed25519: Uint8Array): Uint8Array {
  const key = new Uint8Array(39);
  key.set(HASH_TYPE_PREFIX[HoloHashType.Agent], 0);
  key.set(ed25519, 3);
  key.set(dhtLocationFrom32(ed25519), 35);
  return key;
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
 * Convert hex string to Uint8Array
 */
function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '');
  if (clean.length % 2 !== 0) {
    throw new Error('Hex string must have even length');
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Parse data input according to the selected format
 */
function parseDataInput(data: string, format: string): Uint8Array {
  switch (format) {
    case 'base64':
      return fromBase64(data);
    case 'hex':
      return fromHex(data);
    case 'text':
    default:
      return textToBytes(data);
  }
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
        lockStatusTextEl.textContent = "\u{1f512} Locked";
      } else {
        lockStatusEl.className = "lock-status unlocked";
        lockStatusTextEl.textContent = "\u{1f513} Unlocked";
      }
    }

    // Show appropriate lock/unlock sections
    if (!hasPassphrase) {
      setVisible("passphrase-setup", true);
      setVisible("unlock-section", false);
      setVisible("lock-section", false);
    } else if (isLocked) {
      setVisible("passphrase-setup", false);
      setVisible("unlock-section", true);
      setVisible("lock-section", false);
    } else {
      setVisible("passphrase-setup", false);
      setVisible("unlock-section", false);
      setVisible("lock-section", true);
    }

    // Enable/disable other sections based on lock state
    const sections = ["keypair-section", "create-section", "sign-verify-section"];
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

  if (!passphrase || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    setText("set-passphrase-error", `Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
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

    setValue("new-passphrase", "");
    await updateLockState();
  } catch (error) {
    setText("set-passphrase-error", String(error));
    setVisible("set-passphrase-error", true);
  }
}

/**
 * Change passphrase (requires current passphrase)
 */
async function changePassphrase(): Promise<void> {
  const submitBtn = document.getElementById("change-passphrase-submit-btn") as HTMLButtonElement | null;
  const oldPassphrase = getValue("current-passphrase");
  const newPassphrase = getValue("change-new-passphrase");
  setVisible("change-passphrase-error", false);

  if (!oldPassphrase) {
    setText("change-passphrase-error", "Current passphrase is required");
    setVisible("change-passphrase-error", true);
    return;
  }

  if (!newPassphrase || newPassphrase.length < MIN_PASSPHRASE_LENGTH) {
    setText("change-passphrase-error", `New passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
    setVisible("change-passphrase-error", true);
    return;
  }

  if (submitBtn) submitBtn.disabled = true;
  try {
    const response = await sendMessage(MessageType.LAIR_SET_PASSPHRASE, {
      passphrase: newPassphrase,
      oldPassphrase,
    });

    if (response.type === MessageType.ERROR) {
      setText("change-passphrase-error", response.error || "Failed to change passphrase");
      setVisible("change-passphrase-error", true);
      return;
    }

    setValue("current-passphrase", "");
    setValue("change-new-passphrase", "");
    setVisible("change-passphrase-form", false);
    await updateLockState();
  } catch (error) {
    setText("change-passphrase-error", String(error));
    setVisible("change-passphrase-error", true);
  } finally {
    if (submitBtn) submitBtn.disabled = false;
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
    const response = await sendMessage(MessageType.LAIR_LIST_ENTRIES);

    if (response.type === MessageType.ERROR) {
      console.error("Failed to list entries:", response.error);
      return;
    }

    keypairs = (response.payload as { entries: EntryInfo[] }).entries;
    renderKeypairList();
    updateKeypairSelects();
  } catch (error) {
    console.error("Error refreshing keypair list:", error);
  }
}

/**
 * Render the keypair list as a table with inline actions
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
        <th>Key</th>
        <th>Created</th>
        <th>Exportable</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody>
      ${keypairs
        .map(
          (kp) => {
            const ed25519Bytes = kp.ed25519_pub_key instanceof Uint8Array
              ? kp.ed25519_pub_key
              : new Uint8Array(Object.values(kp.ed25519_pub_key) as number[]);
            const agentPubKey = agentPubKeyFromEd25519(ed25519Bytes);
            const agentPubKeyB64 = toBase64(agentPubKey);
            const ed25519B64 = toBase64(kp.ed25519_pub_key);
            const exportActions = kp.exportable
              ? `<button class="small export-btn" data-tag="${kp.tag}">Export</button>
                 <button class="small secondary seed-btn" data-tag="${kp.tag}">Seed Words</button>`
              : '';
            return `
        <tr>
          <td><strong>${kp.tag}</strong></td>
          <td class="pubkey"
              data-agent-pubkey="${agentPubKeyB64}"
              data-ed25519="${ed25519B64}"
              title="${agentPubKeyB64}\nClick to copy"
              style="cursor: pointer;">
            <canvas class="identicon-canvas" data-hash="${ed25519B64}" width="28" height="28"
                    style="border-radius: 4px;"></canvas>
          </td>
          <td>${new Date(kp.created_at).toLocaleString()}</td>
          <td>
            <span class="badge ${kp.exportable ? "exportable" : "non-exportable"}">
              ${kp.exportable ? "Yes" : "No"}
            </span>
          </td>
          <td>
            <div class="action-buttons">
              ${exportActions}
              <button class="small danger delete-btn" data-tag="${kp.tag}">Delete</button>
            </div>
          </td>
        </tr>
      `;
          }
        )
        .join("")}
    </tbody>
  `;

  listEl.innerHTML = "";
  const scrollWrap = document.createElement("div");
  scrollWrap.className = "table-scroll";
  scrollWrap.appendChild(table);
  listEl.appendChild(scrollWrap);

  // Render identicons on canvas elements
  table.querySelectorAll('.identicon-canvas').forEach((canvas) => {
    const hashB64 = (canvas as HTMLCanvasElement).dataset.hash;
    if (hashB64) {
      try {
        const hashBytes = fromBase64(hashB64);
        renderIdenticon({ hash: hashBytes, size: 24 }, canvas as HTMLCanvasElement);
      } catch (e) {
        console.warn('Failed to render identicon:', e);
      }
    }
  });

  // Add click handlers to public key cells
  table.querySelectorAll('.pubkey').forEach((cell) => {
    cell.addEventListener('click', async () => {
      const el = cell as HTMLElement;
      const agentPubKey = el.dataset.agentPubkey;
      if (agentPubKey) {
        try {
          await navigator.clipboard.writeText(agentPubKey);
          el.style.outline = '2px solid #10b981';
          setTimeout(() => { el.style.outline = ''; }, 800);
        } catch (error) {
          console.error('Failed to copy:', error);
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

  // Add click handlers to export buttons
  table.querySelectorAll('.export-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const tag = (button as HTMLElement).dataset.tag;
      if (tag) {
        openExportModal(tag);
      }
    });
  });

  // Add click handlers to seed words buttons (shows warning first)
  table.querySelectorAll('.seed-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const tag = (button as HTMLElement).dataset.tag;
      if (tag) {
        showSeedWarning(tag);
      }
    });
  });
}

/**
 * Update keypair select dropdowns
 */
function updateKeypairSelects(): void {
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
}

/**
 * Delete a keypair
 */
async function deleteKeypair(tag: string): Promise<void> {
  if (!(await showConfirm(`Are you sure you want to delete keypair "${tag}"? This cannot be undone.`, { variant: "danger" }))) {
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
// Export Modal
// ============================================================================

let exportModalTag = "";

function openExportModal(tag: string): void {
  exportModalTag = tag;
  setText("export-modal-tag", tag);
  setValue("export-passphrase", "");
  setValue("export-passphrase-confirm", "");
  setVisible("export-modal-error", false);
  document.getElementById("export-modal")?.classList.add("active");
}

function closeExportModal(): void {
  exportModalTag = "";
  document.getElementById("export-modal")?.classList.remove("active");
}

/** Packed binary format: salt (16) + nonce (24) + ed25519_pub_key (32) + cipher (rest) */
const EXPORT_SALT_LEN = 16;
const EXPORT_NONCE_LEN = 24;
const EXPORT_PUBKEY_LEN = 32;
const EXPORT_HEADER_LEN = EXPORT_SALT_LEN + EXPORT_NONCE_LEN + EXPORT_PUBKEY_LEN; // 72

let exportResultShort = "";
let exportResultJson = "";

function packExportShort(encrypted: EncryptedExport): string {
  const salt = toUint8Array(encrypted.salt);
  const nonce = toUint8Array(encrypted.nonce);
  const pubkey = toUint8Array(encrypted.ed25519_pub_key);
  const cipher = toUint8Array(encrypted.cipher);
  const packed = new Uint8Array(EXPORT_HEADER_LEN + cipher.length);
  packed.set(salt, 0);
  packed.set(nonce, EXPORT_SALT_LEN);
  packed.set(pubkey, EXPORT_SALT_LEN + EXPORT_NONCE_LEN);
  packed.set(cipher, EXPORT_HEADER_LEN);
  return toBase64(packed);
}

function unpackExportShort(base64: string): { salt: Uint8Array; nonce: Uint8Array; ed25519_pub_key: Uint8Array; cipher: Uint8Array } {
  const packed = fromBase64(base64);
  if (packed.length <= EXPORT_HEADER_LEN) {
    throw new Error("Export data too short");
  }
  return {
    salt: packed.slice(0, EXPORT_SALT_LEN),
    nonce: packed.slice(EXPORT_SALT_LEN, EXPORT_SALT_LEN + EXPORT_NONCE_LEN),
    ed25519_pub_key: packed.slice(EXPORT_SALT_LEN + EXPORT_NONCE_LEN, EXPORT_HEADER_LEN),
    cipher: packed.slice(EXPORT_HEADER_LEN),
  };
}

function updateExportResultDisplay(): void {
  const format = getValue("export-format");
  setText("export-result-data", format === "json" ? exportResultJson : exportResultShort);
}

function openExportResultModal(tag: string, shortData: string, jsonData: string): void {
  exportResultShort = shortData;
  exportResultJson = jsonData;
  setText("export-result-tag", tag);
  // Reset to default (short)
  const formatSelect = document.getElementById("export-format") as HTMLSelectElement;
  if (formatSelect) formatSelect.value = "short";
  updateExportResultDisplay();
  document.getElementById("export-result-modal")?.classList.add("active");
}

function closeExportResultModal(): void {
  exportResultShort = "";
  exportResultJson = "";
  document.getElementById("export-result-modal")?.classList.remove("active");
}

async function submitExport(): Promise<void> {
  const passphrase = getValue("export-passphrase");
  const confirmPass = getValue("export-passphrase-confirm");

  setVisible("export-modal-error", false);

  if (!passphrase || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    setText("export-modal-error", `Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
    setVisible("export-modal-error", true);
    return;
  }

  if (passphrase !== confirmPass) {
    setText("export-modal-error", "Passphrases do not match");
    setVisible("export-modal-error", true);
    return;
  }

  try {
    const response = await sendMessage(MessageType.LAIR_EXPORT_SEED, {
      tag: exportModalTag,
      passphrase,
    });

    if (response.type === MessageType.ERROR) {
      setText("export-modal-error", response.error || "Failed to export");
      setVisible("export-modal-error", true);
      return;
    }

    const encrypted = (response.payload as { encrypted: EncryptedExport }).encrypted;

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
    const short = packExportShort(encrypted);

    // Close passphrase modal and open result modal
    closeExportModal();
    openExportResultModal(exportModalTag, short, json);
  } catch (error) {
    setText("export-modal-error", String(error));
    setVisible("export-modal-error", true);
  }
}

// ============================================================================
// Seed Words Modal (with warning gate)
// ============================================================================

let pendingSeedTag = "";

function showSeedWarning(tag: string): void {
  pendingSeedTag = tag;
  document.getElementById("seed-warning-modal")?.classList.add("active");
}

function closeSeedWarning(): void {
  pendingSeedTag = "";
  document.getElementById("seed-warning-modal")?.classList.remove("active");
}

async function openSeedModal(tag: string): Promise<void> {
  setText("seed-modal-tag", tag);
  setVisible("seed-modal-error", false);
  const wordsEl = document.getElementById("seed-modal-words");
  if (wordsEl) wordsEl.innerHTML = "";
  document.getElementById("seed-modal")?.classList.add("active");

  try {
    const message = createRequest(MessageType.LAIR_EXPORT_MNEMONIC, { tag });
    const response: ResponseMessage = await chrome.runtime.sendMessage(message);

    if (response.type === MessageType.ERROR) {
      setText("seed-modal-error", (response.payload as { error?: string })?.error || "Export failed");
      setVisible("seed-modal-error", true);
      return;
    }

    const mnemonic = (response.payload as { mnemonic?: string })?.mnemonic || response.payload;
    if (typeof mnemonic !== "string") {
      setText("seed-modal-error", "Unexpected response format");
      setVisible("seed-modal-error", true);
      return;
    }

    const words = mnemonic.split(" ");
    if (wordsEl) {
      wordsEl.innerHTML = words
        .map(
          (word: string, i: number) =>
            `<div class="word"><span class="word-num">${i + 1}.</span>${word}</div>`
        )
        .join("");
    }
  } catch (err) {
    setText("seed-modal-error", `Error: ${err}`);
    setVisible("seed-modal-error", true);
  }
}

function closeSeedModal(): void {
  document.getElementById("seed-modal")?.classList.remove("active");
  const wordsEl = document.getElementById("seed-modal-words");
  if (wordsEl) wordsEl.innerHTML = "";
}

// ============================================================================
// Create / Import
// ============================================================================

function updateCreateMode(): void {
  const mode = getValue("create-mode");
  setVisible("import-export-fields", mode === "import-export");
  setVisible("import-seed-fields", mode === "import-seed");

  const btn = document.getElementById("create-btn");
  if (btn) {
    switch (mode) {
      case "new":
        btn.textContent = "Create";
        break;
      case "import-export":
        btn.textContent = "Import";
        break;
      case "import-seed":
        btn.textContent = "Restore";
        break;
    }
  }
}

async function handleCreate(): Promise<void> {
  const mode = getValue("create-mode");
  const tag = getValue("create-tag");
  const exportable = isChecked("create-exportable");

  setVisible("create-error", false);
  setVisible("create-success", false);

  if (!tag) {
    setText("create-error", "Tag is required");
    setVisible("create-error", true);
    return;
  }

  try {
    let response: ResponseMessage;

    switch (mode) {
      case "new": {
        response = await sendMessage(MessageType.LAIR_NEW_SEED, { tag, exportable });
        break;
      }
      case "import-export": {
        const importData = getValue("import-data").trim();
        const passphrase = getValue("import-passphrase");

        if (!importData || !passphrase) {
          setText("create-error", "Export data and passphrase are required");
          setVisible("create-error", true);
          return;
        }

        let encrypted: EncryptedExport;
        if (importData.startsWith("{")) {
          // Full JSON format
          const parsed = JSON.parse(importData);
          encrypted = {
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
        } else {
          // Short base64 format — unpack and fill in defaults for unused fields
          const unpacked = unpackExportShort(importData);
          encrypted = {
            version: 1,
            tag: "",
            ed25519_pub_key: unpacked.ed25519_pub_key,
            x25519_pub_key: new Uint8Array(0),
            salt: unpacked.salt,
            nonce: unpacked.nonce,
            cipher: unpacked.cipher,
            exportable: true,
            created_at: 0,
          };
        }

        response = await sendMessage(MessageType.LAIR_IMPORT_SEED, {
          encrypted,
          passphrase,
          tag,
          exportable,
        });
        break;
      }
      case "import-seed": {
        const mnemonic = getValue("import-mnemonic").trim();

        if (!mnemonic) {
          setText("create-error", "Seed words are required");
          setVisible("create-error", true);
          return;
        }

        const words = mnemonic.split(/\s+/);
        if (words.length !== 24) {
          setText("create-error", `Expected 24 words, got ${words.length}`);
          setVisible("create-error", true);
          return;
        }

        const message = createRequest(MessageType.LAIR_IMPORT_MNEMONIC, {
          mnemonic: words.join(" "),
          tag,
          exportable,
        });
        response = await chrome.runtime.sendMessage(message);
        break;
      }
      default:
        return;
    }

    if (response.type === MessageType.ERROR) {
      setText("create-error", response.error || "Operation failed");
      setVisible("create-error", true);
      return;
    }

    // Clear inputs and show success
    setValue("create-tag", "");
    setValue("import-data", "");
    setValue("import-passphrase", "");
    setValue("import-mnemonic", "");
    const actionWord = mode === "new" ? "created" : "imported";
    setText("create-success", `Keypair "${tag}" ${actionWord} successfully`);
    setVisible("create-success", true);

    await refreshKeypairList();

    setTimeout(() => setVisible("create-success", false), 3000);
  } catch (error) {
    setText("create-error", String(error));
    setVisible("create-error", true);
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
  const dataFormat = getValue("sign-data-format");

  setVisible("sign-error", false);
  setVisible("sign-result-wrapper", false);

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
    const dataBytes = parseDataInput(data, dataFormat);

    const response = await sendMessage(MessageType.LAIR_SIGN, {
      pubKey,
      data: dataBytes,
    });

    if (response.type === MessageType.ERROR) {
      setText("sign-error", response.error || "Failed to sign");
      setVisible("sign-error", true);
      return;
    }

    const signature = (response.payload as { signature: Uint8Array }).signature;
    const signatureBase64 = toBase64(signature);

    setText("sign-result", signatureBase64);
    setVisible("sign-result-wrapper", true);
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
  const dataFormat = getValue("verify-data-format");

  setVisible("verify-error", false);
  setVisible("verify-result", false);

  if (!pubKeyBase64 || !data || !signatureBase64) {
    setText("verify-error", "All fields are required");
    setVisible("verify-error", true);
    return;
  }

  try {
    let pubKey = fromBase64(pubKeyBase64);
    // Accept 39-byte AgentPubKey: extract the 32-byte Ed25519 key from bytes 3..35
    if (pubKey.length === 39 && pubKey[0] === 132 && pubKey[1] === 32 && pubKey[2] === 36) {
      pubKey = pubKey.slice(3, 35);
    }
    const dataBytes = parseDataInput(data, dataFormat);
    const signature = fromBase64(signatureBase64);

    const response = await sendMessage(MessageType.LAIR_VERIFY, {
      pubKey,
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
      setText("verify-result", "\u2713 Signature is valid");
    } else {
      setText("verify-result", "\u2717 Signature is invalid");
    }
    setVisible("verify-result", true);
  } catch (error) {
    setText("verify-error", String(error));
    setVisible("verify-error", true);
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

  // Change passphrase handlers
  document.getElementById("change-passphrase-btn")?.addEventListener("click", () => {
    setVisible("change-passphrase-form", true);
    setVisible("change-passphrase-error", false);
  });
  document.getElementById("change-passphrase-cancel-btn")?.addEventListener("click", () => {
    setVisible("change-passphrase-form", false);
    setValue("current-passphrase", "");
    setValue("change-new-passphrase", "");
  });
  document.getElementById("change-passphrase-submit-btn")?.addEventListener("click", changePassphrase);

  // Create/Import handlers
  document.getElementById("create-mode")?.addEventListener("change", updateCreateMode);
  document.getElementById("create-btn")?.addEventListener("click", handleCreate);

  // Sign/Verify handlers
  document.getElementById("sign-btn")?.addEventListener("click", signData);
  document.getElementById("verify-btn")?.addEventListener("click", verifySignature);

  // Copy signature to clipboard
  document.getElementById("sign-copy-btn")?.addEventListener("click", async () => {
    const text = document.getElementById("sign-result")?.textContent || "";
    const btn = document.getElementById("sign-copy-btn") as HTMLButtonElement;
    try {
      await navigator.clipboard.writeText(text);
      const original = btn.textContent;
      btn.textContent = "\u2713 Copied";
      setTimeout(() => { btn.textContent = original; }, 1500);
    } catch (e) {
      console.error("Failed to copy:", e);
    }
  });

  // Export modal handlers
  document.getElementById("export-modal-submit")?.addEventListener("click", submitExport);
  document.getElementById("export-modal-cancel")?.addEventListener("click", closeExportModal);
  document.getElementById("export-modal")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("export-modal")) closeExportModal();
  });

  // Export result modal handlers
  document.getElementById("export-format")?.addEventListener("change", updateExportResultDisplay);
  document.getElementById("export-result-copy")?.addEventListener("click", async () => {
    const text = document.getElementById("export-result-data")?.textContent || "";
    const btn = document.getElementById("export-result-copy") as HTMLButtonElement;
    try {
      await navigator.clipboard.writeText(text);
      const original = btn.textContent;
      btn.textContent = "\u2713 Copied";
      setTimeout(() => { btn.textContent = original; }, 1500);
    } catch (e) {
      console.error("Failed to copy:", e);
    }
  });
  document.getElementById("export-result-close")?.addEventListener("click", closeExportResultModal);
  document.getElementById("export-result-modal")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("export-result-modal")) closeExportResultModal();
  });

  // Seed warning modal handlers
  document.getElementById("seed-warning-cancel")?.addEventListener("click", closeSeedWarning);
  document.getElementById("seed-warning-continue")?.addEventListener("click", async () => {
    const tag = pendingSeedTag;
    closeSeedWarning();
    if (tag) {
      await openSeedModal(tag);
    }
  });
  document.getElementById("seed-warning-modal")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("seed-warning-modal")) closeSeedWarning();
  });

  // Seed modal handlers
  document.getElementById("seed-modal-close")?.addEventListener("click", closeSeedModal);
  document.getElementById("seed-modal")?.addEventListener("click", (e) => {
    if (e.target === document.getElementById("seed-modal")) closeSeedModal();
  });

  // Initial state update
  await updateLockState();
});
