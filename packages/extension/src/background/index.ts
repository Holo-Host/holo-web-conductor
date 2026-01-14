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
  type GatewayConfigurePayload,
  type ContextIdPayload,
} from "../lib/messaging";
import { getLairLock } from "../lib/lair-lock";
import { getPermissionManager } from "../lib/permissions";
import { getAuthManager } from "../lib/auth-manager";
import { getHappContextManager } from "../lib/happ-context-manager";
import { createLairClient, type EncryptedExport } from "@fishy/lair";
import type { InstallHappRequest, HappContext } from "@fishy/core";
import {
  toUint8Array,
  normalizeUint8Arrays,
  serializeForTransport,
  isAgentPubKey,
  extractEd25519PubKey,
} from "@fishy/core";
import { encodeHashToBase64, type AgentPubKey, type CellId } from "@holochain/client";

// ExternIO is msgpack-encoded bytes - use Uint8Array as the underlying type
type ExternIO = Uint8Array;
import type { ZomeCallRequest } from "@fishy/core/ribosome";
import { encode, decode } from "@msgpack/msgpack";
import sodium from "libsodium-wrappers";
import { createLogger, setLogFilter, getLogFilter } from "../lib/logger";

// Expose filter control to globalThis for runtime debugging
// Usage in service worker console: setFishyLogFilter('Signal,CallZome') or fishyLogFilter = 'Signal'
(globalThis as any).setFishyLogFilter = setLogFilter;
(globalThis as any).getFishyLogFilter = getLogFilter;

// Create specialized loggers for different concerns
const log = createLogger('Background');
const logAuth = createLogger('Auth');
const logZome = createLogger('CallZome');
const logOffscreenMgr = createLogger('OffscreenMgr');
const logGateway = createLogger('Gateway');
const logSignal = createLogger('Signal');
const logLair = createLogger('Lair');
const logHapp = createLogger('HappContext');

log.info("Fishy background service worker loaded");

// ============================================================================
// Offscreen Document Management
// ============================================================================

const OFFSCREEN_DOCUMENT_PATH = "offscreen/offscreen.html";
let creatingOffscreen: Promise<void> | null = null;
let networkConfigured = false;
let offscreenReady = false;
let offscreenReadyResolvers: Array<() => void> = [];

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
 * Called when offscreen sends OFFSCREEN_READY message
 */
function markOffscreenReady(): void {
  offscreenReady = true;
  // Resolve any waiting promises
  for (const resolve of offscreenReadyResolvers) {
    resolve();
  }
  offscreenReadyResolvers = [];
}

/**
 * Wait for offscreen to be ready (with timeout)
 */
async function waitForOffscreenReady(timeoutMs: number = 5000): Promise<void> {
  if (offscreenReady) return;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      // Remove this resolver
      offscreenReadyResolvers = offscreenReadyResolvers.filter(r => r !== resolve);
      reject(new Error('Offscreen document ready timeout'));
    }, timeoutMs);

    offscreenReadyResolvers.push(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

/**
 * Create the offscreen document if it doesn't exist
 */
async function ensureOffscreenDocument(): Promise<void> {
  const exists = await hasOffscreenDocument();

  if (exists && offscreenReady) {
    logOffscreenMgr.debug("Offscreen document already exists and ready");
    return;
  }

  if (exists && !offscreenReady) {
    // Document exists but we haven't received ready signal
    // This can happen after extension reload - wait for ready or timeout
    logOffscreenMgr.debug("Offscreen exists but not ready, waiting...");
    try {
      await waitForOffscreenReady(3000);
      logOffscreenMgr.debug("Offscreen is now ready");
      return;
    } catch {
      // Timeout - document might be stale, close and recreate
      logOffscreenMgr.warn("Offscreen not ready after timeout, recreating...");
      await chrome.offscreen.closeDocument();
      offscreenReady = false;
    }
  }

  // Avoid creating multiple offscreen documents
  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  logOffscreenMgr.info("Creating offscreen document...");
  offscreenReady = false;
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: [chrome.offscreen.Reason.WORKERS],
    justification: "Running WASM with synchronous network access for zome calls",
  });

  await creatingOffscreen;
  creatingOffscreen = null;
  logOffscreenMgr.info("Offscreen document created, waiting for ready...");

  // Wait for offscreen to signal ready
  try {
    await waitForOffscreenReady(10000);
    logOffscreenMgr.info("Offscreen document ready");
  } catch {
    logOffscreenMgr.error("Offscreen document failed to become ready");
    throw new Error("Offscreen document initialization failed");
  }

  // Configure network if we have a gateway URL
  if (gatewayConfig && !networkConfigured) {
    await configureOffscreenNetwork(gatewayConfig);
  }
}

