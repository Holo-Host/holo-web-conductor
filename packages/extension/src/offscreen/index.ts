/**
 * Offscreen Document Script
 *
 * This script runs in an offscreen document which has full DOM access,
 * including the ability to make synchronous XMLHttpRequest calls.
 *
 * WASM execution happens here so that host functions can make synchronous
 * network calls during zome execution.
 */

import { callZome, type ZomeCallRequest } from "@fishy/core/ribosome";
import { decodeResult } from "../utils/result-decoder";
import { encode, decode } from "@msgpack/msgpack";
import { getHappContextStorage } from "../lib/happ-context-storage";
import { SyncXHRNetworkService, setNetworkService } from "@fishy/core/network";

console.log("[Offscreen] Document loaded");

// Network service will be initialized when we receive configuration
let networkService: SyncXHRNetworkService | null = null;

// Initialize storage access (shared IndexedDB with background)
const storage = getHappContextStorage();

/**
 * Minimal zome call request - only includes data that can't be fetched from storage
 */
interface MinimalZomeCallRequest {
  contextId: string;
  dnaHashBase64: string;
  cellId: [any, any]; // [dnaHash, agentPubKey] - serialized as arrays
  zome: string;
  fn: string;
  payload: any; // serialized as array
  provenance: any; // serialized as array
}

/**
 * Message types for communication with background script
 */
interface OffscreenMessage {
  target: "offscreen";
  type: "EXECUTE_ZOME_CALL";
  requestId: string;
  zomeCallRequest: MinimalZomeCallRequest;
}

interface OffscreenResponse {
  success: boolean;
  requestId: string;
  result?: unknown;
  signals?: Array<{
    cell_id: [Uint8Array, Uint8Array];
    zome_name: string;
    signal: Uint8Array;
  }>;
  error?: string;
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
  if (typeof data === "object" && data !== null) {
    // Serialized Uint8Array comes as object with numeric keys
    return new Uint8Array(Object.values(data) as number[]);
  }
  throw new Error("Cannot convert to Uint8Array");
}

/**
 * Recursively normalize Uint8Arrays in nested data structures
 */
function normalizeUint8Arrays(data: any): any {
  if (data === null || data === undefined) {
    return data;
  }

  if (
    typeof data === "object" &&
    !Array.isArray(data) &&
    !(data instanceof Uint8Array)
  ) {
    const keys = Object.keys(data);
    const isUint8ArrayLike =
      keys.length > 0 &&
      keys.every((k, i) => k === String(i)) &&
      keys.every((k) => typeof data[k] === "number");

    if (isUint8ArrayLike) {
      return new Uint8Array(Object.values(data) as number[]);
    }

    const normalized: any = {};
    for (const [key, value] of Object.entries(data)) {
      normalized[key] = normalizeUint8Arrays(value);
    }
    return normalized;
  }

  if (Array.isArray(data)) {
    return data.map(normalizeUint8Arrays);
  }

  return data;
}

/**
 * Convert Uint8Arrays to regular Arrays for Chrome message passing
 */
function serializeForTransport(data: any): any {
  if (data === null || data === undefined) {
    return data;
  }

  if (data instanceof Uint8Array) {
    return Array.from(data);
  }

  if (Array.isArray(data)) {
    return data.map(serializeForTransport);
  }

  if (typeof data === "object") {
    const serialized: any = {};
    for (const [key, value] of Object.entries(data)) {
      serialized[key] = serializeForTransport(value);
    }
    return serialized;
  }

  return data;
}

/**
 * Execute a zome call
 *
 * This runs in the offscreen document where synchronous XHR is available,
 * allowing host functions to make network calls during WASM execution.
 *
 * Instead of receiving WASM through message passing (which has size limits),
 * we fetch it from IndexedDB which is shared with the background script.
 */
