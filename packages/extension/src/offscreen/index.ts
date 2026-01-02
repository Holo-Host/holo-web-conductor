/**
 * Offscreen Document Script
 *
 * This script runs in an offscreen document which has full DOM access,
 * including the ability to make synchronous XMLHttpRequest calls.
 *
 * Architecture:
 * - Offscreen spawns a Ribosome Worker that runs WASM + SQLite together
 * - SQLite has direct synchronous access in the worker (OPFS)
 * - Network calls come back here for synchronous XHR
 * - Worker uses Atomics.wait to block while we do sync XHR
 * - WebSocket service handles remote signal forwarding from gateway
 */

import { encode, decode } from "@msgpack/msgpack";
import { getHappContextStorage } from "../lib/happ-context-storage";
import {
  WebSocketNetworkService,
  type ConnectionState,
} from "@fishy/core/network";
import { toUint8Array, normalizeUint8Arrays, serializeForTransport } from "@fishy/core";

console.log("[Offscreen] Document loaded");

// Ribosome worker instance
let ribosomeWorker: Worker | null = null;
let workerReady = false;
let workerInitPromise: Promise<void> | null = null;

// WebSocket service for remote signals
let wsService: WebSocketNetworkService | null = null;

// SharedArrayBuffers for synchronous network communication
const NETWORK_SIGNAL_SIZE = 8; // 2 int32s
const NETWORK_RESULT_SIZE = 1024 * 1024; // 1MB for response body
let networkSignalBuffer: SharedArrayBuffer | null = null;
let networkSignalView: Int32Array | null = null;
let networkResultBuffer: SharedArrayBuffer | null = null;

// Pending worker requests
const pendingRequests = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
let nextRequestId = 1;

// Network configuration
let gatewayUrl: string = '';
let sessionToken: string | null = null;
let dnaHashOverride: string | null = null;

// Track which DNA WASMs have been sent to the worker
// This avoids sending 1.3MB on every call - only send once per DNA
const sentWasmHashes = new Set<string>();

function getDnaHashKey(dnaHash: Uint8Array | number[]): string {
  const bytes = Array.isArray(dnaHash) ? dnaHash : Array.from(dnaHash);
  return btoa(String.fromCharCode(...bytes));
}

// Initialize storage access (shared IndexedDB with background) - for hApp context only
const storage = getHappContextStorage();

/**
 * Initialize the ribosome worker
 */
async function initRibosomeWorker(): Promise<void> {
  if (workerReady) return;
  if (workerInitPromise) return workerInitPromise;

  workerInitPromise = (async () => {
    console.log("[Offscreen] Initializing ribosome worker...");

    // Create SharedArrayBuffers for network synchronization
    networkSignalBuffer = new SharedArrayBuffer(NETWORK_SIGNAL_SIZE);
    networkSignalView = new Int32Array(networkSignalBuffer);
    networkResultBuffer = new SharedArrayBuffer(NETWORK_RESULT_SIZE);

    // Create worker
    const workerUrl = chrome.runtime.getURL("offscreen/ribosome-worker.js");
    console.log("[Offscreen] Worker URL:", workerUrl);

    ribosomeWorker = new Worker(workerUrl);

    // Handle messages from worker
    ribosomeWorker.onmessage = handleWorkerMessage;
    ribosomeWorker.onerror = (error) => {
      console.error("[Offscreen] Worker error:", error);
    };

    // Wait for worker to signal ready
    await new Promise<void>((resolve) => {
      const checkReady = (event: MessageEvent) => {
        if (event.data.type === 'READY') {
          ribosomeWorker!.removeEventListener('message', checkReady);
          resolve();
        }
      };
      ribosomeWorker!.addEventListener('message', checkReady);
    });

    // Initialize worker with shared buffers
    await sendToWorker('INIT', {
      networkSignalBuffer,
      networkResultBuffer,
    });

    workerReady = true;
    console.log("[Offscreen] Ribosome worker initialized with SQLite");

    // Send any existing network configuration to the worker
    if (gatewayUrl || sessionToken || dnaHashOverride) {
      console.log("[Offscreen] Sending existing network config to worker:", gatewayUrl);
      await sendToWorker('CONFIGURE_NETWORK', { gatewayUrl, sessionToken, dnaHashOverride });
    }
  })();

  return workerInitPromise;
}

