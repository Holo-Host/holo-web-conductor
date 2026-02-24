/**
 * Messaging protocol for communication between web pages and extension
 *
 * Message flow:
 * 1. Page → Content Script (via window.postMessage)
 * 2. Content Script → Background (via chrome.runtime.sendMessage)
 * 3. Background → Content Script (via chrome.tabs.sendMessage)
 * 4. Content Script → Page (via window.postMessage)
 */

import type {
  AgentPubKey,
  CellId,
  Signature,
} from '@holochain/client';

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

  // Lair keystore - Lock/unlock
  LAIR_GET_LOCK_STATE = "lair_get_lock_state",
  LAIR_SET_PASSPHRASE = "lair_set_passphrase",
  LAIR_UNLOCK = "lair_unlock",
  LAIR_LOCK = "lair_lock",

  // Lair keystore - Keypair management
  LAIR_NEW_SEED = "lair_new_seed",
  LAIR_LIST_ENTRIES = "lair_list_entries",
  LAIR_GET_ENTRY = "lair_get_entry",
  LAIR_DELETE_ENTRY = "lair_delete_entry",

  // Lair keystore - Operations
  LAIR_SIGN = "lair_sign_by_pub_key",
  LAIR_VERIFY = "lair_verify_signature",
  LAIR_DERIVE_SEED = "lair_derive_seed",

  // Lair keystore - Export/import
  LAIR_EXPORT_SEED = "lair_export_seed",
  LAIR_IMPORT_SEED = "lair_import_seed",

  // Authorization/Permissions
  PERMISSION_GRANT = "permission_grant",
  PERMISSION_DENY = "permission_deny",
  PERMISSION_LIST = "permission_list",
  PERMISSION_REVOKE = "permission_revoke",
  AUTH_REQUEST_INFO = "auth_request_info",

  // hApp Context Management
  INSTALL_HAPP = "install_happ",
  UNINSTALL_HAPP = "uninstall_happ",
  LIST_HAPPS = "list_happs",
  ENABLE_HAPP = "enable_happ",
  DISABLE_HAPP = "disable_happ",
  PROVIDE_MEMPROOFS = "provide_memproofs",

  // Linker Configuration (for network requests via h2hc-linker)
  LINKER_CONFIGURE = "linker_configure",
  LINKER_GET_STATUS = "linker_get_status",
  LINKER_DISCONNECT = "linker_disconnect",
  LINKER_RECONNECT = "linker_reconnect",

  // Connection status (real-time health monitoring)
  CONNECTION_STATUS_GET = "connection_status_get",
  CONNECTION_STATUS_SUBSCRIBE = "connection_status_subscribe",
  CONNECTION_STATUS_UNSUBSCRIBE = "connection_status_unsubscribe",

  // DHT Publishing Debug (per-hApp)
  PUBLISH_GET_STATUS = "publish_get_status",
  PUBLISH_RETRY_FAILED = "publish_retry_failed",
  PUBLISH_ALL_RECORDS = "publish_all_records",

  // Seed phrase backup/restore
  LAIR_EXPORT_MNEMONIC = "lair_export_mnemonic",
  LAIR_IMPORT_MNEMONIC = "lair_import_mnemonic",

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
    | MessageType.APP_INFO
    | MessageType.LAIR_GET_LOCK_STATE
    | MessageType.LAIR_SET_PASSPHRASE
    | MessageType.LAIR_UNLOCK
    | MessageType.LAIR_LOCK
    | MessageType.LAIR_NEW_SEED
    | MessageType.LAIR_LIST_ENTRIES
    | MessageType.LAIR_GET_ENTRY
    | MessageType.LAIR_DELETE_ENTRY
    | MessageType.LAIR_SIGN
    | MessageType.LAIR_VERIFY
    | MessageType.LAIR_DERIVE_SEED
    | MessageType.LAIR_EXPORT_SEED
    | MessageType.LAIR_IMPORT_SEED
    | MessageType.PERMISSION_GRANT
    | MessageType.PERMISSION_DENY
    | MessageType.PERMISSION_LIST
    | MessageType.PERMISSION_REVOKE
    | MessageType.AUTH_REQUEST_INFO
    | MessageType.INSTALL_HAPP
    | MessageType.UNINSTALL_HAPP
    | MessageType.LIST_HAPPS
    | MessageType.ENABLE_HAPP
    | MessageType.DISABLE_HAPP
    | MessageType.PROVIDE_MEMPROOFS
    | MessageType.LINKER_CONFIGURE
    | MessageType.LINKER_GET_STATUS
    | MessageType.LINKER_DISCONNECT
    | MessageType.LINKER_RECONNECT
    | MessageType.CONNECTION_STATUS_GET
    | MessageType.CONNECTION_STATUS_SUBSCRIBE
    | MessageType.CONNECTION_STATUS_UNSUBSCRIBE
    | MessageType.PUBLISH_GET_STATUS
    | MessageType.PUBLISH_RETRY_FAILED
    | MessageType.PUBLISH_ALL_RECORDS
    | MessageType.LAIR_EXPORT_MNEMONIC
    | MessageType.LAIR_IMPORT_MNEMONIC;
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

