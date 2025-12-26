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
} from "../lib/messaging";
import { getLairLock } from "../lib/lair-lock";
import { getPermissionManager } from "../lib/permissions";
import { getAuthManager } from "../lib/auth-manager";
import { getHappContextManager } from "../lib/happ-context-manager";
import { createLairClient, type EncryptedExport } from "@fishy/lair";
import type { InstallHappRequest } from "@fishy/core";
import sodium from "libsodium-wrappers";

console.log("Fishy background service worker loaded");

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
 * TODO(Step 5): Implement WASM execution
 */
async function handleCallZome(
  message: RequestMessage,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMessage> {
  console.log("Zome call request:", message.payload);

  // For Step 1, return a mock response
  return createSuccessResponse(message.id, {
    mock: true,
    message: "Zome call not yet implemented",
  });
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
    if (!request || !request.dnas || request.dnas.length === 0) {
      return createErrorResponse(message.id, "Invalid install request - dnas required");
    }

    // Convert any serialized Uint8Arrays back to actual Uint8Arrays
    const normalizedRequest: InstallHappRequest = {
      appName: request.appName,
      appVersion: request.appVersion,
      dnas: request.dnas.map((dna) => ({
        hash: toUint8Array(dna.hash),
        wasm: toUint8Array(dna.wasm),
        name: dna.name,
        properties: dna.properties,
      })),
    };

    const context = await happContextManager.installHapp(origin, normalizedRequest);

    return createSuccessResponse(message.id, {
      contextId: context.id,
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