/**
 * Handle messages from ribosome worker
 */
function handleWorkerMessage(event: MessageEvent): void {
  const { id, type, success, result, error } = event.data;

  // Handle network request from worker
  if (type === 'NETWORK_REQUEST') {
    handleNetworkRequest(event.data);
    return;
  }

  // Handle response to our request
  if (id !== undefined) {
    const pending = pendingRequests.get(id);
    if (pending) {
      pendingRequests.delete(id);
      if (success) {
        pending.resolve(result);
      } else {
        pending.reject(new Error(error || 'Unknown error'));
      }
    }
  }
}

/**
 * Handle network request from worker - do sync XHR and signal back
 */
function handleNetworkRequest(request: { id: number; method: string; url: string; headers?: Record<string, string>; body?: number[] }): void {
  console.log("[Offscreen] Handling network request:", request.method, request.url);

  try {
    // Build full URL
    let fullUrl = request.url;
    if (!fullUrl.startsWith('http')) {
      fullUrl = gatewayUrl + request.url;
    }

    // Add session token and DNA hash override to headers
    const headers = { ...(request.headers || {}) };
    if (sessionToken) {
      headers['Authorization'] = `Bearer ${sessionToken}`;
    }
    if (dnaHashOverride) {
      headers['X-Holochain-Dna-Hash'] = dnaHashOverride;
    }

    // Make synchronous XHR
    // Note: Sync XHR cannot use responseType='arraybuffer', must use responseText
    const xhr = new XMLHttpRequest();
    xhr.open(request.method, fullUrl, false); // false = synchronous

    for (const [key, value] of Object.entries(headers)) {
      xhr.setRequestHeader(key, value);
    }

    if (request.body) {
      xhr.send(new Uint8Array(request.body));
    } else {
      xhr.send();
    }

    // Write response to shared buffer
    // For sync XHR we get responseText, convert to UTF-8 bytes
    const responseText = xhr.responseText || '';
    const responseBody = new TextEncoder().encode(responseText);
    const dv = new DataView(networkResultBuffer!);
    dv.setInt32(0, xhr.status);
    dv.setInt32(4, responseBody.length);
    new Uint8Array(networkResultBuffer!, 8).set(responseBody);

    console.log("[Offscreen] Network response:", xhr.status, responseBody.length, "bytes");

    // Signal worker
    Atomics.store(networkSignalView!, 0, 1);
    Atomics.notify(networkSignalView!, 0);

  } catch (error) {
    console.error("[Offscreen] Network request failed:", error);

    // Write error response
    const dv = new DataView(networkResultBuffer!);
    dv.setInt32(0, 500);
    dv.setInt32(4, 0);

    Atomics.store(networkSignalView!, 0, 1);
    Atomics.notify(networkSignalView!, 0);
  }
}

/**
 * Send message to worker and wait for response
 */
function sendToWorker(type: string, payload?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!ribosomeWorker) {
      reject(new Error('Worker not initialized'));
      return;
    }

    const id = nextRequestId++;
    pendingRequests.set(id, { resolve, reject });
    ribosomeWorker.postMessage({ id, type, payload });
  });
}

/**
 * Initialize WebSocket service for remote signals
 */
function initializeWebSocketService(config: {
  gatewayUrl: string;
  sessionToken?: string;
}): void {
  // Convert HTTP URL to WebSocket URL
  const wsUrl = config.gatewayUrl
    .replace(/^http:/, 'ws:')
    .replace(/^https:/, 'wss:')
    .replace(/\/$/, '') + '/ws';

  console.log(`[Offscreen] Initializing WebSocket service: ${wsUrl}`);

  wsService = new WebSocketNetworkService({
    gatewayWsUrl: wsUrl,
    sessionToken: config.sessionToken,
  });

  // Set up signal callback to forward signals to background
  wsService.onSignal((signal) => {
    console.log(`[Offscreen] Received remote signal from ${signal.from_agent}`);

    // Forward to background script which will dispatch to the right tab
    chrome.runtime.sendMessage({
      target: "background",
      type: "REMOTE_SIGNAL",
      dna_hash: signal.dna_hash,
      from_agent: signal.from_agent,
      zome_name: signal.zome_name,
      signal: Array.from(signal.signal), // Convert Uint8Array for transport
    }).catch((err) => {
      console.warn("[Offscreen] Failed to forward signal:", err);
    });
  });

  // Set up state change callback for logging
  wsService.onStateChange((state: ConnectionState) => {
    console.log(`[Offscreen] WebSocket state: ${state}`);

    // Notify background of connection state changes
    chrome.runtime.sendMessage({
      target: "background",
      type: "WS_STATE_CHANGE",
      state,
    }).catch(() => {
      // Ignore errors if background is not listening
    });
  });

  // Connect to gateway
  wsService.connect();
}

