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
 * - WebSocket service handles remote signal forwarding from linker
 */

import { encode, decode } from "@msgpack/msgpack";
import { getHappContextStorage } from "../lib/happ-context-storage";
import {
  WebSocketNetworkService,
  type ConnectionState,
} from "@hwc/core/network";
import { PublishService } from "@hwc/core/dht";
import { toUint8Array, normalizeUint8Arrays, serializeForTransport } from "@hwc/core";
import { encodeHashToBase64, decodeHashFromBase64 } from "@holochain/client";
import type { Record as HolochainRecord, DnaHash } from "@holochain/client";
import { createLogger, setLogFilter, getLogFilter } from "../lib/logger";

// Create loggers for different concerns
const log = createLogger('Offscreen');
const logNetwork = createLogger('Network');
const logSignal = createLogger('Signal');
const logPublish = createLogger('Publish');
const logZome = createLogger('ZomeCall');

// Ribosome worker instance (declared early for setHwcLogFilter)
let ribosomeWorker: Worker | null = null;

// Set log filter for offscreen AND worker
function setAllLogFilters(filter: string): void {
  // Set offscreen filter (this also saves to chrome.storage)
  setLogFilter(filter);

  // Forward to worker if initialized
  forwardLogFilterToWorker(filter);
}

function forwardLogFilterToWorker(filter: string): void {
  if (ribosomeWorker) {
    ribosomeWorker.postMessage({
      id: 0, // No response needed
      type: 'SET_LOG_FILTER',
      payload: { filter },
    });
  }
}

// Listen for runtime messages to forward log filter to worker
// (Any context sets filter -> runtime message -> all contexts including offscreen -> forward to worker)
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'HWC_LOG_FILTER_CHANGE') {
      forwardLogFilterToWorker(message.filter);
    }
  });
}

// Expose filter control to window for runtime debugging
// Usage: setHwcLogFilter('Signal') or setHwcLogFilter('')
(globalThis as any).setHwcLogFilter = setAllLogFilters;
(globalThis as any).getHwcLogFilter = getLogFilter;

log.info("Document loaded");
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

// SharedArrayBuffers for synchronous signing
// Signal: Int32Array[0] = status (0=waiting, 1=complete)
// Result: [success: 1 byte] [length: 4 bytes] [data: variable - signature or error]
const SIGN_SIGNAL_SIZE = 8; // 2 int32s
const SIGN_RESULT_SIZE = 1024; // Room for 64-byte signature or error message
let signSignalBuffer: SharedArrayBuffer | null = null;
let signSignalView: Int32Array | null = null;
let signResultBuffer: SharedArrayBuffer | null = null;

// Pending worker requests
const pendingRequests = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
let nextRequestId = 1;

// Network configuration
let linkerUrl: string = '';
let sessionToken: string | null = null;

// Recovery context tracking (for progress forwarding)
let activeRecoveryContextId: string | null = null;