// ============================================================================
// Request Payload Types
// ============================================================================

/**
 * Zome call request payload
 */
export interface ZomeCallPayload {
  cell_id: CellId;
  zome_name: string;
  fn_name: string;
  payload: unknown;
  provenance: AgentPubKey;
  cap_secret?: Uint8Array | null; // CapSecret not exported by @holochain/client
}

/**
 * App info request payload
 */
export interface AppInfoPayload {
  installed_app_id: string;
}

/**
 * Install hApp request payload
 */
export interface InstallHappPayload {
  happBundle: Uint8Array;
  membraneProofs?: Record<string, Uint8Array | number[]>;
}

/**
 * Provide membrane proofs payload
 */
export interface ProvideMemproofsPayload {
  contextId: string;
  memproofs: Record<string, Uint8Array>;
}

/**
 * Context ID payload (used by uninstall, enable, disable)
 */
export interface ContextIdPayload {
  contextId: string;
}

/**
 * Passphrase payload (used by set_passphrase, unlock)
 */
export interface PassphrasePayload {
  passphrase: string;
}

/**
 * New seed request payload
 */
export interface NewSeedPayload {
  tag: string;
  exportable?: boolean;
}

/**
 * Tag-only payload (used by get_entry, delete_entry)
 */
export interface TagPayload {
  tag: string;
}

/**
 * Sign request payload
 */
export interface SignPayload {
  pubKey: AgentPubKey;
  data: Uint8Array;
}

/**
 * Verify signature payload
 */
export interface VerifyPayload {
  pubKey: AgentPubKey;
  signature: Signature;
  data: Uint8Array;
}

/**
 * Derive seed payload
 */
export interface DeriveSeedPayload {
  srcTag: string;
  srcIndex: number;
  dstTag: string;
  exportable?: boolean;
}

/**
 * Export seed payload
 */
export interface ExportSeedPayload {
  tag: string;
  passphrase: string;
}

/**
 * Import seed payload
 */
export interface ImportSeedPayload {
  tag: string;
  exportable: boolean;
  passphrase: string;
  encrypted: {
    salt: Uint8Array;
    nonce: Uint8Array;
    cipher: Uint8Array;
  };
}

/**
 * Permission grant/deny payload
 */
export interface PermissionDecisionPayload {
  requestId: string;
  origin: string;
}

/**
 * Origin-only payload
 */
export interface OriginPayload {
  origin: string;
}

/**
 * Request ID only payload
 */
export interface RequestIdPayload {
  requestId: string;
}

/**
 * Linker configure payload
 */
export interface LinkerConfigurePayload {
  linkerUrl: string;
}

/**
 * Publish status counts response payload
 */
export interface PublishStatusPayload {
  pending: number;
  inFlight: number;
  failed: number;
}

/**
 * Export mnemonic payload
 */
export interface ExportMnemonicPayload {
  tag: string;
}

/**
 * Import mnemonic payload
 */
