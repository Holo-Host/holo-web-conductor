/**
 * Background service worker for Fishy extension
 *
 * This is the main entry point for the extension's background process.
 * It handles:
 * - Message routing from content scripts
 * - Lair keystore operations
 * - Conductor operations
 * - Authorization management
 */

import {
  type Message,
  type RequestMessage,
  type ResponseMessage,
  MessageType,
  createSuccessResponse,
  createErrorResponse,
  isRequestMessage,
  deserializeMessage,
  serializeMessage,
  type ZomeCallPayload,
} from "../lib/messaging";
import { getLairLock } from "../lib/lair-lock";
import { getPermissionManager } from "../lib/permissions";
import { getAuthManager } from "../lib/auth-manager";
import { getHappContextManager } from "../lib/happ-context-manager";
import { createLairClient, type EncryptedExport } from "@fishy/lair";
import type { InstallHappRequest } from "@fishy/core";
import type { ZomeCallRequest } from "@fishy/core/ribosome";
import { encode, decode } from "@msgpack/msgpack";
import sodium from "libsodium-wrappers";

console.log("Fishy background service worker loaded");

// ============================================================================
// Offscreen Document Management
// ============================================================================

const OFFSCREEN_DOCUMENT_PATH = "offscreen/offscreen.html";
let creatingOffscreen: Promise<void> | null = null;
let networkConfigured = false;

// Gateway configuration - can be set via popup settings or environment
// Default to null (no network) until configured
let gatewayConfig: { gatewayUrl: string; sessionToken?: string } | null = null;

/**
 * Check if the offscreen document exists
 */
async function hasOffscreenDocument(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
  });
  return contexts.length > 0;
}

/**
 * Create the offscreen document if it doesn't exist
 */
async function ensureOffscreenDocument(): Promise<void> {
  if (await hasOffscreenDocument()) {
    return;
  }

  // Avoid creating multiple offscreen documents
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  console.log("[Background] Creating offscreen document...");
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: [chrome.offscreen.Reason.WORKERS],
    justification: "Running WASM with synchronous network access for zome calls",
  });

  await creatingOffscreen;
  creatingOffscreen = null;
  console.log("[Background] Offscreen document created");

  // Configure network if we have a gateway URL
  if (gatewayConfig && !networkConfigured) {
    await configureOffscreenNetwork(gatewayConfig);
  }
}

/**
 * Configure the network service in the offscreen document
 */
async function configureOffscreenNetwork(config: { gatewayUrl: string; sessionToken?: string }): Promise<void> {
  console.log(`[Background] Configuring offscreen network with gateway: ${config.gatewayUrl}`);

  try {
    await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "CONFIGURE_NETWORK",
      gatewayUrl: config.gatewayUrl,
      sessionToken: config.sessionToken,
    });
    networkConfigured = true;
    console.log("[Background] Offscreen network configured");
  } catch (error) {
    console.error("[Background] Failed to configure offscreen network:", error);
  }
}

/**
 * Set the gateway configuration
 * Call this to enable network requests via hc-http-gw
 */
function setGatewayConfig(url: string, sessionToken?: string): void {
  gatewayConfig = { gatewayUrl: url, sessionToken };
  networkConfigured = false; // Will be configured on next offscreen use

  console.log(`[Background] Gateway config set: ${url}`);
}

/**
 * Update the session token for the gateway
 */
async function updateGatewaySessionToken(token: string | null): Promise<void> {
  if (gatewayConfig) {
    gatewayConfig.sessionToken = token || undefined;
  }

  // If offscreen is running, update it too
  if (networkConfigured) {
    try {
      await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "UPDATE_SESSION_TOKEN",
        sessionToken: token,
      });
      console.log("[Background] Session token updated in offscreen");
    } catch (error) {
      console.error("[Background] Failed to update session token:", error);
    }
  }
}

/**
 * Minimal zome call request - only includes data needed by offscreen
 * WASM and manifest are fetched from shared IndexedDB by the offscreen document
 */
interface MinimalZomeCallRequest {
  contextId: string;
  dnaHashBase64: string;
  cellId: [number[], number[]]; // [dnaHash, agentPubKey] as arrays
  zome: string;
  fn: string;
  payload: number[];
  provenance: number[];
}

/**
 * Execute a zome call via the offscreen document
 * The offscreen document can make synchronous XHR calls that host functions need
 *
 * IMPORTANT: We only send minimal data through message passing.
 * The offscreen document fetches WASM and manifest from shared IndexedDB.
 */
