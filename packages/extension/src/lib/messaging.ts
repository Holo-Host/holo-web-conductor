/**
 * Messaging protocol for communication between web pages and extension
 *
 * Message flow:
 * 1. Page → Content Script (via window.postMessage)
 * 2. Content Script → Background (via chrome.runtime.sendMessage)
 * 3. Background → Content Script (via chrome.tabs.sendMessage)
 * 4. Content Script → Page (via window.postMessage)
 */

/**
 * Message types supported by the Holochain API
 */
export enum MessageType {
  // Connection management
  CONNECT = "connect",
  DISCONNECT = "disconnect",

  // Holochain conductor operations
  CALL_ZOME = "call_zome",
  APP_INFO = "app_info",
  SIGNAL = "signal",

  // Responses
  SUCCESS = "success",
  ERROR = "error",
}

/**
 * Base message structure
 */
export interface BaseMessage {
  type: MessageType;
  id: string; // Unique message ID for request/response matching
  timestamp: number;
}

/**
 * Request message from page to extension
 */
export interface RequestMessage extends BaseMessage {
  type:
    | MessageType.CONNECT
    | MessageType.DISCONNECT
    | MessageType.CALL_ZOME
    | MessageType.APP_INFO;
  payload?: unknown;
}

/**
 * Response message from extension to page
 */
export interface ResponseMessage extends BaseMessage {
  type: MessageType.SUCCESS | MessageType.ERROR;
  requestId: string; // ID of the original request
  payload?: unknown;
  error?: string;
}

/**
 * Signal message from extension to page (not a response to request)
 */
export interface SignalMessage extends BaseMessage {
  type: MessageType.SIGNAL;
  payload: unknown;
}

/**
 * Union type for all messages
 */
export type Message = RequestMessage | ResponseMessage | SignalMessage;

/**
 * Message envelope used for content script ↔ background communication
 * Includes sender tab information
 */
export interface MessageEnvelope {
  message: Message;
  sender?: {
    tabId?: number;
    frameId?: number;
    url?: string;
  };
}

/**
 * Zome call request payload
 */
export interface ZomeCallPayload {
  cell_id: [Uint8Array, Uint8Array]; // [dna_hash, agent_pub_key]
  zome_name: string;
  fn_name: string;
  payload: unknown;
  provenance: Uint8Array; // agent_pub_key
  cap_secret?: Uint8Array | null;
}

/**
 * App info request payload
 */
export interface AppInfoPayload {
  installed_app_id: string;
}

/**
 * Generate a unique message ID
 */
export function generateMessageId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Create a request message
 */
export function createRequest(
  type: RequestMessage["type"],
  payload?: unknown
): RequestMessage {
  return {
    type,
    id: generateMessageId(),
    timestamp: Date.now(),
    payload,
  };
}

/**
 * Create a success response
 */
export function createSuccessResponse(
  requestId: string,
  payload?: unknown
): ResponseMessage {
  return {
    type: MessageType.SUCCESS,
    id: generateMessageId(),
    requestId,
    timestamp: Date.now(),
    payload,
  };
}

/**
 * Create an error response
 */
export function createErrorResponse(
  requestId: string,
  error: string
): ResponseMessage {
  return {
    type: MessageType.ERROR,
    id: generateMessageId(),
    requestId,
    timestamp: Date.now(),
    error,
  };
}

/**
 * Create a signal message
 */
export function createSignal(payload: unknown): SignalMessage {
  return {
    type: MessageType.SIGNAL,
    id: generateMessageId(),
    timestamp: Date.now(),
    payload,
  };
}

/**
 * Type guard to check if message is a request
 */
export function isRequestMessage(message: Message): message is RequestMessage {
  return (
    message.type === MessageType.CONNECT ||
    message.type === MessageType.DISCONNECT ||
    message.type === MessageType.CALL_ZOME ||
    message.type === MessageType.APP_INFO
  );
}

/**
 * Type guard to check if message is a response
 */
export function isResponseMessage(message: Message): message is ResponseMessage {
  return (
    message.type === MessageType.SUCCESS || message.type === MessageType.ERROR
  );
}

/**
 * Type guard to check if message is a signal
 */
export function isSignalMessage(message: Message): message is SignalMessage {
  return message.type === MessageType.SIGNAL;
}

/**
 * Serialize a message for transmission
 * Handles Uint8Array conversion to base64
 */
export function serializeMessage(message: Message): string {
  // Deep clone and convert Uint8Arrays to base64
  const serializable = JSON.parse(
    JSON.stringify(message, (_key, value) => {
      if (value instanceof Uint8Array) {
        return {
          __type: "Uint8Array",
          data: Array.from(value),
        };
      }
      return value;
    })
  );
  return JSON.stringify(serializable);
}

/**
 * Deserialize a message from transmission
 * Handles base64 to Uint8Array conversion
 */
export function deserializeMessage(data: string): Message {
  return JSON.parse(data, (_key, value) => {
    if (
      value &&
      typeof value === "object" &&
      value.__type === "Uint8Array" &&
      Array.isArray(value.data)
    ) {
      return new Uint8Array(value.data);
    }
    return value;
  });
}