/**
 * Minimal zome call request - only includes data that can't be fetched from storage
 */
interface MinimalZomeCallRequest {
  contextId: string;
  dnaHashBase64: string;
  cellId: [any, any];
  zome: string;
  fn: string;
  payload: any;
  provenance: any;
}

/**
 * Execute a zome call via the ribosome worker
 */
async function executeZomeCall(request: MinimalZomeCallRequest): Promise<{ result: unknown; signals: any[] }> {
  const perfStart = performance.now();
  console.log(`[Offscreen] Executing zome call: ${request.zome}::${request.fn}`);

  // Ensure worker is initialized
  await initRibosomeWorker();
  const afterWorkerInit = performance.now();

  // Fetch the full hApp context from storage
  console.log(`[Offscreen] Fetching context: ${request.contextId}`);
  const context = await storage.getContext(request.contextId);
  const afterContextFetch = performance.now();
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
  const afterDnaLookup = performance.now();

  // Check if we've already sent this WASM to the worker
  const dnaHashKey = getDnaHashKey(request.cellId[0]);
  const wasmAlreadySent = sentWasmHashes.has(dnaHashKey);

  // Only send WASM on first call for this DNA - worker caches it
  const dnaWasmToSend = wasmAlreadySent ? [] : Array.from(toUint8Array(dna.wasm));
  if (!wasmAlreadySent) {
    sentWasmHashes.add(dnaHashKey);
    console.log(`[Offscreen] Sending WASM to worker (first time for this DNA)`);
  } else {
    console.log(`[Offscreen] Skipping WASM send (already cached in worker)`);
  }

  // Send to worker
  const result = await sendToWorker('CALL_ZOME', {
    dnaWasm: dnaWasmToSend,
    cellId: [
      Array.from(toUint8Array(request.cellId[0])),
      Array.from(toUint8Array(request.cellId[1])),
    ],
    zome: request.zome,
    fn: request.fn,
    payloadBytes: Array.from(toUint8Array(request.payload)),
    provenance: Array.from(toUint8Array(request.provenance)),
    dnaManifest: dna.manifest ? normalizeUint8Arrays(dna.manifest) : undefined,
  });
  const afterWorker = performance.now();

  console.log(`[PERF Offscreen] executeZomeCall breakdown:
   ├─ workerInit:    ${(afterWorkerInit - perfStart).toFixed(1)}ms
   ├─ contextFetch:  ${(afterContextFetch - afterWorkerInit).toFixed(1)}ms
   ├─ dnaLookup:     ${(afterDnaLookup - afterContextFetch).toFixed(1)}ms
   ├─ workerCall:    ${(afterWorker - afterDnaLookup).toFixed(1)}ms
   └─ TOTAL:         ${(afterWorker - perfStart).toFixed(1)}ms`);

  return {
    result: result.result,
    signals: result.signals || [],
  };
}

/**
 * Message types for communication with background script
 */
interface OffscreenMessage {
  target: "offscreen";
  type: "EXECUTE_ZOME_CALL" | "CONFIGURE_NETWORK" | "UPDATE_SESSION_TOKEN" | "SET_DNA_HASH_OVERRIDE";
  requestId: string;
  zomeCallRequest?: MinimalZomeCallRequest;
  gatewayUrl?: string;
  sessionToken?: string;
  dnaHashOverride?: string;
}

interface OffscreenResponse {
  success: boolean;
  requestId: string;
  result?: unknown;
  signals?: any[];
  error?: string;
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
      gatewayUrl = message.gatewayUrl || '';
      sessionToken = message.sessionToken || null;
      dnaHashOverride = message.dnaHashOverride || null;