async function executeZomeCallViaOffscreen(
  contextId: string,
  zomeCallRequest: ZomeCallRequest
): Promise<{ result: unknown; signals: any[] }> {
  await ensureOffscreenDocument();

  const requestId = crypto.randomUUID();
  const dnaHashBase64 = btoa(String.fromCharCode(...zomeCallRequest.cellId[0]));

  // Build minimal request - no WASM or manifest, just references
  const minimalRequest: MinimalZomeCallRequest = {
    contextId,
    dnaHashBase64,
    cellId: [
      Array.from(zomeCallRequest.cellId[0]),
      Array.from(zomeCallRequest.cellId[1]),
    ],
    zome: zomeCallRequest.zome,
    fn: zomeCallRequest.fn,
    payload: Array.from(zomeCallRequest.payload),
    provenance: Array.from(zomeCallRequest.provenance),
  };

  console.log(`[Background] Sending zome call to offscreen: ${zomeCallRequest.zome}::${zomeCallRequest.fn} (context: ${contextId})`);

  const response = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "EXECUTE_ZOME_CALL",
    requestId,
    zomeCallRequest: minimalRequest,
  });

  if (!response.success) {
    throw new Error(response.error || "Offscreen zome call failed");
  }

  return {
    result: response.result,
    signals: response.signals || [],
  };
}

// Singleton instances
const lairLock = getLairLock();
const permissionManager = getPermissionManager();
const authManager = getAuthManager();
const happContextManager = getHappContextManager();
let lairClient: Awaited<ReturnType<typeof createLairClient>> | null = null;

// Initialize Lair client
async function getLairClient() {
  if (!lairClient) {
    lairClient = await createLairClient();
  }
  return lairClient;
}

/**
 * Convert serialized Uint8Array back to actual Uint8Array
 * Chrome message passing serializes Uint8Arrays to plain objects
 */
function toUint8Array(data: any): Uint8Array {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (Array.isArray(data)) {
    return new Uint8Array(data);
  }
  if (typeof data === 'object' && data !== null) {
    // Serialized Uint8Array comes as object with numeric keys
    return new Uint8Array(Object.values(data) as number[]);
  }
  throw new Error('Cannot convert to Uint8Array');
}

/**
 * Recursively normalize Uint8Arrays in nested data structures
 * Chrome's message passing converts Uint8Arrays to objects with numeric keys
 */
function normalizeUint8Arrays(data: any): any {
  if (data === null || data === undefined) {
    return data;
  }

  // Check if this looks like a serialized Uint8Array
  // (object with consecutive numeric keys starting from 0)
  if (typeof data === 'object' && !Array.isArray(data) && !(data instanceof Uint8Array)) {
    const keys = Object.keys(data);
    const isUint8ArrayLike = keys.length > 0 &&
      keys.every((k, i) => k === String(i)) &&
      keys.every(k => typeof data[k] === 'number');

    if (isUint8ArrayLike) {
      return new Uint8Array(Object.values(data) as number[]);
    }

    // Otherwise recurse into object properties
    const normalized: any = {};
    for (const [key, value] of Object.entries(data)) {
      normalized[key] = normalizeUint8Arrays(value);
    }
    return normalized;
  }

  // Recurse into arrays
  if (Array.isArray(data)) {
    return data.map(normalizeUint8Arrays);
  }

  // Primitives and Uint8Array instances pass through
  return data;
}

/**
 * Convert Uint8Arrays to regular Arrays for Chrome message passing
 *
 * Chrome's structured cloning algorithm converts Uint8Arrays to plain objects
 * with numeric keys (e.g., {0: 1, 1: 2, ...}). By explicitly converting to
 * Arrays, we preserve the data in a cleaner format that the UI can easily
 * work with.
 *
 * The UI layer will convert Arrays back to Uint8Arrays before formatting
 * for display (e.g., base64 encoding for hashes).
 */
function serializeForTransport(data: any): any {
  if (data === null || data === undefined) {
    return data;
  }

  // Convert Uint8Array to regular Array
  if (data instanceof Uint8Array) {
    return Array.from(data);
  }

  // Recurse into arrays
  if (Array.isArray(data)) {
    return data.map(serializeForTransport);
  }

  // Recurse into objects
  if (typeof data === 'object') {
    const serialized: any = {};
    for (const [key, value] of Object.entries(data)) {
      serialized[key] = serializeForTransport(value);
    }
    return serialized;
  }

  // Primitives pass through
  return data;
}

/**
 * Helper to decode and log MessagePack bytes for debugging
 * Converts Uint8Array to decoded object with hashes as base64 and signatures as hex
 */
function decodeMsgPackForLogging(bytes: Uint8Array): any {
  try {
    const decoded = decode(bytes);

    // Convert Uint8Arrays to readable formats based on context
    const convertForDisplay = (obj: any, key?: string): any => {
      if (obj instanceof Uint8Array) {
        // Convert signatures (64 bytes) to hex
        if (obj.length === 64 && (key === 'signature' || key?.includes('signature'))) {
          return Array.from(obj).map(b => b.toString(16).padStart(2, '0')).join('');
        }
        // Convert hashes (39 bytes or other) to base64
        if (obj.length === 39 || key?.includes('hash') || key?.includes('Hash') ||
            key === 'author' || key?.includes('address') || key?.includes('Address')) {
          return btoa(String.fromCharCode(...obj));
        }
        // Other byte arrays to hex
        return Array.from(obj).map(b => b.toString(16).padStart(2, '0')).join('');
      }
      if (Array.isArray(obj)) {
        return obj.map((item, i) => convertForDisplay(item, String(i)));
      }
      if (obj && typeof obj === 'object') {
        const converted: any = {};
        for (const [k, value] of Object.entries(obj)) {
          converted[k] = convertForDisplay(value, k);
        }
        return converted;
      }
      return obj;
    };

    return convertForDisplay(decoded);
  } catch (error) {
    return {
      error: 'Failed to decode MessagePack',
      rawBytes: Array.from(bytes.slice(0, 100)), // First 100 bytes
    };
  }
}