async function executeZomeCall(
  request: MinimalZomeCallRequest
): Promise<{ result: unknown; signals: any[] }> {
  console.log(
    `[Offscreen] Executing zome call: ${request.zome}::${request.fn}`
  );

  // Fetch the full hApp context from storage
  console.log(`[Offscreen] Fetching context: ${request.contextId}`);
  const context = await storage.getContext(request.contextId);
  if (!context) {
    throw new Error(`Context not found: ${request.contextId}`);
  }

  // Find the DNA by hash
  const dnaHash = toUint8Array(request.cellId[0]);
  const dna = context.dnas.find((d) => {
    const storedHash = toUint8Array(d.hash);
    return storedHash.length === dnaHash.length &&
      storedHash.every((byte, i) => byte === dnaHash[i]);
  });

  if (!dna) {
    throw new Error(`DNA not found for hash: ${request.dnaHashBase64}`);
  }

  console.log(`[Offscreen] Found DNA: ${dna.name}, WASM size: ${dna.wasm.length} bytes`);

  // Convert arrays back to Uint8Arrays and build full ZomeCallRequest
  const normalizedRequest: ZomeCallRequest = {
    dnaWasm: toUint8Array(dna.wasm),
    cellId: [
      toUint8Array(request.cellId[0]),
      toUint8Array(request.cellId[1]),
    ],
    zome: request.zome,
    fn: request.fn,
    payload: toUint8Array(request.payload),
    provenance: toUint8Array(request.provenance),
    dnaManifest: dna.manifest ? normalizeUint8Arrays(dna.manifest) : undefined,
  };

  console.log(`[Offscreen] WASM size: ${normalizedRequest.dnaWasm.length} bytes, has manifest: ${!!normalizedRequest.dnaManifest}`);

  // Execute via ribosome
  const zomeCallResult = await callZome(normalizedRequest);
  console.log(`[Offscreen] ZomeCallResult received:`, zomeCallResult);

  const { result: zomeResult, signals } = zomeCallResult;

  // Unwrap Result<T, E> - throw if Err
  if (zomeResult && typeof zomeResult === "object" && "Err" in zomeResult) {
    const errorMsg =
      typeof zomeResult.Err === "string"
        ? zomeResult.Err
        : JSON.stringify(zomeResult.Err);
    throw new Error(`Zome call failed: ${errorMsg}`);
  }

  // Extract Ok value if present
  const unwrappedResult =
    zomeResult && typeof zomeResult === "object" && "Ok" in zomeResult
      ? zomeResult.Ok
      : zomeResult;

  // Decode the msgpack-wrapped result
  const decodedResult =
    unwrappedResult instanceof Uint8Array
      ? decodeResult(unwrappedResult)
      : unwrappedResult;

  console.log(`[Offscreen] Decoded result:`, decodedResult);

  return {
    result: decodedResult,
    signals: signals || [],
  };
}

/**
 * Handle messages from the background script
 */
chrome.runtime.onMessage.addListener(
  (
    message: any,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: OffscreenResponse) => void
  ) => {
    console.log("[Offscreen] Received message:", message);

    if (message.target !== "offscreen") {
      return false;
    }

    if (message.type === "CONFIGURE_NETWORK") {
      const { gatewayUrl, sessionToken, dnaHashOverride } = message;
      initializeNetworkService({ gatewayUrl, sessionToken, dnaHashOverride });
      sendResponse({ success: true, requestId: message.requestId || "config" });
      return true;
    }

    if (message.type === "UPDATE_SESSION_TOKEN") {
      updateSessionToken(message.sessionToken);
      sendResponse({ success: true, requestId: message.requestId || "token" });
      return true;
    }

    if (message.type === "SET_DNA_HASH_OVERRIDE") {
      updateDnaHashOverride(message.dnaHashOverride);
      sendResponse({ success: true, requestId: message.requestId || "dna-override" });
      return true;
    }

    if (message.type === "EXECUTE_ZOME_CALL") {
      const { requestId, zomeCallRequest } = message;

      executeZomeCall(zomeCallRequest)
        .then(({ result, signals }) => {
          // Serialize for transport
          const transportResult = serializeForTransport(result);
          const transportSignals = signals.map((sig) => ({
            cell_id: serializeForTransport(sig.cell_id),
            zome_name: sig.zome_name,
            signal: serializeForTransport(sig.signal),
          }));

          sendResponse({
            success: true,
            requestId,
            result: transportResult,
            signals: transportSignals,
          });
        })
        .catch((error) => {
          console.error("[Offscreen] Zome call error:", error);
          sendResponse({
            success: false,
            requestId,
            error: error instanceof Error ? error.message : String(error),
          });
        });

      return true; // Keep channel open for async response
    }

    return false;
  }
);

/**
 * Initialize network service with gateway configuration
 */
function initializeNetworkService(config: {
  gatewayUrl: string;
  sessionToken?: string;
  dnaHashOverride?: string;
}): void {
  console.log(`[Offscreen] Initializing network service with gateway: ${config.gatewayUrl}`);
  if (config.dnaHashOverride) {
    console.log(`[Offscreen] Using DNA hash override: ${config.dnaHashOverride.substring(0, 20)}...`);
  }

  networkService = new SyncXHRNetworkService({
    gatewayUrl: config.gatewayUrl,
    sessionToken: config.sessionToken,
    dnaHashOverride: config.dnaHashOverride,
  });

  // Make it available to cascade lookups
  setNetworkService(networkService);

  console.log("[Offscreen] Network service initialized");
}

/**
 * Update session token (after authentication)
 */
function updateSessionToken(token: string | null): void {
  if (networkService) {
    networkService.setSessionToken(token);
    console.log(`[Offscreen] Session token ${token ? 'set' : 'cleared'}`);
  }
}

/**
 * Update DNA hash override (for testing when extension's DNA hash differs from gateway's)
 */
function updateDnaHashOverride(hash: string | null): void {
  if (networkService) {
    networkService.setDnaHashOverride(hash);
  }
}

// Notify background that offscreen document is ready
console.log("[Offscreen] Sending ready signal");
chrome.runtime.sendMessage({ target: "background", type: "OFFSCREEN_READY" });