export interface ImportMnemonicPayload {
  mnemonic: string;
  tag: string;
  exportable?: boolean;
}

// ============================================================================
// Response Payload Types
// ============================================================================

/**
 * Lock state response payload
 */
export interface LockStatePayload {
  isLocked: boolean;
  hasPassphrase: boolean;
}

/**
 * Entry info for lair entries
 */
export interface EntryInfo {
  tag: string;
  seedType: 'Ed25519' | 'X25519';
  exportable: boolean;
  pubKey: AgentPubKey;
}

/**
 * List entries response payload
 */
export interface ListEntriesPayload {
  entries: EntryInfo[];
}

/**
 * Signature response payload
 */
export interface SignaturePayload {
  signature: Signature;
}

/**
 * Verify response payload
 */
export interface VerifyResultPayload {
  valid: boolean;
}

/**
 * Encrypted export response payload
 */
export interface EncryptedExportPayload {
  encrypted: {
    salt: Uint8Array;
    nonce: Uint8Array;
    cipher: Uint8Array;
  };
}

/**
 * Auth request info response payload
 */
export interface AuthRequestInfoPayload {
  origin: string;
  timestamp: number;
}

/**
 * Permissions list response payload
 */
export interface PermissionsListPayload {
  permissions: Array<{
    origin: string;
    permissions: string[];
    timestamp: number;
  }>;
}

// ============================================================================
// Discriminated Union Types for Type-Safe Message Handling
// ============================================================================

/**
 * Map of message types to their payload types (request)
 */
export interface RequestPayloadMap {
  [MessageType.CONNECT]: undefined;
  [MessageType.DISCONNECT]: undefined;
  [MessageType.CALL_ZOME]: ZomeCallPayload;
  [MessageType.APP_INFO]: AppInfoPayload;
  [MessageType.LAIR_GET_LOCK_STATE]: undefined;
  [MessageType.LAIR_SET_PASSPHRASE]: PassphrasePayload;
  [MessageType.LAIR_UNLOCK]: PassphrasePayload;
  [MessageType.LAIR_LOCK]: undefined;
  [MessageType.LAIR_NEW_SEED]: NewSeedPayload;
  [MessageType.LAIR_LIST_ENTRIES]: undefined;
  [MessageType.LAIR_GET_ENTRY]: TagPayload;
  [MessageType.LAIR_DELETE_ENTRY]: TagPayload;
  [MessageType.LAIR_SIGN]: SignPayload;
  [MessageType.LAIR_VERIFY]: VerifyPayload;
  [MessageType.LAIR_DERIVE_SEED]: DeriveSeedPayload;
  [MessageType.LAIR_EXPORT_SEED]: ExportSeedPayload;
  [MessageType.LAIR_IMPORT_SEED]: ImportSeedPayload;
  [MessageType.PERMISSION_GRANT]: PermissionDecisionPayload;
  [MessageType.PERMISSION_DENY]: PermissionDecisionPayload;
  [MessageType.PERMISSION_LIST]: undefined;
  [MessageType.PERMISSION_REVOKE]: OriginPayload;
  [MessageType.AUTH_REQUEST_INFO]: RequestIdPayload;
  [MessageType.INSTALL_HAPP]: InstallHappPayload;
  [MessageType.UNINSTALL_HAPP]: ContextIdPayload;
  [MessageType.LIST_HAPPS]: undefined;
  [MessageType.ENABLE_HAPP]: ContextIdPayload;
  [MessageType.DISABLE_HAPP]: ContextIdPayload;
  [MessageType.PROVIDE_MEMPROOFS]: ProvideMemproofsPayload;
  [MessageType.LINKER_CONFIGURE]: LinkerConfigurePayload;
  [MessageType.LINKER_GET_STATUS]: undefined;
  [MessageType.LINKER_DISCONNECT]: undefined;
  [MessageType.LINKER_RECONNECT]: undefined;
  [MessageType.CONNECTION_STATUS_GET]: undefined;
  [MessageType.CONNECTION_STATUS_SUBSCRIBE]: undefined;
  [MessageType.CONNECTION_STATUS_UNSUBSCRIBE]: undefined;
  [MessageType.PUBLISH_GET_STATUS]: ContextIdPayload;
  [MessageType.PUBLISH_RETRY_FAILED]: ContextIdPayload;
  [MessageType.PUBLISH_ALL_RECORDS]: ContextIdPayload;
  [MessageType.LAIR_EXPORT_MNEMONIC]: ExportMnemonicPayload;
  [MessageType.LAIR_IMPORT_MNEMONIC]: ImportMnemonicPayload;
}