/**
 * Handle incoming messages from content scripts
 */
async function handleMessage(
  message: RequestMessage,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMessage> {
  console.log("Processing message:", message.type, "from tab:", sender.tab?.id);

  try {
    switch (message.type) {
      case MessageType.CONNECT:
        return handleConnect(message, sender);

      case MessageType.DISCONNECT:
        return handleDisconnect(message, sender);

      case MessageType.CALL_ZOME:
        return handleCallZome(message, sender);

      case MessageType.APP_INFO:
        return handleAppInfo(message, sender);

      // hApp Context Management
      case MessageType.INSTALL_HAPP:
        return handleInstallHapp(message, sender);

      case MessageType.UNINSTALL_HAPP:
        return handleUninstallHapp(message, sender);

      case MessageType.LIST_HAPPS:
        return handleListHapps(message, sender);

      case MessageType.ENABLE_HAPP:
        return handleEnableHapp(message, sender);

      case MessageType.DISABLE_HAPP:
        return handleDisableHapp(message, sender);

      // Lair lock/unlock operations
      case MessageType.LAIR_GET_LOCK_STATE:
        return handleLairGetLockState(message);

      case MessageType.LAIR_SET_PASSPHRASE:
        return handleLairSetPassphrase(message);

      case MessageType.LAIR_UNLOCK:
        return handleLairUnlock(message);

      case MessageType.LAIR_LOCK:
        return handleLairLock(message);

      // Lair keypair management
      case MessageType.LAIR_NEW_SEED:
        return handleLairNewSeed(message);

      case MessageType.LAIR_LIST_ENTRIES:
        return handleLairListEntries(message);

      case MessageType.LAIR_GET_ENTRY:
        return handleLairGetEntry(message);

      case MessageType.LAIR_DELETE_ENTRY:
        return handleLairDeleteEntry(message);

      // Lair operations
      case MessageType.LAIR_SIGN:
        return handleLairSign(message);

      case MessageType.LAIR_VERIFY:
        return handleLairVerify(message);

      case MessageType.LAIR_DERIVE_SEED:
        return handleLairDeriveSeed(message);

      // Lair export/import
      case MessageType.LAIR_EXPORT_SEED:
        return handleLairExportSeed(message);

      case MessageType.LAIR_IMPORT_SEED:
        return handleLairImportSeed(message);

      // Permission management
      case MessageType.PERMISSION_GRANT:
        return handlePermissionGrant(message);

      case MessageType.PERMISSION_DENY:
        return handlePermissionDeny(message);

      case MessageType.PERMISSION_LIST:
        return handlePermissionList(message);

      case MessageType.PERMISSION_REVOKE:
        return handlePermissionRevoke(message);

      case MessageType.AUTH_REQUEST_INFO:
        return handleAuthRequestInfo(message);

      // Gateway configuration
      case MessageType.GATEWAY_CONFIGURE:
        return handleGatewayConfigure(message);

      case MessageType.GATEWAY_GET_STATUS:
        return handleGatewayGetStatus(message);

      default:
        return createErrorResponse(
          message.id,
          `Unknown message type: ${(message as any).type}`
        );
    }
  } catch (error) {
    console.error("Error handling message:", error);
    return createErrorResponse(
      message.id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Handle CONNECT requests
 * Implements Step 3 authorization flow
 */
async function handleConnect(
  message: RequestMessage,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMessage> {
  // Extract origin from tab URL
  const url = sender.tab?.url;
  if (!url) {
    return createErrorResponse(message.id, "Cannot determine origin - no tab URL");
  }

  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch (error) {
    return createErrorResponse(message.id, `Invalid URL: ${url}`);
  }

  console.log("Connect request from:", origin);

  // Check existing permission
  const permission = await permissionManager.checkPermission(origin);

  if (permission?.granted) {
    // Already approved - instant connection
    console.log(`[Auth] Origin ${origin} already approved`);
    return createSuccessResponse(message.id, {
      connected: true,
      origin,
    });
  }

  if (permission?.granted === false) {
    // Previously denied
    console.log(`[Auth] Origin ${origin} was previously denied`);
    return createErrorResponse(
      message.id,
      "Connection denied. This site was previously denied access to Fishy."
    );
  }

  // No permission set - create authorization request and open popup
  console.log(`[Auth] No permission for ${origin} - opening authorization popup`);

  const authRequest = await authManager.createAuthRequest(
    origin,
    sender.tab!.id!,
    message.id
  );

  // Open authorization popup window
  try {
    await chrome.windows.create({
      url: `popup/authorize.html?requestId=${authRequest.id}`,
      type: "popup",
      width: 420,
      height: 600,
      focused: true,
    });
  } catch (error) {
    return createErrorResponse(
      message.id,
      `Failed to open authorization popup: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // Return a promise that will be resolved when user approves/denies
  return new Promise((resolve) => {
    authManager.setPendingCallback(authRequest.id, resolve);
  });
}

/**
 * Handle DISCONNECT requests
 */
async function handleDisconnect(
  message: RequestMessage,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMessage> {
  console.log("Disconnect request from:", sender.tab?.url);

  return createSuccessResponse(message.id, {
    disconnected: true,
  });
}

/**
 * Handle CALL_ZOME requests
 * Executes WASM zome functions via ribosome
 */
async function handleCallZome(
  message: RequestMessage,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMessage> {
  try {
    const url = sender.tab?.url;
    if (!url) {
      return createErrorResponse(message.id, "Cannot determine origin - no tab URL");
    }

    const origin = new URL(url).origin;
    const requestPayload = message.payload as any;
    console.log("Zome call request:", requestPayload);

    // Check permission first
    const permission = await permissionManager.checkPermission(origin);
    if (!permission?.granted) {
      return createErrorResponse(message.id, "Permission denied");
    }

    // Get hApp context - either from contextId or from domain
    let context;
    if (requestPayload.contextId) {
      context = await happContextManager.getContext(requestPayload.contextId);
    } else {
      context = await happContextManager.getContextForDomain(origin);
    }

    if (!context) {
      return createErrorResponse(message.id, `No hApp installed for ${origin}`);
    }

    if (!context.enabled) {
      return createErrorResponse(message.id, "hApp is disabled");
    }

    // Extract zome call parameters (support both old and new format)
    const zome_name = requestPayload.zome || requestPayload.zome_name;
    const fn_name = requestPayload.function || requestPayload.fn_name;
    const payload = requestPayload.payload;

    // Build cell_id from context
    console.log(`[CallZome] Building cell_id from context`, context);
    const agentPubKey = toUint8Array(context.agentPubKey);
    const dnaHash = toUint8Array(context.dnas[0].hash); // Use first DNA's hash
    const cellId: [Uint8Array, Uint8Array] = [dnaHash, agentPubKey];
    const provenanceBytes = agentPubKey;
    console.log(`[CallZome] Cell ID built: DNA hash ${dnaHash.length} bytes, Agent ${agentPubKey.length} bytes`);

    // Find the DNA in the context
    console.log(`[CallZome] Looking for DNA in ${context.dnas.length} DNAs`);
    const dna = context.dnas.find((d) => {
      const dnaHashBytes = toUint8Array(d.hash);
      return (
        dnaHashBytes.length === dnaHash.length &&
        dnaHashBytes.every((byte, i) => byte === dnaHash[i])
      );
    });

    if (!dna) {
      console.error(`[CallZome] DNA not found!`);
      return createErrorResponse(
        message.id,
        `DNA not found in hApp context: ${Buffer.from(dnaHash).toString("hex").substring(0, 16)}...`
      );
    }

    console.log(`[CallZome] DNA found, WASM size: ${dna.wasm.length} bytes`);

    // Normalize payload: convert object-like Uint8Arrays back to real Uint8Arrays
    // Chrome's message passing converts Uint8Arrays to objects like {0: byte0, 1: byte1, ...}
    const normalizedPayload = normalizeUint8Arrays(payload);

    // Serialize payload to MessagePack
    const payloadBytes = new Uint8Array(encode(normalizedPayload));
    console.log(`[CallZome] Payload serialized: ${payloadBytes.length} bytes`);

    // Build minimal zome call request
    // WASM and manifest are NOT sent - offscreen fetches from shared IndexedDB
    const zomeCallRequest: ZomeCallRequest = {
      dnaWasm: new Uint8Array(0), // Not used - offscreen fetches from storage
      cellId,
      zome: zome_name,
      fn: fn_name,
      payload: payloadBytes,
      provenance: provenanceBytes,
      dnaManifest: undefined, // Not used - offscreen fetches from storage
    };

    console.log(`[CallZome] Executing ${zome_name}::${fn_name} via offscreen (context: ${context.id})`);

    // Execute via offscreen document (which can make sync XHR calls)
    // The offscreen document fetches WASM/manifest from IndexedDB
    const { result: transportSafeResult, signals } = await executeZomeCallViaOffscreen(context.id, zomeCallRequest);
    console.log(`[CallZome] Result from offscreen:`, transportSafeResult);

    // Deliver signals to the content script which will forward to the page
    if (signals && signals.length > 0) {
      const tabId = sender.tab?.id;
      if (tabId) {
        console.log(`[CallZome] Delivering ${signals.length} signals to tab ${tabId}`);
        for (const signal of signals) {
          try {
            // Convert signal payload from Array back to Uint8Array and decode
            const signalBytes = Array.isArray(signal.signal)
              ? new Uint8Array(signal.signal)
              : toUint8Array(signal.signal);
            const decodedPayload = decode(signalBytes);

            // Format as Holochain AppSignal structure
            // cell_id is already serialized for transport from offscreen
            const appSignal = {
              type: "app",
              value: {
                cell_id: signal.cell_id, // Already serialized as arrays
                zome_name: signal.zome_name,
                payload: serializeForTransport(decodedPayload),
              },
            };

            // Send to content script
            chrome.tabs.sendMessage(tabId, {
              type: "signal",
              payload: appSignal,
            }).catch((err) => {
              console.warn("[CallZome] Failed to send signal to tab:", err);
            });
          } catch (err) {
            console.error("[CallZome] Error processing signal:", err);
          }
        }
      } else {
        console.warn("[CallZome] No tab ID available for signal delivery");
      }
    }

    // Update last used timestamp
    await happContextManager.touchContext(context.id);

    return createSuccessResponse(message.id, transportSafeResult);
  } catch (error) {
    console.error("Error in handleCallZome:", error);
    return createErrorResponse(
      message.id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Handle APP_INFO requests
 */
async function handleAppInfo(
  message: RequestMessage,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMessage> {
  try {
    const url = sender.tab?.url;
    if (!url) {
      return createErrorResponse(message.id, "Cannot determine origin - no tab URL");
    }

    const origin = new URL(url).origin;
    console.log("App info request from:", origin);

    // Check permission first
    const permission = await permissionManager.checkPermission(origin);
    if (!permission?.granted) {
      return createErrorResponse(message.id, "Permission denied");
    }

    const context = await happContextManager.getContextForDomain(origin);
    if (!context) {
      return createErrorResponse(message.id, `No hApp installed for ${origin}`);
    }

    if (!context.enabled) {
      return createErrorResponse(message.id, "hApp is disabled");
    }

    // Update last used timestamp
    await happContextManager.touchContext(context.id);

    return createSuccessResponse(message.id, {
      contextId: context.id,
      domain: context.domain,
      appName: context.appName,
      appVersion: context.appVersion,
      agentPubKey: context.agentPubKey,
      cells: happContextManager.getCellIds(context),
      installedAt: context.installedAt,
      enabled: context.enabled,
    });
  } catch (error) {
    return createErrorResponse(
      message.id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

// ============================================================================
// hApp Context Management Handlers
// ============================================================================

/**
 * Handle INSTALL_HAPP requests
 */
async function handleInstallHapp(
  message: RequestMessage,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMessage> {
  try {
    const url = sender.tab?.url;
    if (!url) {
      return createErrorResponse(message.id, "Cannot determine origin - no tab URL");
    }

    const origin = new URL(url).origin;
    console.log("Install hApp request from:", origin);

    const request = message.payload as InstallHappRequest;
    if (!request || !request.happBundle) {
      return createErrorResponse(message.id, "Invalid install request - happBundle required");
    }

    // Convert serialized Uint8Array back to actual Uint8Array
    const normalizedRequest: InstallHappRequest = {
      appName: request.appName,
      appVersion: request.appVersion,
      happBundle: toUint8Array(request.happBundle),
    };

    const context = await happContextManager.installHapp(origin, normalizedRequest);

    return createSuccessResponse(message.id, {
      contextId: context.id,
      appName: context.appName,
      agentPubKey: context.agentPubKey,
      cells: happContextManager.getCellIds(context),
    });
  } catch (error) {
    return createErrorResponse(
      message.id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Handle UNINSTALL_HAPP requests
 */
async function handleUninstallHapp(
  message: RequestMessage,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMessage> {
  try {
    const { contextId } = message.payload as { contextId: string };
    if (!contextId) {
      return createErrorResponse(message.id, "contextId is required");
    }

    await happContextManager.uninstallHapp(contextId);
    console.log(`[HappContext] Uninstalled hApp ${contextId}`);

    return createSuccessResponse(message.id, { uninstalled: true });
  } catch (error) {
    return createErrorResponse(
      message.id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Handle LIST_HAPPS requests
 */
async function handleListHapps(
  message: RequestMessage,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMessage> {
  try {
    const contexts = await happContextManager.listContexts();

    return createSuccessResponse(message.id, {
      contexts: contexts.map((context) => ({
        id: context.id,
        domain: context.domain,
        appName: context.appName,
        appVersion: context.appVersion,
        agentPubKey: context.agentPubKey,
        installedAt: context.installedAt,
        lastUsed: context.lastUsed,
        enabled: context.enabled,
        dnaCount: context.dnas.length,
      })),
    });
  } catch (error) {
    return createErrorResponse(
      message.id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Handle ENABLE_HAPP requests
 */
async function handleEnableHapp(
  message: RequestMessage,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMessage> {
  try {
    const { contextId } = message.payload as { contextId: string };
    if (!contextId) {
      return createErrorResponse(message.id, "contextId is required");
    }

    await happContextManager.setContextEnabled(contextId, true);
    console.log(`[HappContext] Enabled context ${contextId}`);

    return createSuccessResponse(message.id, { enabled: true });
  } catch (error) {
    return createErrorResponse(
      message.id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Handle DISABLE_HAPP requests
 */
async function handleDisableHapp(
  message: RequestMessage,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMessage> {
  try {
    const { contextId } = message.payload as { contextId: string };
    if (!contextId) {
      return createErrorResponse(message.id, "contextId is required");
    }

    await happContextManager.setContextEnabled(contextId, false);
    console.log(`[HappContext] Disabled context ${contextId}`);

    return createSuccessResponse(message.id, { disabled: true });
  } catch (error) {
    return createErrorResponse(
      message.id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

// ============================================================================
// Lair Lock/Unlock Handlers
// ============================================================================

/**
 * Handle LAIR_GET_LOCK_STATE requests
 */
async function handleLairGetLockState(
  message: RequestMessage
): Promise<ResponseMessage> {
  try {
    const state = await lairLock.getLockState();
    return createSuccessResponse(message.id, state);
  } catch (error) {
    return createErrorResponse(
      message.id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Handle LAIR_SET_PASSPHRASE requests
 */
async function handleLairSetPassphrase(
  message: RequestMessage
): Promise<ResponseMessage> {
  try {
    const { passphrase } = message.payload as { passphrase: string };
    if (!passphrase) {
      return createErrorResponse(message.id, "Passphrase is required");
    }
    await lairLock.setPassphrase(passphrase);
    return createSuccessResponse(message.id, { success: true });
  } catch (error) {
    return createErrorResponse(
      message.id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Handle LAIR_UNLOCK requests
 */
async function handleLairUnlock(
  message: RequestMessage
): Promise<ResponseMessage> {
  try {
    const { passphrase } = message.payload as { passphrase: string };
    if (!passphrase) {
      return createErrorResponse(message.id, "Passphrase is required");
    }
    const unlocked = await lairLock.unlock(passphrase);
    if (unlocked) {
      return createSuccessResponse(message.id, { unlocked: true });
    } else {
      return createErrorResponse(message.id, "Incorrect passphrase");
    }
  } catch (error) {
    return createErrorResponse(
      message.id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Handle LAIR_LOCK requests
 */
async function handleLairLock(message: RequestMessage): Promise<ResponseMessage> {
  try {
    await lairLock.lock();
    return createSuccessResponse(message.id, { locked: true });
  } catch (error) {
    return createErrorResponse(
      message.id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

// ============================================================================
// Lair Keypair Management Handlers
// ============================================================================

/**
 * Check if Lair is unlocked before allowing operations
 */
async function ensureUnlocked(): Promise<void> {
  const isLocked = await lairLock.isLocked();
  if (isLocked) {
    throw new Error("Lair is locked. Please unlock first.");
  }
}

/**
 * Handle LAIR_NEW_SEED requests
 */
async function handleLairNewSeed(
  message: RequestMessage
): Promise<ResponseMessage> {
  try {
    await ensureUnlocked();
    const { tag, exportable } = message.payload as {
      tag: string;
      exportable: boolean;
    };
    if (!tag) {
      return createErrorResponse(message.id, "Tag is required");
    }
    const client = await getLairClient();
    const result = await client.newSeed(tag, exportable ?? false);
    return createSuccessResponse(message.id, result);
  } catch (error) {
    return createErrorResponse(
      message.id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Handle LAIR_LIST_ENTRIES requests
 */
async function handleLairListEntries(
  message: RequestMessage
): Promise<ResponseMessage> {
  try {
    await ensureUnlocked();
    const client = await getLairClient();
    const entries = await client.listEntries();
    return createSuccessResponse(message.id, { entries });
  } catch (error) {
    return createErrorResponse(
      message.id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Handle LAIR_GET_ENTRY requests
 */
async function handleLairGetEntry(
  message: RequestMessage
): Promise<ResponseMessage> {
  try {
    await ensureUnlocked();
    const { tag } = message.payload as { tag: string };
    if (!tag) {
      return createErrorResponse(message.id, "Tag is required");
    }
    const client = await getLairClient();
    const entry = await client.getEntry(tag);
    if (!entry) {
      return createErrorResponse(message.id, `Entry "${tag}" not found`);
    }
    return createSuccessResponse(message.id, entry);
  } catch (error) {
    return createErrorResponse(
      message.id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Handle LAIR_DELETE_ENTRY requests
 */
async function handleLairDeleteEntry(
  message: RequestMessage
): Promise<ResponseMessage> {
  try {
    await ensureUnlocked();
    const { tag } = message.payload as { tag: string };
    if (!tag) {
      return createErrorResponse(message.id, "Tag is required");
    }
    const client = await getLairClient();
    await client.deleteEntry(tag);
    return createSuccessResponse(message.id, { deleted: true });
  } catch (error) {
    return createErrorResponse(
      message.id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

// ============================================================================
// Lair Operation Handlers
// ============================================================================

/**
 * Handle LAIR_SIGN requests
 */
async function handleLairSign(
  message: RequestMessage
): Promise<ResponseMessage> {
  try {
    await ensureUnlocked();
    const payload = message.payload as {
      pub_key: any;
      data: any;
    };
    if (!payload.pub_key || !payload.data) {
      return createErrorResponse(message.id, "pub_key and data are required");
    }

    // Convert serialized Uint8Arrays back to actual Uint8Arrays
    const pub_key = toUint8Array(payload.pub_key);
    const data = toUint8Array(payload.data);

    const client = await getLairClient();
    const signature = await client.signByPubKey(pub_key, data);
    return createSuccessResponse(message.id, { signature });
  } catch (error) {
    return createErrorResponse(
      message.id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Handle LAIR_VERIFY requests
 */
async function handleLairVerify(
  message: RequestMessage
): Promise<ResponseMessage> {
  try {
    // Note: Verification doesn't require unlocking since it's public operation
    const payload = message.payload as {
      pub_key: any;
      data: any;
      signature: any;
    };
    if (!payload.pub_key || !payload.data || !payload.signature) {
      return createErrorResponse(
        message.id,
        "pub_key, data, and signature are required"
      );
    }

    // Convert serialized Uint8Arrays back to actual Uint8Arrays
    const pub_key = toUint8Array(payload.pub_key);
    const data = toUint8Array(payload.data);
    const signature = toUint8Array(payload.signature);

    // Ensure libsodium is ready
    await sodium.ready;

    // Use libsodium for verification (public operation)
    const valid = sodium.crypto_sign_verify_detached(signature, data, pub_key);

    return createSuccessResponse(message.id, { valid });
  } catch (error) {
    return createErrorResponse(
      message.id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Handle LAIR_DERIVE_SEED requests
 */
async function handleLairDeriveSeed(
  message: RequestMessage
): Promise<ResponseMessage> {
  try {
    await ensureUnlocked();
    const { source_tag, derivation_path, dest_tag, exportable } =
      message.payload as {
        source_tag: string;
        derivation_path: string | number[];
        dest_tag: string;
        exportable: boolean;
      };
    if (!source_tag || !derivation_path || !dest_tag) {
      return createErrorResponse(
        message.id,
        "source_tag, derivation_path, and dest_tag are required"
      );
    }
    const client = await getLairClient();
    const result = await client.deriveSeed(
      source_tag,
      derivation_path,
      dest_tag,
      exportable ?? false
    );
    return createSuccessResponse(message.id, result);
  } catch (error) {
    return createErrorResponse(
      message.id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

// ============================================================================
// Lair Export/Import Handlers
// ============================================================================

/**
 * Handle LAIR_EXPORT_SEED requests
 */
async function handleLairExportSeed(
  message: RequestMessage
): Promise<ResponseMessage> {
  try {
    await ensureUnlocked();
    const { tag, passphrase } = message.payload as {
      tag: string;
      passphrase: string;
    };
    if (!tag || !passphrase) {
      return createErrorResponse(message.id, "tag and passphrase are required");
    }
    const client = await getLairClient();
    const encrypted = await client.exportSeedByTag(tag, passphrase);
    return createSuccessResponse(message.id, { encrypted });
  } catch (error) {
    return createErrorResponse(
      message.id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Handle LAIR_IMPORT_SEED requests
 */
async function handleLairImportSeed(
  message: RequestMessage
): Promise<ResponseMessage> {
  try {
    await ensureUnlocked();
    const payload = message.payload as {
      encrypted: any;
      passphrase: string;
      new_tag: string;
      exportable: boolean;
    };
    if (!payload.encrypted || !payload.passphrase || !payload.new_tag) {
      return createErrorResponse(
        message.id,
        "encrypted, passphrase, and new_tag are required"
      );
    }

    // Convert serialized Uint8Arrays in EncryptedExport back to actual Uint8Arrays
    const encrypted: EncryptedExport = {
      version: payload.encrypted.version,
      tag: payload.encrypted.tag,
      ed25519_pub_key: toUint8Array(payload.encrypted.ed25519_pub_key),
      x25519_pub_key: toUint8Array(payload.encrypted.x25519_pub_key),
      salt: toUint8Array(payload.encrypted.salt),
      nonce: toUint8Array(payload.encrypted.nonce),
      cipher: toUint8Array(payload.encrypted.cipher),
      exportable: payload.encrypted.exportable,
      created_at: payload.encrypted.created_at,
    };

    const client = await getLairClient();
    const result = await client.importSeed(
      encrypted,
      payload.passphrase,
      payload.new_tag,
      payload.exportable ?? false
    );
    return createSuccessResponse(message.id, result);
  } catch (error) {
    return createErrorResponse(
      message.id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Handle PERMISSION_GRANT requests
 */
async function handlePermissionGrant(
  message: RequestMessage
): Promise<ResponseMessage> {
  try {
    const { requestId, origin } = message.payload as { requestId: string; origin: string };

    if (!requestId || !origin) {
      return createErrorResponse(message.id, "requestId and origin are required");
    }

    // Grant permission
    await permissionManager.grantPermission(origin);
    console.log(`[Auth] Permission granted for ${origin}`);

    // Resolve pending auth request
    const resolved = await authManager.resolveAuthRequest(
      requestId,
      createSuccessResponse(message.id, { connected: true, origin })
    );

    if (!resolved) {
      return createErrorResponse(message.id, "Authorization request not found or expired");
    }

    return createSuccessResponse(message.id, { granted: true });
  } catch (error) {
    return createErrorResponse(
      message.id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Handle PERMISSION_DENY requests
 */
async function handlePermissionDeny(
  message: RequestMessage
): Promise<ResponseMessage> {
  try {
    const { requestId, origin } = message.payload as { requestId: string; origin: string };

    if (!requestId || !origin) {
      return createErrorResponse(message.id, "requestId and origin are required");
    }

    // Deny permission
    await permissionManager.denyPermission(origin);
    console.log(`[Auth] Permission denied for ${origin}`);

    // Resolve pending auth request with error
    const resolved = await authManager.resolveAuthRequest(
      requestId,
      createErrorResponse(message.id, "User denied access")
    );

    if (!resolved) {
      return createErrorResponse(message.id, "Authorization request not found or expired");
    }

    return createSuccessResponse(message.id, { denied: true });
  } catch (error) {
    return createErrorResponse(
      message.id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Handle PERMISSION_LIST requests
 */
async function handlePermissionList(
  message: RequestMessage
): Promise<ResponseMessage> {
  try {
    const permissions = await permissionManager.listPermissions();
    return createSuccessResponse(message.id, { permissions });
  } catch (error) {
    return createErrorResponse(
      message.id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Handle PERMISSION_REVOKE requests
 */
async function handlePermissionRevoke(
  message: RequestMessage
): Promise<ResponseMessage> {
  try {
    const { origin } = message.payload as { origin: string };

    if (!origin) {
      return createErrorResponse(message.id, "origin is required");
    }

    await permissionManager.revokePermission(origin);
    console.log(`[Auth] Permission revoked for ${origin}`);

    return createSuccessResponse(message.id, { revoked: true });
  } catch (error) {
    return createErrorResponse(
      message.id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Handle AUTH_REQUEST_INFO requests
 */
async function handleAuthRequestInfo(
  message: RequestMessage
): Promise<ResponseMessage> {
  try {
    const { requestId } = message.payload as { requestId: string };

    if (!requestId) {
      return createErrorResponse(message.id, "requestId is required");
    }

    const authRequest = await authManager.getAuthRequest(requestId);

    if (!authRequest) {
      return createErrorResponse(message.id, "Authorization request not found");
    }

    return createSuccessResponse(message.id, {
      origin: authRequest.origin,
      timestamp: authRequest.timestamp,
    });
  } catch (error) {
    return createErrorResponse(
      message.id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

// ============================================================================
// Gateway Configuration Handlers
// ============================================================================

/**
 * Handle gateway configuration
 * Payload: { gatewayUrl: string }
 */
async function handleGatewayConfigure(
  message: RequestMessage
): Promise<ResponseMessage> {
  try {
    const { gatewayUrl } = message.payload as { gatewayUrl: string };

    if (!gatewayUrl) {
      return createErrorResponse(message.id, "gatewayUrl is required");
    }

    setGatewayConfig(gatewayUrl);

    // If offscreen document is already running, configure it now
    if (await hasOffscreenDocument()) {
      await configureOffscreenNetwork({ gatewayUrl });
    }

    return createSuccessResponse(message.id, { configured: true });
  } catch (error) {
    return createErrorResponse(
      message.id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Handle gateway status request
 */
async function handleGatewayGetStatus(
  message: RequestMessage
): Promise<ResponseMessage> {
  return createSuccessResponse(message.id, {
    configured: gatewayConfig !== null,
    gatewayUrl: gatewayConfig?.gatewayUrl || null,
    hasSession: !!gatewayConfig?.sessionToken,
    networkConfigured,
  });
}

/**
 * Listen for messages from content scripts
 */
chrome.runtime.onMessage.addListener(
  (
    rawMessage: any,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: any) => void
  ) => {
    console.log("Received raw message:", rawMessage, "from:", sender);

    // Parse and validate message
    try {
      let message: Message;

      // Handle both serialized strings and direct objects
      if (typeof rawMessage === "string") {
        message = deserializeMessage(rawMessage);
      } else {
        message = rawMessage as Message;
      }

      // Only process request messages
      if (!isRequestMessage(message)) {
        sendResponse(
          createErrorResponse(
            message.id,
            "Background only processes request messages"
          )
        );
        return false;
      }

      // Handle message asynchronously
      handleMessage(message, sender)
        .then((response) => {
          sendResponse(response);
        })
        .catch((error) => {
          console.error("Error in message handler:", error);
          sendResponse(
            createErrorResponse(
              message.id,
              error instanceof Error ? error.message : String(error)
            )
          );
        });

      // Return true to indicate async response
      return true;
    } catch (error) {
      console.error("Error processing message:", error);
      sendResponse(
        createErrorResponse(
          "unknown",
          `Failed to process message: ${error instanceof Error ? error.message : String(error)}`
        )
      );
      return false;
    }
  }
);
