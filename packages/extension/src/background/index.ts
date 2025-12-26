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
import { createLairClient, type EncryptedExport } from "@fishy/lair";
import sodium from "libsodium-wrappers";

console.log("Fishy background service worker loaded");

// Singleton instances
const lairLock = getLairLock();
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
 * TODO(Step 3): Implement authorization flow
 */
async function handleConnect(
  message: RequestMessage,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMessage> {
  console.log("Connect request from:", sender.tab?.url);

  // For Step 1, just acknowledge the connection
  return createSuccessResponse(message.id, {
    connected: true,
    url: sender.tab?.url,
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
 * TODO(Step 4): Implement hApp context
 */
async function handleAppInfo(
  message: RequestMessage,
  sender: chrome.runtime.MessageSender
): Promise<ResponseMessage> {
  console.log("App info request:", message.payload);

  // For Step 1, return a mock response
  return createSuccessResponse(message.id, {
    mock: true,
    message: "App info not yet implemented",
  });
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
