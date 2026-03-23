/**
 * Background service worker for Holochain Web Conductor extension
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
  getPayload,
  type PassphrasePayload,
  type NewSeedPayload,
  type TagPayload,
  type SignPayload,
  type VerifyPayload,
  type DeriveSeedPayload,
  type ExportSeedPayload,
  type ImportSeedPayload,
  type PermissionDecisionPayload,
  type OriginPayload,
  type RequestIdPayload,
  type LinkerConfigurePayload,
  type ContextIdPayload,
  type ExportMnemonicPayload,
  type ImportMnemonicPayload,
  type ProvideMemproofsPayload,
} from "../lib/messaging";
import { getLairLock } from "../lib/lair-lock";
import { rejectTabSender } from "../lib/sender-validation";
import { getPermissionManager } from "../lib/permissions";
import { getAuthManager } from "../lib/auth-manager";
import { getHappContextManager } from "../lib/happ-context-manager";
import { createLairClient, createKeyStorage, EncryptedKeyStorage, type EncryptedExport } from "@holo-host/lair";
import type { InstallHappRequest, HappContext } from "@hwc/core";
import {
  toUint8Array,
  normalizeUint8Arrays,
  serializeForTransport,
  isAgentPubKey,
  extractEd25519PubKey,
  PublishTracker,
  buildRecords,
} from "@hwc/core";
import { encodeHashToBase64, type AgentPubKey, type CellId } from "@holochain/client";

// ExternIO is msgpack-encoded bytes - use Uint8Array as the underlying type
type ExternIO = Uint8Array;
import type { ZomeCallRequest } from "@hwc/core/ribosome";
import { encode, decode } from "@msgpack/msgpack";
import sodium from "libsodium-wrappers";
import { createLogger, setLogFilter, getLogFilter } from "../lib/logger";
import type { ZomeExecutor } from "../lib/zome-executor";
import { ChromeOffscreenExecutor } from "./chrome-offscreen-executor";
import { FirefoxDirectExecutor } from "./firefox-direct-executor";

declare const __BROWSER__: "chrome" | "firefox";

// Expose filter control to globalThis for runtime debugging
// Usage in service worker console: setHwcLogFilter('Signal,CallZome') or hwcLogFilter = 'Signal'
(globalThis as any).setHwcLogFilter = setLogFilter;
(globalThis as any).getHwcLogFilter = getLogFilter;

// Create specialized loggers for different concerns
const log = createLogger('Background');
const logAuth = createLogger('Auth');
const logZome = createLogger('CallZome');
const logLinker = createLogger('Linker');
const logSignal = createLogger('Signal');
const logLair = createLogger('Lair');
const logHapp = createLogger('HappContext');

log.info("Background service worker loaded");

// ============================================================================
// ZomeExecutor - abstraction over offscreen document / WASM execution
// ============================================================================

function createExecutor(): ZomeExecutor {
  if (typeof __BROWSER__ !== "undefined" && __BROWSER__ === "firefox") {
    log.info("Using Firefox direct executor");
    return new FirefoxDirectExecutor();
  }
  log.info("Using Chrome offscreen executor");
  return new ChromeOffscreenExecutor();
}

const executor: ZomeExecutor = createExecutor();

// Linker configuration - tracked in background for status reporting and health checks.
// Executor gets its own copy via configureNetwork().
let linkerConfig: { linkerUrl: string; sessionToken?: string } | null = null;

// Connection status tracking
interface ConnectionStatus {
  httpHealthy: boolean;
  wsHealthy: boolean;
  authenticated: boolean;
  linkerUrl: string | null;
  lastChecked: number;
  lastError?: string;
}

let connectionStatus: ConnectionStatus = {
  httpHealthy: false,
  wsHealthy: false,
  authenticated: false,
  linkerUrl: null,
  lastChecked: 0,
};

let healthCheckInterval: ReturnType<typeof setInterval> | null = null;
const HEALTH_CHECK_INTERVAL_MS = 5000;

// Long-lived ports from content scripts (used for push messages and keepalive)
const connectedPorts = new Set<chrome.runtime.Port>();

// Handle port connections from content scripts
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "hwc-content") return;

  connectedPorts.add(port);
  log.info(`Content script port connected (${connectedPorts.size} total)`);

  // Send current connection status immediately so the page has fresh state
  port.postMessage({
    type: 'connectionStatusChange',
    payload: connectionStatus,
  });

  // After background restart, the initial status may have stale wsHealthy/authenticated
  // because the executor hasn't reconnected yet. Send a follow-up once state settles.
  setTimeout(() => {
    if (connectedPorts.has(port)) {
      port.postMessage({
        type: 'connectionStatusChange',
        payload: connectionStatus,
      });
    }
  }, 3000);

  port.onDisconnect.addListener(() => {
    connectedPorts.delete(port);
    log.info(`Content script port disconnected (${connectedPorts.size} remaining)`);
  });
});

/**
 * Check linker health by making a simple HTTP request
 */