/**
 * Configure the network service in the offscreen document
 */
async function configureOffscreenNetwork(config: { gatewayUrl: string; sessionToken?: string }): Promise<void> {
  logGateway.info(`Configuring offscreen network with gateway: ${config.gatewayUrl}`);

  try {
    await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "CONFIGURE_NETWORK",
      gatewayUrl: config.gatewayUrl,
      sessionToken: config.sessionToken,
    });
    networkConfigured = true;
    logGateway.info("Offscreen network configured");
  } catch (error) {
    logGateway.error("Failed to configure offscreen network:", error);
  }
}

/**
 * Set the gateway configuration
 * Call this to enable network requests via hc-http-gw
 */
function setGatewayConfig(url: string, sessionToken?: string): void {
  gatewayConfig = { gatewayUrl: url, sessionToken };
  networkConfigured = false; // Will be configured on next offscreen use

  logGateway.info(`Gateway config set: ${url}`);
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
      logGateway.debug("Session token updated in offscreen");
    } catch (error) {
      logGateway.error("Failed to update session token:", error);
    }
  }
}

/**
 * Register an agent with the gateway for signal forwarding
 * This tells the gateway's WebSocket service to forward signals for this dna/agent to us
 */
async function registerAgentWithGateway(dnaHash: Uint8Array, agentPubKey: Uint8Array): Promise<void> {
  if (!networkConfigured) {
    logGateway.debug("Skipping agent registration - network not configured");
    return;
  }

  // Debug: log the raw bytes
  logGateway.trace(`registerAgentWithGateway - dnaHash bytes (first 10):`, Array.from(dnaHash.slice(0, 10)));
  logGateway.trace(`registerAgentWithGateway - agentPubKey bytes (first 10):`, Array.from(agentPubKey.slice(0, 10)));
  logGateway.trace(`registerAgentWithGateway - dnaHash length: ${dnaHash.length}, agentPubKey length: ${agentPubKey.length}`);
  // Log Ed25519 key that would be used for signing (bytes 3-35 of AgentPubKey)
  if (agentPubKey.length === 39) {
    const ed25519Key = agentPubKey.slice(3, 35);
    logGateway.trace(`registerAgentWithGateway - Ed25519 key (first 8 bytes): ${Array.from(ed25519Key.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join('')}`);
  }

  const dnaHashB64 = encodeHashToBase64(dnaHash);
  const agentPubKeyB64 = encodeHashToBase64(agentPubKey);
  logGateway.info(`Registering agent with gateway: dna=${dnaHashB64.substring(0, 15)}..., agent=${agentPubKeyB64.substring(0, 15)}...`);

  try {
    await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "REGISTER_AGENT",
      dna_hash: dnaHashB64,
      agent_pubkey: agentPubKeyB64,
    });
    logGateway.debug("Agent registered with gateway");
  } catch (error) {
    logGateway.error("Failed to register agent with gateway:", error);
  }
}

/**
 * Register all agents from a hApp context with the gateway
 * If a DNA hash override is configured, register with that instead of the context's DNA hash
 */
async function registerContextAgentsWithGateway(context: HappContext): Promise<void> {
  logGateway.trace(`registerContextAgentsWithGateway - context.agentPubKey type:`, typeof context.agentPubKey, context.agentPubKey?.constructor?.name);

  const agentPubKey = toUint8Array(context.agentPubKey);
  logGateway.trace(`registerContextAgentsWithGateway - after toUint8Array, length: ${agentPubKey.length}`);

  for (const dna of context.dnas) {
    const dnaHash = toUint8Array(dna.hash);
    await registerAgentWithGateway(dnaHash, agentPubKey);
  }
}