// Publish service for DHT publishing
let publishService: PublishService | null = null;

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
    log.info("Initializing ribosome worker...");

    // Create SharedArrayBuffers for network synchronization
    networkSignalBuffer = new SharedArrayBuffer(NETWORK_SIGNAL_SIZE);
    networkSignalView = new Int32Array(networkSignalBuffer);
    networkResultBuffer = new SharedArrayBuffer(NETWORK_RESULT_SIZE);

    // Create SharedArrayBuffers for signing synchronization
    signSignalBuffer = new SharedArrayBuffer(SIGN_SIGNAL_SIZE);
    signSignalView = new Int32Array(signSignalBuffer);
    signResultBuffer = new SharedArrayBuffer(SIGN_RESULT_SIZE);

    // Create worker
    const workerUrl = chrome.runtime.getURL("offscreen/ribosome-worker.js");
    log.info("Worker URL:", workerUrl);

    ribosomeWorker = new Worker(workerUrl);

    // Handle messages from worker
    ribosomeWorker.onmessage = handleWorkerMessage;
    ribosomeWorker.onerror = (error) => {
      log.error("Worker error:", error);
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

    // Initialize worker with shared buffers (network + signing)
    await sendToWorker('INIT', {
      networkSignalBuffer,
      networkResultBuffer,
      signSignalBuffer,
      signResultBuffer,
    });

    workerReady = true;
    log.info("Ribosome worker initialized with SQLite");

    // Send any existing network configuration to the worker
    if (linkerUrl || sessionToken) {
      log.info("Sending existing network config to worker:", linkerUrl);
      await sendToWorker('CONFIGURE_NETWORK', { linkerUrl, sessionToken });
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

  // Handle sign request from worker
  if (type === 'SIGN_REQUEST') {
    handleSignRequest(event.data);
    return;
  }

  // Handle remote signals from worker (fire-and-forget)
  if (type === 'SEND_REMOTE_SIGNALS') {
    handleSendRemoteSignals(event.data);
    return;
  }

  // Forward recovery progress to background so the popup can poll it
  if (type === 'RECOVER_CHAIN_PROGRESS') {
    const progress = event.data.progress;
    if (progress && activeRecoveryContextId) {
      chrome.runtime.sendMessage({
        target: 'background',
        type: 'RECOVER_CHAIN_PROGRESS',
        contextId: activeRecoveryContextId,
        progress,
      }).catch(() => {
        // Background may not be listening yet; safe to ignore
      });
    }
    return;
  }

  // Handle response to our request
  if (id !== undefined) {
    const pending = pendingRequests.get(id);
    log.debug(`Worker response received: id=${id}, success=${success}, hasPending=${!!pending}, type=${type || 'response'}`);
    if (pending) {
      pendingRequests.delete(id);
      if (success) {
        log.debug(`Resolving pending request ${id} with result keys: ${result ? Object.keys(result).join(', ') : 'null'}`);
        pending.resolve(result);
      } else {
        log.debug(`Rejecting pending request ${id} with error: ${error}`);
        pending.reject(new Error(error || 'Unknown error'));
      }
    } else {
      log.warn(`No pending request found for id ${id}. Pending IDs: ${Array.from(pendingRequests.keys()).join(', ')}`);
    }
  }
}

/**
 * Handle network request from worker - do sync XHR and signal back
 */
function handleNetworkRequest(request: { id: number; method: string; url: string; headers?: Record<string, string>; body?: number[] }): void {
  log.info("Handling network request:", request.method, request.url);

  try {
    // Build full URL
    let fullUrl = request.url;
    if (!fullUrl.startsWith('http')) {
      fullUrl = linkerUrl + request.url;
    }

    // Add session token to headers
    const headers = { ...(request.headers || {}) };
    if (sessionToken) {
      headers['Authorization'] = `Bearer ${sessionToken}`;
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

    log.info("Network response:", xhr.status, responseBody.length, "bytes");

    // Signal worker
    Atomics.store(networkSignalView!, 0, 1);
    Atomics.notify(networkSignalView!, 0);

  } catch (error) {
    logNetwork.error("Network request failed:", error);

    // Write error response
    const dv = new DataView(networkResultBuffer!);
    dv.setInt32(0, 500);
    dv.setInt32(4, 0);

    Atomics.store(networkSignalView!, 0, 1);
    Atomics.notify(networkSignalView!, 0);
  }
}

/**
 * Handle sign request from worker - forward to background and signal back
 *
 * Uses async messaging to background but writes result synchronously
 * to shared buffer so worker can use Atomics.wait.
 */
async function handleSignRequest(request: { pub_key: number[]; data: number[] }): Promise<void> {
  log.debug(`Handling sign request, data length: ${request.data.length}`);

  try {
    // Forward to background script which has access to Lair
    const response = await chrome.runtime.sendMessage({
      target: "background",
      type: "SIGN_REQUEST",
      agent_pubkey: request.pub_key,
      message: request.data,
    });

    if (response && response.success && response.signature) {
      // Write success result to buffer
      // Format: [success: 1 byte] [length: 4 bytes] [signature: 64 bytes]
      const signatureBytes = new Uint8Array(response.signature);
      const resultView = new Uint8Array(signResultBuffer!);
      const dv = new DataView(signResultBuffer!);

      resultView[0] = 1; // success = true
      dv.setInt32(1, signatureBytes.length, true); // little-endian
      resultView.set(signatureBytes, 5);

      log.debug(`Sign success, signature length: ${signatureBytes.length}`);
    } else {
      // Write error to buffer
      const errorMsg = response?.error || "Signing failed";
      const errorBytes = new TextEncoder().encode(errorMsg);
      const resultView = new Uint8Array(signResultBuffer!);
      const dv = new DataView(signResultBuffer!);

      resultView[0] = 0; // success = false
      dv.setInt32(1, errorBytes.length, true); // little-endian
      resultView.set(errorBytes, 5);

      log.error(`Sign error: ${errorMsg}`);
    }

    // Signal worker
    Atomics.store(signSignalView!, 0, 1);
    Atomics.notify(signSignalView!, 0);

  } catch (error) {
    log.error("Sign request failed:", error);

    // Write error to buffer
    const errorMsg = error instanceof Error ? error.message : String(error);
    const errorBytes = new TextEncoder().encode(errorMsg);
    const resultView = new Uint8Array(signResultBuffer!);
    const dv = new DataView(signResultBuffer!);

    resultView[0] = 0; // success = false
    dv.setInt32(1, errorBytes.length, true); // little-endian
    resultView.set(errorBytes, 5);

    Atomics.store(signSignalView!, 0, 1);
    Atomics.notify(signSignalView!, 0);
  }
}

/**
 * Handle send remote signals request from worker (fire-and-forget)
 *
 * This mirrors Holochain's tokio::spawn pattern - signals are sent
 * asynchronously without blocking the zome call.
 */
function handleSendRemoteSignals(data: { dnaHash: number[]; signals: any[] }): void {
  if (!wsService) {
    logSignal.warn('Cannot send remote signals - WebSocket service not initialized');
    return;
  }

  if (!data.signals || data.signals.length === 0) {
    return;
  }

  const dnaHashB64 = encodeHashToBase64(new Uint8Array(data.dnaHash));
  logSignal.info(`Sending ${data.signals.length} remote signals via WebSocket`);
  wsService.sendRemoteSignals(dnaHashB64, data.signals);
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
  linkerUrl: string;
  sessionToken?: string;
}): void {
  // Convert HTTP URL to WebSocket URL
  const wsUrl = config.linkerUrl
    .replace(/^http:/, 'ws:')
    .replace(/^https:/, 'wss:')
    .replace(/\/$/, '') + '/ws';

  logNetwork.info(`Initializing WebSocket service: ${wsUrl}`);

  wsService = new WebSocketNetworkService({
    linkerWsUrl: wsUrl,
    sessionToken: config.sessionToken,
  });

  // Set up signal callback to forward signals to background
  wsService.onSignal((signal) => {
    logSignal.info(`Received remote signal via WebSocket: dna=${signal.dna_hash.substring(0, 15)}..., to=${signal.to_agent.substring(0, 15)}..., from=${signal.from_agent}, zome=${signal.zome_name}, len=${signal.signal.length}`);

    // Forward to background script which will dispatch to the right tab
    chrome.runtime.sendMessage({
      target: "background",
      type: "REMOTE_SIGNAL",
      dna_hash: signal.dna_hash,
      to_agent: signal.to_agent,
      from_agent: signal.from_agent,
      zome_name: signal.zome_name,
      signal: Array.from(signal.signal), // Convert Uint8Array for transport
    }).then(() => {
      logSignal.debug(`Signal forwarded to background successfully`);
    }).catch((err) => {
      logSignal.warn("Failed to forward signal:", err);
    });
  });

  // Set up state change callback for logging and auto-retry
  wsService.onStateChange((state: ConnectionState) => {
    logNetwork.info(`WebSocket state: ${state}`);

    // Notify background of connection state changes
    chrome.runtime.sendMessage({
      target: "background",
      type: "WS_STATE_CHANGE",
      state,
    }).catch(() => {
      // Ignore errors if background is not listening
    });

    // When connected, automatically process failed publish queue
    // This ensures failed publishes are retried when connection is re-established
    if (state === "connected") {
      // Small delay to allow agent registrations to propagate
      setTimeout(() => {
        logPublish.info("Connection established - triggering auto-retry of failed publishes");
        // Get registered DNAs from the websocket service and trigger publish processing
        const registrations = wsService?.getRegistrations() || [];
        if (registrations.length > 0 && publishService) {
          const uniqueDnas = new Set(registrations.map(r => r.dna_hash));
          for (const dnaHashB64 of uniqueDnas) {
            // Convert base64 to Uint8Array
            const dnaHash = decodeHashFromBase64(dnaHashB64);
            logPublish.info(`Auto-processing publish queue for DNA: ${dnaHashB64.substring(0, 15)}...`);
            publishService.processQueue(dnaHash).catch(err => {
              logPublish.warn(`Auto-retry failed for DNA ${dnaHashB64.substring(0, 15)}...:`, err);
            });
          }
        }
      }, 2000); // 2 second delay for agent registration propagation
    }
  });

  // Set up sign callback - forward sign requests to background for Lair signing
  wsService.onSign(async (request) => {
    log.debug(`Sign request for agent ${btoa(String.fromCharCode(...Array.from(request.agent_pubkey))).substring(0, 20)}...`);

    // Send to background script which has access to Lair
    const response = await chrome.runtime.sendMessage({
      target: "background",
      type: "SIGN_REQUEST",
      agent_pubkey: Array.from(request.agent_pubkey),
      message: Array.from(request.message),
    });

    if (response && response.success && response.signature) {
      // Convert signature array back to Uint8Array
      return new Uint8Array(response.signature);
    } else {
      throw new Error(response?.error || "Signing failed");
    }
  });

  // Connect to linker
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
 * Convert transported record back to proper HolochainRecord
 * Entry format is internally-tagged: { entry_type: "App", entry: bytes }
 */
function transportedRecordToRecord(transported: any): HolochainRecord {
  // Convert Entry from transport format back to Uint8Array
  let entry: any = undefined;
  if (transported.entry) {
    if (transported.entry.Present) {
      const presentEntry = transported.entry.Present;
      entry = {
        Present: {
          entry_type: presentEntry.entry_type,
          entry: new Uint8Array(presentEntry.entry),
        }
      };
    } else if (transported.entry.NotApplicable !== undefined) {
      entry = { NotApplicable: undefined };
    }
  }

  return {
    signed_action: {
      hashed: {
        content: transported.signed_action.hashed.content,
        hash: new Uint8Array(transported.signed_action.hashed.hash),
      },
      signature: new Uint8Array(transported.signed_action.signature),
    },
    entry,
  } as HolochainRecord;
}

/**
 * Publish pending records to the linker (runs in background)
 */
async function publishPendingRecords(
  transportedRecords: any[],
  dnaHash: DnaHash
): Promise<void> {
  if (!linkerUrl) {
    log.info("No linker URL configured, skipping publish");
    return;
  }

  // Initialize publish service if needed
  if (!publishService) {
    publishService = new PublishService({
      linkerUrl,
      sessionToken: sessionToken || undefined,
    });
    await publishService.init();
  } else {
    // Update config in case it changed
    publishService.setLinkerUrl(linkerUrl);
    if (sessionToken) {
      publishService.setSessionToken(sessionToken);
    }
  }

  // Convert transported records back to proper Records
  const records = transportedRecords.map(transportedRecordToRecord);

  logPublish.info(`Publishing ${records.length} records to linker...`);

  // Publish each record (PublishService will batch them)
  for (const record of records) {
    try {
      await publishService.publishRecord(record, dnaHash);
    } catch (error) {
      logPublish.error("Failed to publish record:", error);
      // Continue with other records - don't fail the whole batch
    }
  }

  log.info("Publish requests queued");
}

/**
 * Execute a zome call via the ribosome worker
 */
async function executeZomeCall(request: MinimalZomeCallRequest): Promise<{ result: unknown; signals: any[] }> {
  const perfStart = performance.now();
  logZome.info(`Executing zome call: ${request.zome}::${request.fn}`);

  // Ensure worker is initialized
  await initRibosomeWorker();
  const afterWorkerInit = performance.now();

  // Fetch the full hApp context from storage
  logZome.debug(`Fetching context: ${request.contextId}`);
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

  logZome.debug(`Found DNA: ${dna.name}, WASM size: ${dna.wasm.length} bytes`);
  const afterDnaLookup = performance.now();

  // Check if we've already sent this WASM to the worker
  const dnaHashKey = getDnaHashKey(request.cellId[0]);
  const wasmAlreadySent = sentWasmHashes.has(dnaHashKey);

  // Only send WASM on first call for this DNA - worker caches it
  const dnaWasmToSend = wasmAlreadySent ? [] : Array.from(toUint8Array(dna.wasm));
  if (!wasmAlreadySent) {
    sentWasmHashes.add(dnaHashKey);
    logZome.debug(`Sending WASM to worker (first time for this DNA)`);
  } else {
    logZome.trace(`Skipping WASM send (already cached in worker)`);
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

  log.perf(`executeZomeCall breakdown: workerInit=${(afterWorkerInit - perfStart).toFixed(1)}ms, contextFetch=${(afterContextFetch - afterWorkerInit).toFixed(1)}ms, dnaLookup=${(afterDnaLookup - afterContextFetch).toFixed(1)}ms, workerCall=${(afterWorker - afterDnaLookup).toFixed(1)}ms, TOTAL=${(afterWorker - perfStart).toFixed(1)}ms`);

  // Trigger publishing in background (don't await - let it run asynchronously)
  if (result.pendingRecords && result.pendingRecords.length > 0) {
    logPublish.info(`Triggering background publish for ${result.pendingRecords.length} records`);
    publishPendingRecords(result.pendingRecords, dnaHash).catch((error) => {
      logPublish.error("Background publish failed:", error);
    });
  }

  // Note: Remote signals are now sent directly from the worker via SEND_REMOTE_SIGNALS message
  // This happens during the zome call (fire-and-forget), not after it returns

  logZome.debug(`Worker returned ${(result.signals || []).length} emitted signals`);

  return {
    result: result.result,
    signals: result.signals || [],
    didWrite: (result.pendingRecords && result.pendingRecords.length > 0) || false,
  };
}

/**
 * Message types for communication with background script
 */
interface OffscreenMessage {
  target: "offscreen";
  type: "EXECUTE_ZOME_CALL" | "CONFIGURE_NETWORK" | "UPDATE_SESSION_TOKEN";
  requestId: string;
  zomeCallRequest?: MinimalZomeCallRequest;
  linkerUrl?: string;
  sessionToken?: string;
}

interface OffscreenResponse {
  success: boolean;
  requestId?: string;
  result?: unknown;
  signals?: any[];
  error?: string;
  disconnected?: boolean;
  reconnected?: boolean;
  records?: any[];
  state?: string;
  isConnected?: boolean;
  registrations?: Array<{ dna_hash: string; agent_pubkey: string }>;
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
    log.info("Received message:", message);

    if (message.target !== "offscreen") {
      return false;
    }

    if (message.type === "CONFIGURE_NETWORK") {
      linkerUrl = message.linkerUrl || '';
      sessionToken = message.sessionToken || null;

      logNetwork.info(`Network configured: ${linkerUrl}`);

      // Also configure the worker if it's ready
      if (workerReady && ribosomeWorker) {
        sendToWorker('CONFIGURE_NETWORK', { linkerUrl, sessionToken })
          .catch(console.error);
      }

      // Initialize WebSocket service for remote signals
      if (linkerUrl && !wsService) {
        initializeWebSocketService({ linkerUrl, sessionToken: sessionToken || undefined });
      } else if (wsService && sessionToken) {
        wsService.setSessionToken(sessionToken);
      }

      sendResponse({ success: true, requestId: message.requestId || "config" });
      return true;
    }

    if (message.type === "UPDATE_SESSION_TOKEN") {
      sessionToken = message.sessionToken || null;
      if (workerReady && ribosomeWorker) {
        sendToWorker('CONFIGURE_NETWORK', { linkerUrl, sessionToken })
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
      });
      return true;
    }

    // Linker disconnect - actually close the WebSocket
    if (message.type === "LINKER_DISCONNECT") {
      logNetwork.info("Disconnecting linker WebSocket...");
      if (wsService) {
        wsService.disconnect();
      }
      sendResponse({ success: true, disconnected: true });
      return true;
    }

    // Linker reconnect - reopen the WebSocket connection
    if (message.type === "LINKER_RECONNECT") {
      logNetwork.info("Reconnecting linker WebSocket...");
      if (wsService) {
        // connect() is synchronous (void), it initiates the connection
        wsService.connect();
        // Registrations are preserved and will be re-sent on reconnect
      }
      sendResponse({ success: true, reconnected: true });
      return true;
    }

    // Get all records for a cell - used for republishing
    if (message.type === "GET_ALL_RECORDS") {
      const { dnaHash, agentPubKey } = message;
      log.info(`[GET_ALL_RECORDS] Starting - dnaHash length: ${dnaHash?.length}, agentPubKey length: ${agentPubKey?.length}`);

      (async () => {
        try {
          log.debug("[GET_ALL_RECORDS] Ensuring ribosome worker...");
          await initRibosomeWorker();
          log.debug("[GET_ALL_RECORDS] Worker ready, sending request...");

          // sendToWorker resolves with just the 'result' part of the worker response
          // Worker returns { id, success: true, result: { records: [...] } }
          // So response here is { records: [...] }
          const response = await sendToWorker("GET_ALL_RECORDS", {
            dnaHash,
            agentPubKey,
          });

          log.info(`[GET_ALL_RECORDS] Got response: ${response?.records?.length || 0} records`);
          sendResponse({
            success: true,
            records: response?.records || [],
          });
        } catch (error) {
          log.error("[GET_ALL_RECORDS] Error:", error);
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
      return true;
    }

    // Process publish queue for specified DNAs (called after retry)
    if (message.type === "PROCESS_PUBLISH_QUEUE") {
      const { dnaHashes } = message;
      logPublish.info(`Processing publish queue for ${dnaHashes?.length || 0} DNAs`);

      // Process asynchronously
      (async () => {
        try {
          if (!publishService) {
            if (!linkerUrl) {
              sendResponse({
                success: false,
                error: "No linker configured",
                requestId: message.requestId || "process",
              });
              return;
            }
            publishService = new PublishService({
              linkerUrl,
              sessionToken: sessionToken || undefined,
            });
            await publishService.init();
          }

          // Process queue for each DNA
          for (const dnaHashArray of dnaHashes || []) {
            const dnaHash = new Uint8Array(dnaHashArray);
            await publishService.processQueue(dnaHash);
          }
          sendResponse({
            success: true,
            requestId: message.requestId || "process",
          });
        } catch (error) {
          logPublish.error("Failed to process publish queue:", error);
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : String(error),
            requestId: message.requestId || "process",
          });
        }
      })();
      return true;
    }

    // Recover chain from DHT - forward to worker
    if (message.type === "RECOVER_CHAIN") {
      const { contextId, dnaHashes, agentPubKey } = message;
      activeRecoveryContextId = contextId;
      log.info(`[RECOVER_CHAIN] Starting recovery for context: ${contextId}`);

      (async () => {
        try {
          await initRibosomeWorker();

          const response = await sendToWorker("RECOVER_CHAIN", {
            dnaHashes,
            agentPubKey,
          });

          log.info(`[RECOVER_CHAIN] Complete: ${response?.recoveredCount || 0} recovered, ${response?.failedCount || 0} failed`);
          sendResponse({
            success: true,
            recoveredCount: response?.recoveredCount || 0,
            failedCount: response?.failedCount || 0,
            errors: response?.errors || [],
          } as any);
        } catch (error) {
          log.error("[RECOVER_CHAIN] Error:", error);
          sendResponse({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          } as any);
        }
      })();
      return true;
    }

    if (message.type === "EXECUTE_ZOME_CALL") {
      const { requestId, zomeCallRequest } = message;

      executeZomeCall(zomeCallRequest)
        .then(({ result, signals, didWrite }) => {
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
                  logZome.warn('Failed to decode Ok value:', e);
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
            didWrite: didWrite || false,
          });
        })
        .catch((error) => {
          logZome.error("Zome call error:", error);
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
log.info("Sending ready signal");
chrome.runtime.sendMessage({ target: "background", type: "OFFSCREEN_READY" });