async function checkLinkerHealth(): Promise<void> {
  if (!linkerConfig?.linkerUrl) {
    connectionStatus = {
      httpHealthy: false,
      wsHealthy: false,
      authenticated: false,
      linkerUrl: null,
      lastChecked: Date.now(),
      lastError: 'No linker configured',
    };
    notifyConnectionStatusChange();
    return;
  }

  const previousStatus = { ...connectionStatus };

  try {
    // Simple health check - try to reach the linker
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const response = await fetch(`${linkerConfig.linkerUrl}/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    clearTimeout(timeout);

    connectionStatus = {
      httpHealthy: response.ok,
      wsHealthy: connectionStatus.wsHealthy, // WebSocket status tracked separately
      authenticated: connectionStatus.authenticated, // Preserve auth state
      linkerUrl: linkerConfig.linkerUrl,
      lastChecked: Date.now(),
      lastError: response.ok ? undefined : `HTTP ${response.status}`,
    };

    // Also sync WebSocket state from executor to ensure wsHealthy/authenticated is accurate
    // This catches cases where WS_STATE_CHANGE messages were missed
    if (executor.isReady()) {
      executor.getWebSocketState().then((wsState) => {
        const wasHealthy = connectionStatus.wsHealthy;
        const wasAuthenticated = connectionStatus.authenticated;
        connectionStatus.wsHealthy = wsState.isConnected;
        connectionStatus.authenticated = wsState.authenticated;
        if (wasHealthy !== connectionStatus.wsHealthy || wasAuthenticated !== connectionStatus.authenticated) {
          notifyConnectionStatusChange();
        }
      }).catch(() => {
        // Ignore errors during health check sync
      });
    }
  } catch (error) {
    connectionStatus = {
      httpHealthy: false,
      wsHealthy: connectionStatus.wsHealthy, // Preserve: WS is independent of HTTP
      authenticated: connectionStatus.authenticated, // Preserve: auth is independent of HTTP
      linkerUrl: linkerConfig.linkerUrl,
      lastChecked: Date.now(),
      lastError: error instanceof Error ? error.message : 'Connection failed',
    };
  }

  // Notify subscribers if status changed
  if (
    previousStatus.httpHealthy !== connectionStatus.httpHealthy ||
    previousStatus.wsHealthy !== connectionStatus.wsHealthy ||
    previousStatus.authenticated !== connectionStatus.authenticated ||
    previousStatus.lastError !== connectionStatus.lastError
  ) {
    log.info(`Connection status changed: http=${connectionStatus.httpHealthy} ws=${connectionStatus.wsHealthy} auth=${connectionStatus.authenticated} err=${connectionStatus.lastError || 'none'}`);
    notifyConnectionStatusChange();
  }
}

/**
 * Notify all subscribed tabs of connection status change
 */
function notifyConnectionStatusChange(): void {
  const message = {
    type: 'connectionStatusChange',
    payload: connectionStatus,
  };

  for (const port of connectedPorts) {
    try {
      port.postMessage(message);
    } catch {
      connectedPorts.delete(port);
    }
  }
}

/**
 * Start periodic health checks
 */
function startHealthChecks(): void {
  if (healthCheckInterval) return;

  // Immediate check
  checkLinkerHealth();

  // Periodic checks
  healthCheckInterval = setInterval(checkLinkerHealth, HEALTH_CHECK_INTERVAL_MS);
}

/**
 * Stop periodic health checks
 */
function stopHealthChecks(): void {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
}

/**
 * Set the linker configuration
 * Call this to enable network requests via h2hc-linker
 */
function setLinkerConfig(url: string, sessionToken?: string): void {
  linkerConfig = { linkerUrl: url, sessionToken };
  logLinker.info(`Linker config set: ${url}`);
  startHealthChecks();
  // Persist to storage so config survives background page suspension (Firefox MV3)
  chrome.storage.local.set({ hwc_linker_config: { linkerUrl: url, sessionToken } }).catch((err) => {
    logLinker.warn('Failed to persist linker config:', err);
  });
}

/**
 * Restore linker config from storage after background page restart.
 * Firefox MV3 uses non-persistent event pages that can be suspended,
 * losing all in-memory state including linkerConfig and executor state.
 */
async function restoreLinkerConfigFromStorage(): Promise<void> {
  try {
    const data = await chrome.storage.local.get('hwc_linker_config');
    const saved = data.hwc_linker_config;
    if (saved?.linkerUrl) {
      logLinker.info(`Restoring linker config from storage: ${saved.linkerUrl}`);
      linkerConfig = { linkerUrl: saved.linkerUrl, sessionToken: saved.sessionToken };
      startHealthChecks();
      // Re-initialize executor and forward config to worker
      await executor.initialize();
      await executor.configureNetwork({ linkerUrl: saved.linkerUrl, sessionToken: saved.sessionToken });
    }
  } catch (err) {
    logLinker.warn('Failed to restore linker config:', err);
  }
}

// Restore linker config on background page load (handles Firefox MV3 suspension)
restoreLinkerConfigFromStorage();

/**
 * Register all agents from a hApp context with the linker via the executor
 */
async function registerContextAgentsWithLinker(context: HappContext): Promise<void> {
  const agentPubKey = toUint8Array(context.agentPubKey);
  const agentPubKeyB64 = encodeHashToBase64(agentPubKey);

  for (const dna of context.dnas) {
    const dnaHash = toUint8Array(dna.hash);
    const dnaHashB64 = encodeHashToBase64(dnaHash);
    await executor.registerAgent(dnaHashB64, agentPubKeyB64);
  }
}

// Wire executor event callbacks
executor.onWebSocketStateChange((state, authenticated) => {
  logLinker.debug(`WebSocket state changed: ${state} authenticated: ${authenticated}`);
  const wasHealthy = connectionStatus.wsHealthy;
  const wasAuthenticated = connectionStatus.authenticated;
  connectionStatus.wsHealthy = state === "connected";
  connectionStatus.authenticated = authenticated;
  if (wasHealthy !== connectionStatus.wsHealthy || wasAuthenticated !== connectionStatus.authenticated) {
    notifyConnectionStatusChange();
  }
});

executor.onRemoteSignal((data) => {
  handleRemoteSignal(data);
});

executor.onSignRequest((data) => {
  return handleSignRequest(data);
});

// Persist session token from WS auth so it survives Firefox background page suspension
executor.onSessionToken((token) => {
  if (linkerConfig) {
    setLinkerConfig(linkerConfig.linkerUrl, token);
  }
});

// Singleton instances
const lairLock = getLairLock();
const permissionManager = getPermissionManager();
const authManager = getAuthManager();
const happContextManager = getHappContextManager();
let lairClient: Awaited<ReturnType<typeof createLairClient>> | null = null;
let encryptedStorage: EncryptedKeyStorage | null = null;

// Initialize Lair client with encrypted storage
async function getLairClient() {
  if (!lairClient) {
    const innerStorage = await createKeyStorage();
    encryptedStorage = new EncryptedKeyStorage(innerStorage);
    await encryptedStorage.init();

    // If we have a master key (unlocked), set it on the storage
    const masterKey = lairLock.getMasterKey();
    if (masterKey) {
      encryptedStorage.setMasterKey(masterKey);
    }

    lairClient = await createLairClient(encryptedStorage);
  }
  return lairClient;
}

/**
 * Tell the executor's worker to preload an agent's signing key (Firefox only).
 * On Chrome this is a no-op since signing uses SharedArrayBuffer roundtrip.
 * On Firefox the worker creates its own LairClient from IndexedDB and calls
 * preloadKeyForSync() — only the public key crosses the message boundary.
 *
 * @param agentPubKey - 39-byte AgentPubKey (3 prefix + 32 ed25519 + 4 location)
 */
async function preloadSigningKeyIfNeeded(agentPubKey: Uint8Array): Promise<void> {
  if (!executor.preloadSigningKey) return; // Chrome executor doesn't have this

  try {
    const ed25519PubKey = extractEd25519PubKey(agentPubKey);
    await executor.preloadSigningKey(ed25519PubKey);
    logLair.info("Signing key preload requested for worker");
  } catch (error) {
    logLair.error("Failed to request signing key preload:", error);
  }
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
  log.debug("Processing message:", message.type, "from tab:", sender.tab?.id);

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

      case MessageType.PROVIDE_MEMPROOFS:
        return handleProvideMemproofs(message, sender);

      // Lair lock/unlock operations
      case MessageType.LAIR_GET_LOCK_STATE:
        return handleLairGetLockState(message, sender);

      case MessageType.LAIR_SET_PASSPHRASE:
        return handleLairSetPassphrase(message, sender);

      case MessageType.LAIR_UNLOCK:
        return handleLairUnlock(message, sender);

      case MessageType.LAIR_LOCK:
        return handleLairLock(message, sender);

      // Lair keypair management
      case MessageType.LAIR_NEW_SEED:
        return handleLairNewSeed(message, sender);

      case MessageType.LAIR_LIST_ENTRIES:
        return handleLairListEntries(message, sender);

      case MessageType.LAIR_GET_ENTRY:
        return handleLairGetEntry(message, sender);

      case MessageType.LAIR_DELETE_ENTRY:
        return handleLairDeleteEntry(message, sender);

      // Lair operations
      case MessageType.LAIR_SIGN:
        return handleLairSign(message, sender);

      case MessageType.LAIR_VERIFY:
        return handleLairVerify(message, sender);

      case MessageType.LAIR_DERIVE_SEED:
        return handleLairDeriveSeed(message, sender);

      // Lair export/import
      case MessageType.LAIR_EXPORT_SEED:
        return handleLairExportSeed(message, sender);

      case MessageType.LAIR_IMPORT_SEED:
        return handleLairImportSeed(message, sender);

      // Permission management
      case MessageType.PERMISSION_GRANT:
        return handlePermissionGrant(message, sender);

      case MessageType.PERMISSION_DENY:
        return handlePermissionDeny(message, sender);

      case MessageType.PERMISSION_LIST:
        return handlePermissionList(message, sender);

      case MessageType.PERMISSION_REVOKE:
        return handlePermissionRevoke(message, sender);

      case MessageType.AUTH_REQUEST_INFO:
        return handleAuthRequestInfo(message);

      // Linker configuration
      case MessageType.LINKER_CONFIGURE:
        return handleLinkerConfigure(message);

      case MessageType.LINKER_GET_STATUS:
        return handleLinkerGetStatus(message);

      case MessageType.LINKER_DISCONNECT:
        return handleLinkerDisconnect(message);

      case MessageType.LINKER_RECONNECT:
        return handleLinkerReconnect(message);

      // Connection Status
      case MessageType.CONNECTION_STATUS_GET:
        return handleConnectionStatusGet(message);

      // DHT Publishing Debug
      case MessageType.PUBLISH_GET_STATUS:
        return handlePublishGetStatus(message);

      case MessageType.PUBLISH_RETRY_FAILED:
        return handlePublishRetryFailed(message);

      case MessageType.PUBLISH_ALL_RECORDS:
        return handlePublishAllRecords(message);

      case MessageType.RECOVER_CHAIN:
        return handleRecoverChain(message);

      case MessageType.GET_RECOVERY_PROGRESS:
        return handleGetRecoveryProgress(message);

      case MessageType.LAIR_EXPORT_MNEMONIC:
        return handleLairExportMnemonic(message, sender);

      case MessageType.LAIR_IMPORT_MNEMONIC:
        return handleLairImportMnemonic(message, sender);

      case MessageType.SIGN_RECONNECT_CHALLENGE:
        return handleSignReconnectChallenge(message, sender);

      case MessageType.SIGN_JOINING_NONCE:
        return handleSignJoiningNonce(message, sender);

      default:
        return createErrorResponse(
          message.id,
          `Unknown message type: ${(message as any).type}`
        );
    }
  } catch (error) {
    log.error("Error handling message:", error);
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

  logAuth.info("Connect request from:", origin);

  // Check existing permission
  const permission = await permissionManager.checkPermission(origin);

  if (permission?.granted) {
    // Already approved - instant connection
    logAuth.debug(`Site ${origin} already connected to Holo Web Conductor`);
    const agentPubKey = await happContextManager.getOrCreateAgentKey(origin);
    // Firefox: preload signing key into worker for local signing
    await preloadSigningKeyIfNeeded(agentPubKey);
    return createSuccessResponse(message.id, {
      connected: true,
      origin,
      agentPubKey: Array.from(agentPubKey),
    });
  }

  if (permission?.granted === false) {
    // Previously denied
    logAuth.debug(`Site ${origin} was previously denied connection to Holo Web Conductor`);
    return createErrorResponse(
      message.id,
      "Connection denied. This site was previously denied access to Holo Web Conductor."
    );
  }

  // No permission set - check if localhost (auto-approve for development)
  logAuth.info(`Site ${origin} has not connected to Holo Web Conductor - checking origin`);

  try {
    const parsedOrigin = new URL(origin);
    if (parsedOrigin.hostname === 'localhost' || parsedOrigin.hostname === '127.0.0.1') {
      logAuth.info(`Auto-approving localhost connection: ${origin}`);
      await permissionManager.grantPermission(origin, {
        title: sender.tab?.title,
        faviconUrl: sender.tab?.favIconUrl,
      });
      const agentPubKey = await happContextManager.getOrCreateAgentKey(origin);
      await preloadSigningKeyIfNeeded(agentPubKey);
      return createSuccessResponse(message.id, {
        connected: true,
        origin,
        agentPubKey: Array.from(agentPubKey),
      });
    }
  } catch {
    // URL parsing failed, fall through to popup
  }

  // Open authorization popup for non-localhost origins
  logAuth.info(`Opening authorization popup for ${origin}`);

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
      height: 560,
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
  log.debug("Disconnect request from:", sender.tab?.url);

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
  const handleStart = performance.now();
  try {
    const url = sender.tab?.url;
    if (!url) {
      return createErrorResponse(message.id, "Cannot determine origin - no tab URL");
    }

    const origin = new URL(url).origin;
    const requestPayload = message.payload as any;
    logZome.debug("Zome call request:", requestPayload);
    const afterValidation = performance.now();

    // Check permission first
    const permission = await permissionManager.checkPermission(origin);
    const afterPermission = performance.now();
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
    const afterContext = performance.now();

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
    logZome.trace(`Building cell_id from context`, context.id);
    const agentPubKey = toUint8Array(context.agentPubKey);
    const dnaHash = toUint8Array(context.dnas[0].hash); // Use first DNA's hash
    const cellId: [Uint8Array, Uint8Array] = [dnaHash, agentPubKey];
    const provenanceBytes = agentPubKey;
    logZome.trace(`Cell ID built: DNA hash ${dnaHash.length} bytes, Agent ${agentPubKey.length} bytes`);

    // Find the DNA in the context
    logZome.trace(`Looking for DNA in ${context.dnas.length} DNAs`);
    const dna = context.dnas.find((d) => {
      const dnaHashBytes = toUint8Array(d.hash);
      return (
        dnaHashBytes.length === dnaHash.length &&
        dnaHashBytes.every((byte, i) => byte === dnaHash[i])
      );
    });

    if (!dna) {
      logZome.error(`DNA not found`);
      return createErrorResponse(
        message.id,
        `DNA not found in hApp context: ${Buffer.from(dnaHash).toString("hex").substring(0, 16)}...`
      );
    }

    logZome.trace(`DNA found, WASM size: ${dna.wasm.length} bytes`);

    // Normalize payload: convert object-like Uint8Arrays back to real Uint8Arrays
    // Chrome's message passing converts Uint8Arrays to objects like {0: byte0, 1: byte1, ...}
    const normalizedPayload = normalizeUint8Arrays(payload);

    // DIAGNOSTIC: log raw and normalized payload for failing calls
    if (fn_name === 'get_joining_timestamp_for_agent' || fn_name === 'get_batch_mews_with_context') {
      console.log(`[DIAG handleCallZome] ${zome_name}::${fn_name} raw payload:`, JSON.stringify(payload));
      console.log(`[DIAG handleCallZome] ${zome_name}::${fn_name} normalized payload:`, JSON.stringify(normalizedPayload));
    }

    // Serialize payload to MessagePack
    const payloadBytes = new Uint8Array(encode(normalizedPayload));
    logZome.trace(`Payload serialized: ${payloadBytes.length} bytes`);

    // Firefox: ensure signing key is preloaded in worker before WASM execution.
    // This is idempotent — if key is already loaded, it's a no-op.
    await preloadSigningKeyIfNeeded(agentPubKey);

    const afterPrepare = performance.now();

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

    logZome.info(`Executing ${zome_name}::${fn_name} via offscreen (context: ${context.id})`);
    const beforeOffscreen = performance.now();

    // Execute via offscreen document (which can make sync XHR calls)
    // The offscreen document fetches WASM/manifest from IndexedDB
    const { result: transportSafeResult, signals, didWrite } = await executor.executeZomeCall(context.id, zomeCallRequest);
    const afterOffscreen = performance.now();
    logZome.trace(`Result from offscreen:`, typeof transportSafeResult);

    // Deliver signals to the content script which will forward to the page
    if (signals && signals.length > 0) {
      const tabId = sender.tab?.id;
      if (tabId) {
        logSignal.info(`Delivering ${signals.length} signals to tab ${tabId}`);
        for (const signal of signals) {
          try {
            // Convert signal payload from Array back to Uint8Array and decode
            const signalBytes = Array.isArray(signal.signal)
              ? new Uint8Array(signal.signal)
              : toUint8Array(signal.signal);
            const decodedPayload = decode(signalBytes);

            // Format as Holochain AppSignal structure
            // Note: We use normalizeUint8Arrays instead of serializeForTransport
            // because apps expect Uint8Arrays in signal payloads (e.g., for AgentPubKey.subarray())
            // chrome.tabs.sendMessage supports structured cloning which preserves Uint8Array
            const appSignal = {
              type: "app",
              value: {
                cell_id: normalizeUint8Arrays(signal.cell_id),
                zome_name: signal.zome_name,
                payload: normalizeUint8Arrays(decodedPayload),
              },
            };

            // Send to content script
            logSignal.debug("Sending signal to tab:", tabId);
            chrome.tabs.sendMessage(tabId, {
              type: "signal",
              payload: appSignal,
            }).then(() => {
              logSignal.debug("Signal sent successfully to tab:", tabId);
            }).catch((err) => {
              logSignal.warn("Failed to send signal to tab:", err);
            });
          } catch (err) {
            logSignal.error("Error processing signal:", err);
          }
        }
      } else {
        logSignal.warn("No tab ID available for signal delivery");
      }
    }

    // Seal recovery on first chain-writing zome call after recovery
    if (didWrite && context.recoverySealed === false) {
      await happContextManager.sealRecovery(context.id);
    }

    // Update last used timestamp
    await happContextManager.touchContext(context.id);
    const afterSignals = performance.now();

    log.perf(`handleCallZome breakdown: validation=${(afterValidation - handleStart).toFixed(1)}ms, permission=${(afterPermission - afterValidation).toFixed(1)}ms, getContext=${(afterContext - afterPermission).toFixed(1)}ms, prepare=${(afterPrepare - afterContext).toFixed(1)}ms, offscreen=${(afterOffscreen - beforeOffscreen).toFixed(1)}ms, signals=${(afterSignals - afterOffscreen).toFixed(1)}ms, TOTAL=${(afterSignals - handleStart).toFixed(1)}ms`);

    return createSuccessResponse(message.id, transportSafeResult);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const rp = message.payload as any;
    const zn = rp?.zome || rp?.zome_name || '?';
    const fn = rp?.function || rp?.fn_name || '?';
    logZome.error(`Error in handleCallZome ${zn}::${fn}:`, errMsg);
    return createErrorResponse(
      message.id,
      `${zn}::${fn}: ${errMsg}`
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
    logHapp.debug("App info request from:", origin);

    // Check permission first
    const permission = await permissionManager.checkPermission(origin);
    if (!permission?.granted) {
      return createErrorResponse(message.id, "Permission denied");
    }

    const context = await happContextManager.getContextForDomain(origin);
    if (!context) {
      return createErrorResponse(message.id, `No hApp installed for ${origin}`);
    }

    if (!context.enabled && context.status !== 'awaitingMemproofs') {
      return createErrorResponse(message.id, "hApp is disabled");
    }

    // Update last used timestamp
    await happContextManager.touchContext(context.id);

    // Collect DNA properties for each DNA (apps need this for dna_modifiers)
    const dnaProperties: Record<string, Record<string, unknown>> = {};
    for (const dna of context.dnas) {
      if (dna.name && dna.properties) {
        dnaProperties[dna.name] = dna.properties;
      }
    }

    return createSuccessResponse(message.id, {
      contextId: context.id,
      domain: context.domain,
      appName: context.appName,
      appVersion: context.appVersion,
      agentPubKey: context.agentPubKey,
      cells: happContextManager.getCellIds(context),
      installedAt: context.installedAt,
      enabled: context.enabled,
      status: context.status,
      dnaProperties,
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
    logHapp.info("Install hApp request from:", origin);

    const request = message.payload as InstallHappRequest;
    if (!request || !request.happBundle) {
      return createErrorResponse(message.id, "Invalid install request - happBundle required");
    }

    // Convert serialized Uint8Array back to actual Uint8Array
    // Normalize membrane proofs if provided
    let membraneProofs: Record<string, Uint8Array> | undefined;
    if (request.membraneProofs) {
      membraneProofs = {};
      for (const [role, proof] of Object.entries(request.membraneProofs)) {
        membraneProofs[role] = toUint8Array(proof);
      }
    }

    const normalizedRequest: InstallHappRequest = {
      appName: request.appName,
      appVersion: request.appVersion,
      happBundle: toUint8Array(request.happBundle),
      membraneProofs,
      agentKeyTag: request.agentKeyTag,
    };

    let context = await happContextManager.installHapp(origin, normalizedRequest);

    // If the app requires membrane proofs AND they were provided at install time,
    // run genesis immediately (one-step flow) instead of requiring a second
    // PROVIDE_MEMPROOFS call. The context was parked as awaitingMemproofs by
    // installHapp regardless; we now complete it here.
    if (context.status === 'awaitingMemproofs' && membraneProofs) {
      logHapp.info(`Running genesis immediately for ${context.id} (memproofs provided at install)`);
      await executor.initialize();

      for (const dna of context.dnas) {
        const roleName = dna.name ?? '';
        const proof = membraneProofs[roleName];

        const cellId: [number[], number[]] = [
          Array.from(toUint8Array(dna.hash)),
          Array.from(toUint8Array(context.agentPubKey)),
        ];
        const dnaWasm = Array.from(toUint8Array(dna.wasm));
        const membraneProofArr = proof ? Array.from(proof) : null;

        logHapp.info(`Running genesis for DNA "${roleName}" in context ${context.id}`);
        await executor.runGenesis(cellId, dnaWasm, dna.manifest ?? null, membraneProofArr);
      }

      context = await happContextManager.completeMemproofs(context.id);
      logHapp.info(`Genesis complete for ${context.id} (one-step install), status: ${context.status}`);
    }

    // Register agents with linker for signal forwarding
    // Do this asynchronously - don't block the install response
    registerContextAgentsWithLinker(context).catch((err) => {
      logLinker.warn("Failed to register agents with linker:", err);
    });

    return createSuccessResponse(message.id, {
      contextId: context.id,
      appName: context.appName,
      agentPubKey: context.agentPubKey,
      cells: happContextManager.getCellIds(context),
      status: context.status,
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
    const { contextId } = getPayload<MessageType.UNINSTALL_HAPP>(message);
    if (!contextId) {
      return createErrorResponse(message.id, "contextId is required");
    }

    await happContextManager.uninstallHapp(contextId);
    logHapp.info(`Uninstalled hApp ${contextId}`);

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
        agentPubKey: Array.from(context.agentPubKey),
        installedAt: context.installedAt,
        lastUsed: context.lastUsed,
        enabled: context.enabled,
        status: context.status,
        dnas: context.dnas.map((dna) => ({
          hash: Array.from(dna.hash),
          name: dna.name,
          networkSeed: dna.networkSeed,
        })),
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
    const { contextId } = getPayload<MessageType.ENABLE_HAPP>(message);
    if (!contextId) {
      return createErrorResponse(message.id, "contextId is required");
    }

    await happContextManager.setContextEnabled(contextId, true);
    logHapp.info(`Enabled context ${contextId}`);

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
    const { contextId } = getPayload<MessageType.DISABLE_HAPP>(message);
    if (!contextId) {
      return createErrorResponse(message.id, "contextId is required");
    }

    await happContextManager.setContextEnabled(contextId, false);
    logHapp.info(`Disabled context ${contextId}`);

    return createSuccessResponse(message.id, { disabled: true });
  } catch (error) {
    return createErrorResponse(
      message.id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Handle PROVIDE_MEMPROOFS requests
 * Provides membrane proofs for an app in awaitingMemproofs state,
 * triggering genesis with the provided proofs.
 */
async function handleProvideMemproofs(
  message: RequestMessage,
  _sender: chrome.runtime.MessageSender
): Promise<ResponseMessage> {
  try {
    const { contextId, memproofs } = getPayload<MessageType.PROVIDE_MEMPROOFS>(message);
    if (!contextId) {
      return createErrorResponse(message.id, "contextId is required");
    }
    if (!memproofs || Object.keys(memproofs).length === 0) {
      return createErrorResponse(message.id, "memproofs are required");
    }

    // Normalize Uint8Arrays from Chrome message passing
    const normalizedMemproofs: Record<string, Uint8Array> = {};
    for (const [role, proof] of Object.entries(memproofs)) {
      normalizedMemproofs[role] = toUint8Array(proof);
    }

    // Validate state and get context info (does NOT enable the context yet)
    const context = await happContextManager.provideMemproofs(contextId, normalizedMemproofs);
    logHapp.info(`Running genesis for ${contextId} with ${context.dnas.length} DNA(s)`);

    // Run genesis_self_check + initializeGenesis for each DNA via offscreen worker.
    // If any DNA fails, the whole operation fails and context stays in awaitingMemproofs.
    await executor.initialize();

    for (const dna of context.dnas) {
      const roleName = dna.name ?? '';
      const proof = normalizedMemproofs[roleName];

      const cellId: [number[], number[]] = [
        Array.from(toUint8Array(dna.hash)),
        Array.from(toUint8Array(context.agentPubKey)),
      ];
      const dnaWasm = Array.from(toUint8Array(dna.wasm));
      const membraneProofArr = proof ? Array.from(proof) : null;

      logHapp.info(`Running genesis for DNA "${roleName}" in context ${contextId}`);
      await executor.runGenesis(cellId, dnaWasm, dna.manifest ?? null, membraneProofArr);
    }

    // All DNAs passed genesis_self_check - transition context to enabled
    const updatedContext = await happContextManager.completeMemproofs(contextId);
    logHapp.info(`Membrane proofs accepted for ${contextId}, status: ${updatedContext.status}`);

    // Register agents with linker now that genesis is complete
    registerContextAgentsWithLinker(updatedContext).catch((err) => {
      logLinker.warn("Failed to register agents with linker after memproof:", err);
    });

    return createSuccessResponse(message.id, {
      contextId: updatedContext.id,
      status: updatedContext.status,
      enabled: updatedContext.enabled,
    });
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
  message: RequestMessage,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMessage> {
  const blocked = rejectTabSender(sender, message.id, "LAIR_GET_LOCK_STATE");
  if (blocked) return blocked;
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
  message: RequestMessage,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMessage> {
  const blocked = rejectTabSender(sender, message.id, "LAIR_SET_PASSPHRASE");
  if (blocked) return blocked;
  try {
    const { passphrase, oldPassphrase } = getPayload<MessageType.LAIR_SET_PASSPHRASE>(message);
    if (!passphrase) {
      return createErrorResponse(message.id, "Passphrase is required");
    }

    const { oldMasterKey, newMasterKey } = await lairLock.setPassphrase(passphrase, oldPassphrase);

    // Ensure encrypted storage is initialized
    await getLairClient();

    if (encryptedStorage) {
      if (oldMasterKey) {
        // Re-encrypt all seeds with new key
        await encryptedStorage.reEncrypt(oldMasterKey, newMasterKey);
        oldMasterKey.fill(0);
      } else {
        // First passphrase or migrating from v1 — encrypt any plaintext seeds
        encryptedStorage.setMasterKey(newMasterKey);
        await encryptedStorage.migrateToEncrypted();
      }
      encryptedStorage.setMasterKey(newMasterKey);

      // Propagate master key to Firefox worker if applicable
      if (executor.sendMasterKeyToWorker) {
        await executor.sendMasterKeyToWorker(newMasterKey);
      }
    }

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
  message: RequestMessage,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMessage> {
  const blocked = rejectTabSender(sender, message.id, "LAIR_UNLOCK");
  if (blocked) return blocked;
  try {
    const { passphrase } = getPayload<MessageType.LAIR_UNLOCK>(message);
    if (!passphrase) {
      return createErrorResponse(message.id, "Passphrase is required");
    }
    const unlocked = await lairLock.unlock(passphrase);
    if (unlocked) {
      const masterKey = lairLock.getMasterKey();

      // Ensure encrypted storage is initialized
      await getLairClient();

      if (encryptedStorage && masterKey) {
        encryptedStorage.setMasterKey(masterKey);

        // Migrate any plaintext seeds from pre-encryption era
        await encryptedStorage.migrateToEncrypted();

        // Propagate master key to Firefox worker if applicable
        if (executor.sendMasterKeyToWorker) {
          await executor.sendMasterKeyToWorker(masterKey);
        }
      }

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
async function handleLairLock(
  message: RequestMessage,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMessage> {
  const blocked = rejectTabSender(sender, message.id, "LAIR_LOCK");
  if (blocked) return blocked;
  try {
    await lairLock.lock();

    // Wipe master key from encrypted storage
    if (encryptedStorage) {
      encryptedStorage.clearMasterKey();
    }

    // Clear preloaded signing keys from LairClient
    if (lairClient) {
      lairClient.clearAllPreloadedKeys();
    }

    // Tell Firefox worker to clear its master key
    if (executor.clearWorkerMasterKey) {
      await executor.clearWorkerMasterKey();
    }

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
  message: RequestMessage,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMessage> {
  const blocked = rejectTabSender(sender, message.id, "LAIR_NEW_SEED");
  if (blocked) return blocked;
  try {
    await ensureUnlocked();
    const { tag, exportable } = getPayload<MessageType.LAIR_NEW_SEED>(message);
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
  message: RequestMessage,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMessage> {
  const blocked = rejectTabSender(sender, message.id, "LAIR_LIST_ENTRIES");
  if (blocked) return blocked;
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
  message: RequestMessage,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMessage> {
  const blocked = rejectTabSender(sender, message.id, "LAIR_GET_ENTRY");
  if (blocked) return blocked;
  try {
    await ensureUnlocked();
    const { tag } = getPayload<MessageType.LAIR_GET_ENTRY>(message);
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
  message: RequestMessage,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMessage> {
  const blocked = rejectTabSender(sender, message.id, "LAIR_DELETE_ENTRY");
  if (blocked) return blocked;
  try {
    await ensureUnlocked();
    const { tag } = getPayload<MessageType.LAIR_DELETE_ENTRY>(message);
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
  message: RequestMessage,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMessage> {
  try {
    await ensureUnlocked();
    const payload = getPayload<MessageType.LAIR_SIGN>(message);
    if (!payload.data) {
      return createErrorResponse(message.id, "data is required");
    }

    let pubKey: Uint8Array;

    if (sender.tab) {
      // Tab context: derive pubKey from origin, ignore payload.pubKey.
      // This prevents a malicious page from signing with arbitrary keys.
      const url = sender.tab.url;
      if (!url) {
        return createErrorResponse(message.id, "Cannot determine origin - no tab URL");
      }
      const origin = new URL(url).origin;
      const context = await happContextManager.getContextForDomain(origin);
      let agentPubKey: Uint8Array;
      if (context?.agentPubKey) {
        agentPubKey = toUint8Array(context.agentPubKey);
      } else {
        agentPubKey = await happContextManager.getOrCreateAgentKey(origin);
      }
      pubKey = extractEd25519PubKey(agentPubKey);
    } else {
      // Popup/extension context: trust the payload pubKey
      if (!payload.pubKey) {
        return createErrorResponse(message.id, "pubKey is required");
      }
      pubKey = toUint8Array(payload.pubKey);
    }

    const data = toUint8Array(payload.data);
    const client = await getLairClient();
    const signature = await client.signByPubKey(pubKey, data);
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
  message: RequestMessage,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMessage> {
  const blocked = rejectTabSender(sender, message.id, "LAIR_VERIFY");
  if (blocked) return blocked;
  try {
    // Note: Verification doesn't require unlocking since it's public operation
    const payload = getPayload<MessageType.LAIR_VERIFY>(message);
    if (!payload.pubKey || !payload.data || !payload.signature) {
      return createErrorResponse(
        message.id,
        "pubKey, data, and signature are required"
      );
    }

    // Convert serialized Uint8Arrays back to actual Uint8Arrays
    const pubKey = toUint8Array(payload.pubKey);
    const data = toUint8Array(payload.data);
    const signature = toUint8Array(payload.signature);

    // Ensure libsodium is ready
    await sodium.ready;

    // Use libsodium for verification (public operation)
    const valid = sodium.crypto_sign_verify_detached(signature, data, pubKey);

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
  message: RequestMessage,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMessage> {
  const blocked = rejectTabSender(sender, message.id, "LAIR_DERIVE_SEED");
  if (blocked) return blocked;
  try {
    await ensureUnlocked();
    const { srcTag, srcIndex, dstTag, exportable } = getPayload<MessageType.LAIR_DERIVE_SEED>(message);
    if (!srcTag || srcIndex === undefined || !dstTag) {
      return createErrorResponse(
        message.id,
        "srcTag, srcIndex, and dstTag are required"
      );
    }
    const client = await getLairClient();
    const result = await client.deriveSeed(
      srcTag,
      [srcIndex],
      dstTag,
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
  message: RequestMessage,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMessage> {
  const blocked = rejectTabSender(sender, message.id, "LAIR_EXPORT_SEED");
  if (blocked) return blocked;
  try {
    await ensureUnlocked();
    const { tag, passphrase } = getPayload<MessageType.LAIR_EXPORT_SEED>(message);
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
  message: RequestMessage,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMessage> {
  const blocked = rejectTabSender(sender, message.id, "LAIR_IMPORT_SEED");
  if (blocked) return blocked;
  try {
    await ensureUnlocked();
    const payload = getPayload<MessageType.LAIR_IMPORT_SEED>(message);
    if (!payload.encrypted || !payload.passphrase || !payload.tag) {
      return createErrorResponse(
        message.id,
        "encrypted, passphrase, and tag are required"
      );
    }

    // Convert serialized Uint8Arrays in EncryptedExport back to actual Uint8Arrays
    const encrypted: EncryptedExport = {
      version: (payload.encrypted as any).version,
      tag: (payload.encrypted as any).tag,
      ed25519_pub_key: toUint8Array((payload.encrypted as any).ed25519_pub_key),
      x25519_pub_key: toUint8Array((payload.encrypted as any).x25519_pub_key),
      salt: toUint8Array(payload.encrypted.salt),
      nonce: toUint8Array(payload.encrypted.nonce),
      cipher: toUint8Array(payload.encrypted.cipher),
      exportable: (payload.encrypted as any).exportable,
      created_at: (payload.encrypted as any).created_at,
    };

    const client = await getLairClient();
    const result = await client.importSeed(
      encrypted,
      payload.passphrase,
      payload.tag,
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
  message: RequestMessage,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMessage> {
  const blocked = rejectTabSender(sender, message.id, "PERMISSION_GRANT");
  if (blocked) return blocked;
  try {
    const { requestId, origin } = getPayload<MessageType.PERMISSION_GRANT>(message);

    if (!requestId || !origin) {
      return createErrorResponse(message.id, "requestId and origin are required");
    }

    // Get page metadata from the original requesting tab
    const authReq = await authManager.getAuthRequest(requestId);
    let tabMeta: { title?: string; faviconUrl?: string } = {};
    if (authReq?.tabId) {
      try {
        const tab = await chrome.tabs.get(authReq.tabId);
        tabMeta = { title: tab.title, faviconUrl: tab.favIconUrl };
      } catch { /* tab may have closed */ }
    }

    // Grant permission
    await permissionManager.grantPermission(origin, tabMeta);
    logAuth.info(`Connection approved for ${origin}`);

    // Generate/retrieve agent key for this origin
    const agentPubKey = await happContextManager.getOrCreateAgentKey(origin);
    // Firefox: preload signing key into worker for local signing
    await preloadSigningKeyIfNeeded(agentPubKey);

    // Resolve pending auth request
    const resolved = await authManager.resolveAuthRequest(
      requestId,
      createSuccessResponse(message.id, { connected: true, origin, agentPubKey: Array.from(agentPubKey) })
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
  message: RequestMessage,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMessage> {
  const blocked = rejectTabSender(sender, message.id, "PERMISSION_DENY");
  if (blocked) return blocked;
  try {
    const { requestId, origin } = getPayload<MessageType.PERMISSION_DENY>(message);

    if (!requestId || !origin) {
      return createErrorResponse(message.id, "requestId and origin are required");
    }

    // Deny permission
    await permissionManager.denyPermission(origin);
    logAuth.info(`Connection denied for ${origin}`);

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
  message: RequestMessage,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMessage> {
  const blocked = rejectTabSender(sender, message.id, "PERMISSION_LIST");
  if (blocked) return blocked;
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
  message: RequestMessage,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMessage> {
  const blocked = rejectTabSender(sender, message.id, "PERMISSION_REVOKE");
  if (blocked) return blocked;
  try {
    const { origin } = getPayload<MessageType.PERMISSION_REVOKE>(message);

    if (!origin) {
      return createErrorResponse(message.id, "origin is required");
    }

    await permissionManager.revokePermission(origin);
    logAuth.info(`Site ${origin} disconnected from Holo Web Conductor`);

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
    const { requestId } = getPayload<MessageType.AUTH_REQUEST_INFO>(message);

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
// Linker Configuration Handlers
// ============================================================================

/**
 * Handle linker configuration
 * Payload: { linkerUrl: string }
 */
async function handleLinkerConfigure(
  message: RequestMessage
): Promise<ResponseMessage> {
  try {
    const { linkerUrl } = getPayload<MessageType.LINKER_CONFIGURE>(message);

    if (!linkerUrl) {
      return createErrorResponse(message.id, "linkerUrl is required");
    }

    setLinkerConfig(linkerUrl);

    // Initialize executor and configure network.
    // Always call configureNetwork even if previously configured — the linker URL
    // may have changed (e.g., fresh URL from joining service reconnect) and the
    // offscreen document may have been recreated by the browser.
    await executor.initialize();
    await executor.configureNetwork({ linkerUrl });

    // Register agents for existing hApp contexts
    const contexts = await happContextManager.listContexts();
    for (const context of contexts) {
      if (context.enabled) {
        registerContextAgentsWithLinker(context).catch((err) => {
          logLinker.warn(`Failed to register agents for ${context.id}:`, err);
        });
      }
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
 * Handle linker status request
 */
async function handleLinkerGetStatus(
  message: RequestMessage
): Promise<ResponseMessage> {
  return createSuccessResponse(message.id, {
    configured: linkerConfig !== null,
    linkerUrl: linkerConfig?.linkerUrl || null,
    hasSession: !!linkerConfig?.sessionToken,
    networkConfigured: executor.networkConfigured,
  });
}

/**
 * Handle linker disconnect request - actually disconnects WebSocket
 */
async function handleLinkerDisconnect(
  message: RequestMessage
): Promise<ResponseMessage> {
  log.info("[Linker] Disconnecting WebSocket...");

  try {
    await executor.disconnectLinker();
  } catch (error) {
    log.warn("Failed to disconnect linker:", error);
    return createErrorResponse(message.id, error instanceof Error ? error.message : "Failed to disconnect");
  }

  return createSuccessResponse(message.id, { disconnected: true });
}

/**
 * Handle linker reconnect request - reconnects WebSocket
 */
async function handleLinkerReconnect(
  message: RequestMessage
): Promise<ResponseMessage> {
  log.info("[Linker] Reconnecting WebSocket...");

  try {
    await executor.reconnectLinker();
  } catch (error) {
    log.warn("Failed to reconnect linker:", error);
    return createErrorResponse(message.id, error instanceof Error ? error.message : "Failed to reconnect");
  }

  return createSuccessResponse(message.id, { reconnected: true });
}

// ============================================================================
// Connection Status Handlers
// ============================================================================

/**
 * Handle CONNECTION_STATUS_GET request
 * Returns current connection health status
 */
async function handleConnectionStatusGet(
  message: RequestMessage
): Promise<ResponseMessage> {
  return createSuccessResponse(message.id, connectionStatus);
}

// ============================================================================
// DHT Publishing Debug Handlers
// ============================================================================

/**
 * Handle PUBLISH_GET_STATUS request
 * Returns publish status counts for all DNAs in the specified hApp context
 */
async function handlePublishGetStatus(
  message: RequestMessage
): Promise<ResponseMessage> {
  const payload = getPayload<MessageType.PUBLISH_GET_STATUS>(message);
  const { contextId } = payload as ContextIdPayload;

  try {
    const context = await happContextManager.getContext(contextId);
    if (!context) {
      return createErrorResponse(message.id, `HApp context not found: ${contextId}`);
    }

    // Get DNA hashes from context
    const dnaHashes = context.dnas.map((dna) => dna.hash);

    // Query publish tracker for status counts
    const tracker = PublishTracker.getInstance();
    const counts = await tracker.getStatusCountsForDnas(dnaHashes);

    return createSuccessResponse(message.id, counts);
  } catch (error) {
    return createErrorResponse(
      message.id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Handle PUBLISH_RETRY_FAILED request
 * Resets all failed ops to pending for all DNAs in the specified hApp context,
 * then triggers the publish queue processing.
 */
async function handlePublishRetryFailed(
  message: RequestMessage
): Promise<ResponseMessage> {
  const payload = getPayload<MessageType.PUBLISH_RETRY_FAILED>(message);
  const { contextId } = payload as ContextIdPayload;

  try {
    const context = await happContextManager.getContext(contextId);
    if (!context) {
      return createErrorResponse(message.id, `HApp context not found: ${contextId}`);
    }

    // Get DNA hashes from context
    const dnaHashes = context.dnas.map((dna) => dna.hash);

    // Reset failed ops to pending
    const tracker = PublishTracker.getInstance();
    const resetCount = await tracker.resetFailedForDnas(dnaHashes);

    // Trigger publish queue processing via executor
    if (resetCount > 0) {
      executor.processPublishQueue(dnaHashes.map((h) => Array.from(h))).catch((err) => {
        log.error("Failed to trigger publish queue processing:", err);
      });
    }

    return createSuccessResponse(message.id, { resetCount });
  } catch (error) {
    return createErrorResponse(
      message.id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Handle PUBLISH_ALL_RECORDS request
 * Regenerates and queues all DhtOps from local chain records for republishing
 */
async function handlePublishAllRecords(
  message: RequestMessage
): Promise<ResponseMessage> {
  const payload = getPayload<MessageType.PUBLISH_ALL_RECORDS>(message);
  const { contextId } = payload as ContextIdPayload;

  try {
    const context = await happContextManager.getContext(contextId);
    if (!context) {
      return createErrorResponse(message.id, `HApp context not found: ${contextId}`);
    }

    log.info(`[PUBLISH_ALL_RECORDS] Starting republish for context: ${contextId}`);

    // Ensure executor is ready
    await executor.initialize();

    const tracker = PublishTracker.getInstance();
    let cellsProcessed = 0;
    let opsQueued = 0;
    const errors: string[] = [];

    // For each DNA in context, get all records and queue them
    for (const dna of context.dnas) {
      const dnaHash = toUint8Array(dna.hash);
      const agentPubKey = toUint8Array(context.agentPubKey);

      log.debug(`[PUBLISH_ALL_RECORDS] Getting records for DNA: ${encodeHashToBase64(dnaHash).substring(0, 15)}...`);

      let transportRecords: any[];
      try {
        const result = await executor.getAllRecords(Array.from(dnaHash), Array.from(agentPubKey));
        transportRecords = result.records;
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        log.error(`[PUBLISH_ALL_RECORDS] Failed to get records: ${errMsg}`);
        errors.push(`DNA ${encodeHashToBase64(dnaHash).substring(0, 8)}...: ${errMsg}`);
        continue;
      }

      cellsProcessed++;
      log.info(`[PUBLISH_ALL_RECORDS] Got ${transportRecords.length} records from worker`);

      if (transportRecords.length === 0) {
        continue;
      }

      // Convert transport format (arrays) back to Uint8Arrays for buildRecords
      const storedRecords = transportRecords.map((r: any) => ({
        action: convertTransportActionToStored(r.action),
        entry: r.entry ? convertTransportEntryToStored(r.entry) : undefined,
      }));

      // Build @holochain/client Record format
      const records = buildRecords(storedRecords);
      log.debug(`[PUBLISH_ALL_RECORDS] Built ${records.length} records for queuing`);

      // Queue each record for publishing
      for (const record of records) {
        try {
          const publishIds = await tracker.queueRecordForPublish(record, dnaHash);
          opsQueued += publishIds.length;
        } catch (err) {
          log.error(`[PUBLISH_ALL_RECORDS] Failed to queue record:`, err);
          // Don't add to errors array - continue processing other records
        }
      }
    }

    log.info(`[PUBLISH_ALL_RECORDS] Queued ${opsQueued} ops from ${cellsProcessed} cells`);

    // Trigger publish queue processing in offscreen
    if (opsQueued > 0) {
      const dnaHashes = context.dnas.map((d) => Array.from(toUint8Array(d.hash)));

      // Ensure agents are registered with linker WebSocket before publishing
      // This is critical: the linker's kitsune2 needs to know about the agents
      // before it can accept publish requests on their behalf
      log.info(`[PUBLISH_ALL_RECORDS] Registering agents with linker WebSocket...`);

      const agentPubKeyB64 = encodeHashToBase64(toUint8Array(context.agentPubKey));
      for (const dna of context.dnas) {
        const dnaHashB64 = encodeHashToBase64(toUint8Array(dna.hash));
        try {
          await executor.registerAgent(dnaHashB64, agentPubKeyB64);
          log.debug(`[PUBLISH_ALL_RECORDS] Registered agent for DNA: ${dnaHashB64.substring(0, 15)}...`);
        } catch (err) {
          log.warn(`[PUBLISH_ALL_RECORDS] Failed to register agent, continuing anyway:`, err);
        }
      }

      // Wait a brief moment for agent info to propagate through kitsune2
      // This allows the linker proxy agents to be recognized by conductors
      log.info(`[PUBLISH_ALL_RECORDS] Waiting for agent propagation (2s)...`);
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Now trigger publish
      executor.processPublishQueue(dnaHashes).catch((err) => {
        log.error("Failed to trigger publish queue processing:", err);
      });
    }

    return createSuccessResponse(message.id, {
      cellsProcessed,
      opsQueued,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    log.error("[PUBLISH_ALL_RECORDS] Error:", error);
    return createErrorResponse(
      message.id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Handle RECOVER_CHAIN request
 * Triggers DHT chain recovery for a hApp context via the offscreen worker
 */
async function handleRecoverChain(
  message: RequestMessage
): Promise<ResponseMessage> {
  try {
    const { contextId } = getPayload<MessageType.RECOVER_CHAIN>(message);
    if (!contextId) {
      return createErrorResponse(message.id, "contextId is required");
    }

    const context = await happContextManager.getContext(contextId);
    if (!context) {
      return createErrorResponse(message.id, `HApp context not found: ${contextId}`);
    }

    if (context.recoverySealed) {
      return createErrorResponse(message.id,
        "Recovery is sealed: new data has been written since recovery. Re-running would fork the chain.");
    }

    if (!linkerConfig) {
      return createErrorResponse(message.id, "Linker is not configured");
    }

    // Initialize recovery progress
    await chrome.storage.local.set({
      [`hwc_recovery_progress_${contextId}`]: {
        status: 'discovering',
        totalActions: 0,
        recoveredActions: 0,
        failedActions: 0,
        errors: [],
      },
    });

    // Ensure executor is ready
    await executor.initialize();

    // Forward to offscreen for worker execution
    const dnaHashes = context.dnas.map(d => Array.from(toUint8Array(d.hash)));
    const agentPubKey = Array.from(toUint8Array(context.agentPubKey));

    const result = await executor.recoverChain(contextId, dnaHashes, agentPubKey);

    // Update final progress
    await chrome.storage.local.set({
      [`hwc_recovery_progress_${contextId}`]: {
        status: 'complete',
        ...result,
      },
    });

    // Mark recovery as run (opens retry window, will seal on first write)
    await happContextManager.markRecoveryRun(contextId);

    return createSuccessResponse(message.id, result);
  } catch (error) {
    return createErrorResponse(
      message.id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Handle GET_RECOVERY_PROGRESS request
 * Returns current recovery progress from chrome.storage.local
 */
async function handleGetRecoveryProgress(
  message: RequestMessage
): Promise<ResponseMessage> {
  try {
    const { contextId } = getPayload<MessageType.GET_RECOVERY_PROGRESS>(message);
    if (!contextId) {
      return createErrorResponse(message.id, "contextId is required");
    }

    const result = await chrome.storage.local.get(`hwc_recovery_progress_${contextId}`);
    const progress = result[`hwc_recovery_progress_${contextId}`] || {
      status: 'idle',
      totalActions: 0,
      recoveredActions: 0,
      failedActions: 0,
      errors: [],
    };
    return createSuccessResponse(message.id, progress);
  } catch (error) {
    return createErrorResponse(
      message.id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Handle LAIR_EXPORT_MNEMONIC request
 * Returns 24-word BIP-39 mnemonic for the specified key
 */
async function handleLairExportMnemonic(
  message: RequestMessage,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMessage> {
  const blocked = rejectTabSender(sender, message.id, "LAIR_EXPORT_MNEMONIC");
  if (blocked) return blocked;
  try {
    await ensureUnlocked();
    const { tag } = getPayload<MessageType.LAIR_EXPORT_MNEMONIC>(message);
    if (!tag) {
      return createErrorResponse(message.id, "tag is required");
    }
    const client = await getLairClient();
    const mnemonic = await client.exportSeedAsMnemonic(tag);
    return createSuccessResponse(message.id, { mnemonic });
  } catch (error) {
    return createErrorResponse(
      message.id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Handle LAIR_IMPORT_MNEMONIC request
 * Imports a key from a 24-word BIP-39 mnemonic phrase
 */
async function handleLairImportMnemonic(
  message: RequestMessage,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMessage> {
  const blocked = rejectTabSender(sender, message.id, "LAIR_IMPORT_MNEMONIC");
  if (blocked) return blocked;
  try {
    await ensureUnlocked();
    const { mnemonic, tag, exportable } = getPayload<MessageType.LAIR_IMPORT_MNEMONIC>(message);
    if (!mnemonic || !tag) {
      return createErrorResponse(message.id, "mnemonic and tag are required");
    }
    const client = await getLairClient();
    const result = await client.importSeedFromMnemonic(mnemonic, tag, exportable ?? true);
    return createSuccessResponse(message.id, result);
  } catch (error) {
    return createErrorResponse(
      message.id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Handle SIGN_RECONNECT_CHALLENGE requests.
 * Signs an ISO 8601 timestamp with the agent's ed25519 key for joining service reconnect.
 * Validates timestamp format and recency (±5 minutes) before signing.
 */
async function handleSignReconnectChallenge(
  message: RequestMessage,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMessage> {
  try {
    await ensureUnlocked();
    const payload = getPayload<MessageType.SIGN_RECONNECT_CHALLENGE>(message);
    if (!payload.timestamp) {
      return createErrorResponse(message.id, "timestamp is required");
    }

    // Validate timestamp format (must parse as a valid date)
    const parsed = new Date(payload.timestamp);
    if (isNaN(parsed.getTime())) {
      return createErrorResponse(message.id, "Invalid timestamp format — expected ISO 8601");
    }

    // Validate recency (±5 minutes)
    const MAX_DRIFT_MS = 5 * 60 * 1000;
    const drift = Math.abs(Date.now() - parsed.getTime());
    if (drift > MAX_DRIFT_MS) {
      return createErrorResponse(message.id, "Timestamp too far from current time (max ±5 minutes)");
    }

    // Get the agent's public key from the hApp context for this origin
    const origin = sender.tab?.url ? new URL(sender.tab.url).origin : undefined;
    if (!origin) {
      return createErrorResponse(message.id, "Cannot determine origin for signing");
    }

    const context = await happContextManager.getContextForDomain(origin);
    let agentPubKey: Uint8Array;
    if (context?.agentPubKey) {
      agentPubKey = toUint8Array(context.agentPubKey);
    } else {
      // Pre-install: key exists in Lair but no HappContext yet
      agentPubKey = await happContextManager.getOrCreateAgentKey(origin);
    }
    const ed25519Key = extractEd25519PubKey(agentPubKey);

    // Sign the timestamp string as UTF-8 bytes
    const timestampBytes = new TextEncoder().encode(payload.timestamp);
    const client = await getLairClient();
    const signature = await client.signByPubKey(ed25519Key, timestampBytes);

    return createSuccessResponse(message.id, { signature });
  } catch (error) {
    return createErrorResponse(
      message.id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Handle SIGN_JOINING_NONCE requests.
 * Signs opaque nonce bytes with the agent's ed25519 key for joining service
 * agent_whitelist verification. Validates nonce length (16-128 bytes).
 */
async function handleSignJoiningNonce(
  message: RequestMessage,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMessage> {
  try {
    await ensureUnlocked();
    const payload = getPayload<MessageType.SIGN_JOINING_NONCE>(message);
    if (!payload.nonce || !Array.isArray(payload.nonce) || payload.nonce.length === 0) {
      return createErrorResponse(message.id, "nonce is required and must be a non-empty byte array");
    }

    if (payload.nonce.length < 16 || payload.nonce.length > 128) {
      return createErrorResponse(message.id, "nonce must be 16-128 bytes");
    }

    const origin = sender.tab?.url ? new URL(sender.tab.url).origin : undefined;
    if (!origin) {
      return createErrorResponse(message.id, "Cannot determine origin for signing");
    }

    const context = await happContextManager.getContextForDomain(origin);
    let agentPubKey: Uint8Array;
    if (context?.agentPubKey) {
      agentPubKey = toUint8Array(context.agentPubKey);
    } else {
      // Pre-install: key exists in Lair but no HappContext yet
      agentPubKey = await happContextManager.getOrCreateAgentKey(origin);
    }
    const ed25519Key = extractEd25519PubKey(agentPubKey);

    const nonceBytes = new Uint8Array(payload.nonce);
    const client = await getLairClient();
    const signature = await client.signByPubKey(ed25519Key, nonceBytes);

    return createSuccessResponse(message.id, { signature });
  } catch (error) {
    return createErrorResponse(
      message.id,
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * Convert transport format action (arrays) back to stored action format (Uint8Arrays)
 */
function convertTransportActionToStored(transportAction: any): any {
  return {
    ...transportAction,
    actionHash: transportAction.actionHash ? new Uint8Array(transportAction.actionHash) : null,
    author: transportAction.author ? new Uint8Array(transportAction.author) : null,
    prevActionHash: transportAction.prevActionHash ? new Uint8Array(transportAction.prevActionHash) : null,
    signature: transportAction.signature ? new Uint8Array(transportAction.signature) : null,
    entryHash: transportAction.entryHash ? new Uint8Array(transportAction.entryHash) : undefined,
    originalActionHash: transportAction.originalActionHash ? new Uint8Array(transportAction.originalActionHash) : undefined,
    originalEntryHash: transportAction.originalEntryHash ? new Uint8Array(transportAction.originalEntryHash) : undefined,
    deletesActionHash: transportAction.deletesActionHash ? new Uint8Array(transportAction.deletesActionHash) : undefined,
    deletesEntryHash: transportAction.deletesEntryHash ? new Uint8Array(transportAction.deletesEntryHash) : undefined,
    baseAddress: transportAction.baseAddress ? new Uint8Array(transportAction.baseAddress) : undefined,
    targetAddress: transportAction.targetAddress ? new Uint8Array(transportAction.targetAddress) : undefined,
    tag: transportAction.tag ? new Uint8Array(transportAction.tag) : undefined,
    linkAddAddress: transportAction.linkAddAddress ? new Uint8Array(transportAction.linkAddAddress) : undefined,
    dnaHash: transportAction.dnaHash ? new Uint8Array(transportAction.dnaHash) : undefined,
    membraneProof: transportAction.membraneProof ? new Uint8Array(transportAction.membraneProof) : undefined,
    // Convert timestamp from string back to BigInt (was serialized as string for Chrome message passing)
    timestamp: BigInt(transportAction.timestamp || '0'),
  };
}

/**
 * Convert transport format entry (arrays) back to stored entry format (Uint8Arrays)
 */
function convertTransportEntryToStored(transportEntry: any): any {
  return {
    entryHash: new Uint8Array(transportEntry.entryHash),
    entryContent: new Uint8Array(transportEntry.entryContent),
    entryType: transportEntry.entryType,
  };
}

/**
 * Handle remote signal from offscreen document
 *
 * Per Holochain architecture, remote signals are delivered by invoking the
 * WASM's recv_remote_signal callback. The WASM decides whether to forward
 * to the UI by calling emit_signal().
 *
 * Flow: Linker → WebSocket → Background → WASM recv_remote_signal → emit_signal → UI
 */
async function handleRemoteSignal(signalData: {
  dna_hash: string;
  to_agent: string; // Target agent this signal is addressed to
  from_agent: string;
  zome_name: string;
  signal: number[]; // Uint8Array converted to array for transport
}): Promise<void> {
  logSignal.info(`handleRemoteSignal: dna=${signalData.dna_hash.substring(0, 15)}..., to=${signalData.to_agent.substring(0, 15)}..., from=${signalData.from_agent}, zome=${signalData.zome_name}, len=${signalData.signal.length}`);

  try {
    // Find the context for this agent
    const happContextManager = getHappContextManager();
    const contexts = await happContextManager.listContexts();

    // Find context with matching agent pubkey (to_agent)
    const { decodeHashFromBase64, encodeHashToBase64 } = await import("@holochain/client");
    const targetDnaHash = decodeHashFromBase64(signalData.dna_hash);

    logSignal.debug(`Searching ${contexts.length} contexts for agent match (to_agent: ${signalData.to_agent.substring(0, 15)}...)`);
    const context = contexts.find((ctx) => {
      // Compare agent pubkey - the context stores it as Uint8Array
      const ctxAgentB64 = encodeHashToBase64(toUint8Array(ctx.agentPubKey));
      const match = ctxAgentB64 === signalData.to_agent;
      logSignal.trace(`Checking context: ${ctx.id} (${ctx.domain}), agent=${ctxAgentB64.substring(0, 20)}... match=${match}`);
      return match;
    });

    if (!context) {
      logSignal.warn(`No context found for agent: ${signalData.to_agent.substring(0, 20)}...`);
      return;
    }

    logSignal.debug(`Found context for remote signal: ${context.id} (${context.domain})`);

    // The signal payload contains serialized ZomeCallParams which includes:
    // - zome_name: the actual zome to call (e.g., "profiles")
    // - fn_name: "recv_remote_signal"
    // - provenance: the sender's agent pubkey
    // - payload: the actual signal data (ExternIO)
    // We need to decode this to extract the real zome name and sender
    const signalPayloadBytes = new Uint8Array(signalData.signal);
    let zomeName: string;
    let provenance: AgentPubKey;
    let innerPayload: ExternIO;

    try {
      // Decode the ZomeCallParams from the signal payload
      // ZomeCallParams structure from holochain_zome_types::zome_io
      const zomeCallParams = decode(signalPayloadBytes) as {
        zome_name?: string;
        fn_name?: string;
        provenance?: AgentPubKey;
        payload?: ExternIO;
        cell_id?: CellId;
      };

      logSignal.trace("Decoded ZomeCallParams:", {
        zome_name: zomeCallParams.zome_name,
        fn_name: zomeCallParams.fn_name,
        has_provenance: !!zomeCallParams.provenance,
        has_payload: !!zomeCallParams.payload,
      });

      zomeName = zomeCallParams.zome_name || signalData.zome_name;
      provenance = zomeCallParams.provenance
        ? toUint8Array(zomeCallParams.provenance) as AgentPubKey
        : context.agentPubKey;
      // The payload inside ZomeCallParams is the actual signal to pass to recv_remote_signal
      innerPayload = zomeCallParams.payload
        ? toUint8Array(zomeCallParams.payload) as ExternIO
        : signalPayloadBytes as ExternIO;
    } catch (decodeError) {
      logSignal.warn("Failed to decode ZomeCallParams, using fallback:", decodeError);
      // Fallback to using the raw payload if decoding fails
      zomeName = signalData.zome_name;
      provenance = context.agentPubKey;
      innerPayload = signalPayloadBytes as ExternIO;
    }

    const zomeCallRequest: ZomeCallRequest = {
      dnaWasm: new Uint8Array(0), // Not used - offscreen fetches from storage
      cellId: [
        targetDnaHash,
        context.agentPubKey, // Local agent receives the signal
      ],
      zome: zomeName,
      fn: "recv_remote_signal",
      payload: innerPayload,
      provenance: provenance,
    };

    // Execute the zome call (fire-and-forget for the signal delivery itself)
    // If WASM calls emit_signal(), we'll deliver those to tabs
    const { result: _, signals } = await executor.executeZomeCall(
      context.id,
      zomeCallRequest
    );

    logSignal.debug(`recv_remote_signal completed, ${signals?.length || 0} signals emitted`);

    // Deliver any emitted signals to tabs matching this context's domain
    if (signals && signals.length > 0) {
      // Find tabs for this context's domain
      logSignal.trace(`Looking for tabs matching: ${context.domain}/*`);
      const tabs = await chrome.tabs.query({ url: `${context.domain}/*` });
      logSignal.debug(`Found ${tabs.length} tabs for domain ${context.domain}`);

      if (tabs.length === 0) {
        logSignal.warn(`No tabs found for domain: ${context.domain}`);
        return;
      }

      for (const tab of tabs) {
        if (!tab.id) continue;

        for (const signal of signals) {
          try {
            // Convert signal payload from Array back to Uint8Array and decode
            const signalBytes = Array.isArray(signal.signal)
              ? new Uint8Array(signal.signal)
              : toUint8Array(signal.signal);
            const decodedPayload = decode(signalBytes);

            // Format as Holochain AppSignal structure
            // Note: We use normalizeUint8Arrays instead of serializeForTransport
            // because apps expect Uint8Arrays in signal payloads (e.g., for AgentPubKey.subarray())
            // chrome.tabs.sendMessage supports structured cloning which preserves Uint8Array
            const appSignal = {
              type: "app",
              value: {
                cell_id: normalizeUint8Arrays(signal.cell_id),
                zome_name: signal.zome_name,
                payload: normalizeUint8Arrays(decodedPayload),
              },
            };

            logSignal.debug(`Sending signal to tab ${tab.id}`);
            chrome.tabs.sendMessage(tab.id, {
              type: "signal",
              payload: appSignal,
            }).catch(() => {
              // Ignore errors for tabs without content script
            });
          } catch (err) {
            logSignal.error("Error processing signal:", err);
          }
        }
      }
    }
  } catch (error) {
    logSignal.error("Error handling remote signal:", error);
    // Don't rethrow - remote signals are fire-and-forget
  }
}

/**
 * Handle sign request from offscreen document (forwarded from linker)
 *
 * This is part of the remote signing protocol for kitsune2 agent info.
 * The linker needs the browser to sign data because the private key
 * is stored in the browser's Lair keystore.
 */
async function handleSignRequest(request: {
  agent_pubkey: number[];
  message: number[];
}): Promise<{ success: boolean; signature?: number[]; error?: string }> {
  logLair.debug(`Sign request for agent (pubkey len: ${request.agent_pubkey.length})`);

  try {
    // Check if lair is locked
    const lock = getLairLock();
    if (await lock.isLocked()) {
      throw new Error("Lair is locked - cannot sign");
    }

    // Get or create lair client
    const client = await getLairClient();

    // Convert to Uint8Array
    const pubkeyBytes = new Uint8Array(request.agent_pubkey);

    // Handle both 32-byte Ed25519 keys and 39-byte AgentPubKeys
    let ed25519PubKey: Uint8Array;
    if (pubkeyBytes.length === 32) {
      // Already a raw Ed25519 key (from signSync in proxy)
      ed25519PubKey = pubkeyBytes;
    } else if (isAgentPubKey(pubkeyBytes)) {
      // 39-byte AgentPubKey - extract the Ed25519 key
      ed25519PubKey = extractEd25519PubKey(pubkeyBytes);
    } else {
      throw new Error(`Invalid public key: expected 32-byte Ed25519 or 39-byte AgentPubKey, got ${(pubkeyBytes as Uint8Array).length} bytes`);
    }

    // Debug: Log the key being requested and list all keys in Lair
    logLair.trace(`Looking for Ed25519 key: ${Array.from(ed25519PubKey.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('')}...`);
    const allEntries = await client.listEntries();
    logLair.trace(`Lair has ${allEntries.length} entries`);
    for (const entry of allEntries) {
      const entryKeyHex = Array.from(entry.ed25519_pub_key.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('');
      const matches = ed25519PubKey.every((b, i) => b === entry.ed25519_pub_key[i]);
      if (matches) {
        logLair.trace(`Found matching key: ${entry.tag}: ${entryKeyHex}...`);
      }
    }

    // Sign the message using the agent's key
    const messageBytes = new Uint8Array(request.message);
    const signature = await client.signByPubKey(ed25519PubKey, messageBytes);

    logLair.debug(`Signed successfully, signature length: ${signature.length}`);

    return {
      success: true,
      signature: Array.from(signature),
    };
  } catch (error) {
    logLair.error("Sign request failed:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
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
    log.trace("Received raw message:", rawMessage?.type, "from:", sender?.tab?.id);

    // Internal offscreen→background messages (OFFSCREEN_READY, REMOTE_SIGNAL,
    // WS_STATE_CHANGE, SIGN_REQUEST) are handled by the ChromeOffscreenExecutor's
    // own message listener. Skip them here.
    if (rawMessage.target === "background") {
      return false;
    }

    // Forward messages targeted to offscreen (e.g., from popup)
    if (rawMessage.target === "offscreen") {
      log.trace("Forwarding message to offscreen:", rawMessage.type);
      executor.initialize().then(() => {
        chrome.runtime.sendMessage(rawMessage).then((response) => {
          sendResponse(response);
        }).catch((error) => {
          log.error("Error forwarding to offscreen:", error);
          sendResponse({ success: false, error: String(error) });
        });
      }).catch((error) => {
        log.error("Error ensuring executor ready:", error);
        sendResponse({ success: false, error: String(error) });
      });
      return true; // Async response
    }

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
          log.error("Error in message handler:", error);
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
      log.error("Error processing message:", error);
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