/**
 * Register an agent with the gateway using a base64 DNA hash string
 */
async function registerAgentWithGatewayByB64(dnaHashB64: string, agentPubKey: Uint8Array): Promise<void> {
  if (!networkConfigured) {
    logGateway.debug("Skipping agent registration - network not configured");
    return;
  }

  const agentPubKeyB64 = encodeHashToBase64(agentPubKey);
  logGateway.info(`Registering agent with gateway (override): dna=${dnaHashB64.substring(0, 15)}..., agent=${agentPubKeyB64.substring(0, 15)}...`);

  try {
    await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "REGISTER_AGENT",
      dna_hash: dnaHashB64,
      agent_pubkey: agentPubKeyB64,
    });
    logGateway.debug("Agent registered with gateway");
  } catch (error) {
    logGateway.error("Failed to register agent with gateway:", error);
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
  const perfStart = performance.now();

  await ensureOffscreenDocument();
  const afterOffscreen = performance.now();

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

  const afterBuild = performance.now();
  logZome.info(`Sending zome call to offscreen: ${zomeCallRequest.zome}::${zomeCallRequest.fn} (context: ${contextId})`);

  const response = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "EXECUTE_ZOME_CALL",
    requestId,
    zomeCallRequest: minimalRequest,
  });
  const afterMessage = performance.now();

  log.perf(`executeZomeCallViaOffscreen breakdown: ensureOffscreen=${(afterOffscreen - perfStart).toFixed(1)}ms, buildRequest=${(afterBuild - afterOffscreen).toFixed(1)}ms, sendMessage=${(afterMessage - afterBuild).toFixed(1)}ms, TOTAL=${(afterMessage - perfStart).toFixed(1)}ms`);

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
    logAuth.debug(`Origin ${origin} already approved`);
    return createSuccessResponse(message.id, {
      connected: true,
      origin,
    });
  }

  if (permission?.granted === false) {
    // Previously denied
    logAuth.debug(`Origin ${origin} was previously denied`);
    return createErrorResponse(
      message.id,
      "Connection denied. This site was previously denied access to Fishy."
    );
  }

  // No permission set - create authorization request and open popup
  logAuth.info(`No permission for ${origin} - opening authorization popup`);

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

    // Serialize payload to MessagePack
    const payloadBytes = new Uint8Array(encode(normalizedPayload));
    logZome.trace(`Payload serialized: ${payloadBytes.length} bytes`);
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
    const { result: transportSafeResult, signals } = await executeZomeCallViaOffscreen(context.id, zomeCallRequest);
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

    // Update last used timestamp
    await happContextManager.touchContext(context.id);
    const afterSignals = performance.now();

    log.perf(`handleCallZome breakdown: validation=${(afterValidation - handleStart).toFixed(1)}ms, permission=${(afterPermission - afterValidation).toFixed(1)}ms, getContext=${(afterContext - afterPermission).toFixed(1)}ms, prepare=${(afterPrepare - afterContext).toFixed(1)}ms, offscreen=${(afterOffscreen - beforeOffscreen).toFixed(1)}ms, signals=${(afterSignals - afterOffscreen).toFixed(1)}ms, TOTAL=${(afterSignals - handleStart).toFixed(1)}ms`);

    return createSuccessResponse(message.id, transportSafeResult);
  } catch (error) {
    logZome.error("Error in handleCallZome:", error);
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
    logHapp.info("Install hApp request from:", origin);

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

    // Register agents with gateway for signal forwarding
    // Do this asynchronously - don't block the install response
    registerContextAgentsWithGateway(context).catch((err) => {
      logGateway.warn("Failed to register agents with gateway:", err);
    });

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
    const { passphrase } = getPayload<MessageType.LAIR_SET_PASSPHRASE>(message);
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
    const { passphrase } = getPayload<MessageType.LAIR_UNLOCK>(message);
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
  message: RequestMessage
): Promise<ResponseMessage> {
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
  message: RequestMessage
): Promise<ResponseMessage> {
  try {
    await ensureUnlocked();
    const payload = getPayload<MessageType.LAIR_SIGN>(message);
    if (!payload.pubKey || !payload.data) {
      return createErrorResponse(message.id, "pubKey and data are required");
    }

    // Convert serialized Uint8Arrays back to actual Uint8Arrays
    const pubKey = toUint8Array(payload.pubKey);
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
  message: RequestMessage
): Promise<ResponseMessage> {
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
  message: RequestMessage
): Promise<ResponseMessage> {
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
      srcIndex,
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
  message: RequestMessage
): Promise<ResponseMessage> {
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
  message: RequestMessage
): Promise<ResponseMessage> {
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
  message: RequestMessage
): Promise<ResponseMessage> {
  try {
    const { requestId, origin } = getPayload<MessageType.PERMISSION_GRANT>(message);

    if (!requestId || !origin) {
      return createErrorResponse(message.id, "requestId and origin are required");
    }

    // Grant permission
    await permissionManager.grantPermission(origin);
    logAuth.info(`Permission granted for ${origin}`);

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
    const { requestId, origin } = getPayload<MessageType.PERMISSION_DENY>(message);

    if (!requestId || !origin) {
      return createErrorResponse(message.id, "requestId and origin are required");
    }

    // Deny permission
    await permissionManager.denyPermission(origin);
    logAuth.info(`Permission denied for ${origin}`);

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
    const { origin } = getPayload<MessageType.PERMISSION_REVOKE>(message);

    if (!origin) {
      return createErrorResponse(message.id, "origin is required");
    }

    await permissionManager.revokePermission(origin);
    logAuth.info(`Permission revoked for ${origin}`);

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
    const { gatewayUrl } = getPayload<MessageType.GATEWAY_CONFIGURE>(message);

    if (!gatewayUrl) {
      return createErrorResponse(message.id, "gatewayUrl is required");
    }

    setGatewayConfig(gatewayUrl);

    // Create offscreen document if needed (so WebSocket service can connect)
    // and configure network
    await ensureOffscreenDocument();
    logGateway.debug(`networkConfigured = ${networkConfigured}`);
    if (!networkConfigured) {
      await configureOffscreenNetwork({ gatewayUrl });
    } else {
      logGateway.debug("Network already configured, skipping");
    }

    // Register agents for existing hApp contexts
    const contexts = await happContextManager.listContexts();
    for (const context of contexts) {
      if (context.enabled) {
        registerContextAgentsWithGateway(context).catch((err) => {
          logGateway.warn(`Failed to register agents for ${context.id}:`, err);
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
 * Handle remote signal from offscreen document
 *
 * Per Holochain architecture, remote signals are delivered by invoking the
 * WASM's recv_remote_signal callback. The WASM decides whether to forward
 * to the UI by calling emit_signal().
 *
 * Flow: Gateway → WebSocket → Background → WASM recv_remote_signal → emit_signal → UI
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
    const { result: _, signals } = await executeZomeCallViaOffscreen(
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
 * Handle sign request from offscreen document (forwarded from gateway)
 *
 * This is part of the remote signing protocol for kitsune2 agent info.
 * The gateway needs the browser to sign data because the private key
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
      throw new Error(`Invalid public key: expected 32-byte Ed25519 or 39-byte AgentPubKey, got ${pubkeyBytes.length} bytes`);
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

    // Handle internal messages from offscreen document
    if (rawMessage.target === "background") {
      if (rawMessage.type === "OFFSCREEN_READY") {
        markOffscreenReady();
        return false;
      }

      if (rawMessage.type === "REMOTE_SIGNAL") {
        handleRemoteSignal(rawMessage).then(() => {
          sendResponse({ success: true });
        }).catch((error) => {
          logSignal.error("Error handling remote signal:", error);
          sendResponse({ success: false, error: String(error) });
        });
        return true; // Async response
      }

      if (rawMessage.type === "WS_STATE_CHANGE") {
        logGateway.debug(`WebSocket state changed: ${rawMessage.state}`);
        return false;
      }

      if (rawMessage.type === "SIGN_REQUEST") {
        // Forward sign request to Lair
        handleSignRequest(rawMessage).then((result) => {
          sendResponse(result);
        }).catch((error) => {
          logLair.error("Sign request error:", error);
          sendResponse({ success: false, error: String(error) });
        });
        return true; // Async response
      }

      // Unknown internal message
      return false;
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
