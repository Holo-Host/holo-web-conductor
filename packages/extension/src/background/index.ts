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

console.log("Fishy background service worker loaded");

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