/**
 * Helper type to get payload type for a specific message type
 */
export type PayloadFor<T extends keyof RequestPayloadMap> = RequestPayloadMap[T];

/**
 * Create a typed request message
 */
export function createTypedRequest<T extends keyof RequestPayloadMap>(
  type: T,
  payload: RequestPayloadMap[T]
): RequestMessage & { payload: RequestPayloadMap[T] } {
  return {
    type,
    id: generateMessageId(),
    timestamp: Date.now(),
    payload,
  } as RequestMessage & { payload: RequestPayloadMap[T] };
}

/**
 * Extract typed payload from a request message.
 * Use this in message handlers for type-safe payload access.
 *
 * @example
 * case MessageType.INSTALL_HAPP: {
 *   const payload = getPayload<MessageType.INSTALL_HAPP>(message);
 *   // payload is typed as InstallHappPayload
 *   const { happBundle } = payload;
 * }
 */
export function getPayload<T extends keyof RequestPayloadMap>(
  message: RequestMessage
): RequestPayloadMap[T] {
  return message.payload as RequestPayloadMap[T];
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
    message.type === MessageType.APP_INFO ||
    message.type === MessageType.LAIR_GET_LOCK_STATE ||
    message.type === MessageType.LAIR_SET_PASSPHRASE ||
    message.type === MessageType.LAIR_UNLOCK ||
    message.type === MessageType.LAIR_LOCK ||
    message.type === MessageType.LAIR_NEW_SEED ||
    message.type === MessageType.LAIR_LIST_ENTRIES ||
    message.type === MessageType.LAIR_GET_ENTRY ||
    message.type === MessageType.LAIR_DELETE_ENTRY ||
    message.type === MessageType.LAIR_SIGN ||
    message.type === MessageType.LAIR_VERIFY ||
    message.type === MessageType.LAIR_DERIVE_SEED ||
    message.type === MessageType.LAIR_EXPORT_SEED ||
    message.type === MessageType.LAIR_IMPORT_SEED ||
    message.type === MessageType.PERMISSION_GRANT ||
    message.type === MessageType.PERMISSION_DENY ||
    message.type === MessageType.PERMISSION_LIST ||
    message.type === MessageType.PERMISSION_REVOKE ||
    message.type === MessageType.AUTH_REQUEST_INFO ||
    message.type === MessageType.INSTALL_HAPP ||
    message.type === MessageType.UNINSTALL_HAPP ||
    message.type === MessageType.LIST_HAPPS ||
    message.type === MessageType.ENABLE_HAPP ||
    message.type === MessageType.DISABLE_HAPP ||
    message.type === MessageType.PROVIDE_MEMPROOFS ||
    message.type === MessageType.LINKER_CONFIGURE ||
    message.type === MessageType.LINKER_GET_STATUS ||
    message.type === MessageType.LINKER_DISCONNECT ||
    message.type === MessageType.LINKER_RECONNECT ||
    message.type === MessageType.CONNECTION_STATUS_GET ||
    message.type === MessageType.CONNECTION_STATUS_SUBSCRIBE ||
    message.type === MessageType.CONNECTION_STATUS_UNSUBSCRIBE ||
    message.type === MessageType.PUBLISH_GET_STATUS ||
    message.type === MessageType.PUBLISH_RETRY_FAILED ||
    message.type === MessageType.PUBLISH_ALL_RECORDS ||
    message.type === MessageType.LAIR_EXPORT_MNEMONIC ||
    message.type === MessageType.LAIR_IMPORT_MNEMONIC
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