      console.log(`[Offscreen] Network configured: ${gatewayUrl}`);
      if (dnaHashOverride) {
        console.log(`[Offscreen] DNA hash override: ${dnaHashOverride.substring(0, 20)}...`);
      }

      // Also configure the worker if it's ready
      if (workerReady && ribosomeWorker) {
        sendToWorker('CONFIGURE_NETWORK', { gatewayUrl, sessionToken, dnaHashOverride })
          .catch(console.error);
      }

      // Initialize WebSocket service for remote signals
      if (gatewayUrl && !wsService) {
        initializeWebSocketService({ gatewayUrl, sessionToken: sessionToken || undefined });
      } else if (wsService && sessionToken) {
        wsService.setSessionToken(sessionToken);
      }

      sendResponse({ success: true, requestId: message.requestId || "config" });
      return true;
    }

    if (message.type === "UPDATE_SESSION_TOKEN") {
      sessionToken = message.sessionToken || null;
      if (workerReady && ribosomeWorker) {
        sendToWorker('CONFIGURE_NETWORK', { gatewayUrl, sessionToken, dnaHashOverride })
          .catch(console.error);
      }
      if (wsService) {
        wsService.setSessionToken(sessionToken || "");
      }
      sendResponse({ success: true, requestId: message.requestId || "token" });
      return true;
    }

    if (message.type === "REGISTER_AGENT") {
      if (wsService) {
        wsService.registerAgent(message.dna_hash, message.agent_pubkey);
        sendResponse({ success: true, requestId: message.requestId || "register" });
      } else {
        sendResponse({ success: false, error: "WebSocket service not initialized", requestId: message.requestId || "register" });
      }
      return true;
    }

    if (message.type === "UNREGISTER_AGENT") {
      if (wsService) {
        wsService.unregisterAgent(message.dna_hash, message.agent_pubkey);
        sendResponse({ success: true, requestId: message.requestId || "unregister" });
      } else {
        sendResponse({ success: false, error: "WebSocket service not initialized", requestId: message.requestId || "unregister" });
      }
      return true;
    }

    if (message.type === "GET_WS_STATE") {
      sendResponse({
        success: true,
        requestId: message.requestId || "state",
        state: wsService?.getState() || "disconnected",
        isConnected: wsService?.isConnected() || false,
        registrations: wsService?.getRegistrations() || [],
      } as any);
      return true;
    }

    if (message.type === "SET_DNA_HASH_OVERRIDE") {
      dnaHashOverride = message.dnaHashOverride || null;
      if (workerReady && ribosomeWorker) {
        sendToWorker('CONFIGURE_NETWORK', { gatewayUrl, sessionToken, dnaHashOverride })
          .catch(console.error);
      }
      sendResponse({ success: true, requestId: message.requestId || "dna-override" });
      return true;
    }

    if (message.type === "EXECUTE_ZOME_CALL") {
      const { requestId, zomeCallRequest } = message;

      executeZomeCall(zomeCallRequest)
        .then(({ result, signals }) => {
          // Unwrap Ok/Err and decode the inner msgpack value
          // holochain-client API returns the unwrapped value, not {Ok: ...}
          let unwrappedResult = result;
          if (result && typeof result === 'object') {
            if ('Ok' in result) {
              const okValue = (result as any).Ok;
              if (okValue instanceof Uint8Array) {
                try {
                  unwrappedResult = decode(okValue);
                } catch (e) {
                  console.warn('[Offscreen] Failed to decode Ok value:', e);
                  unwrappedResult = okValue;
                }
              } else {
                unwrappedResult = okValue;
              }
            } else if ('Err' in result) {
              // For errors, throw so they're handled as errors
              const errValue = (result as any).Err;
              let errMessage = errValue;
              if (errValue instanceof Uint8Array) {
                try {
                  errMessage = decode(errValue);
                } catch (e) {
                  errMessage = String(errValue);
                }
              }
              throw new Error(typeof errMessage === 'string' ? errMessage : JSON.stringify(errMessage));
            }
          }

          const transportResult = serializeForTransport(unwrappedResult);
          const transportSignals = signals.map((sig: any) => ({
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

// Start worker initialization
initRibosomeWorker().catch(console.error);

// Notify background that offscreen document is ready
console.log("[Offscreen] Sending ready signal");
chrome.runtime.sendMessage({ target: "background", type: "OFFSCREEN_READY" });
