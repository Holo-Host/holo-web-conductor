/**
 * Firefox Direct Executor
 *
 * Implements ZomeExecutor for Firefox, where the background page has DOM access.
 * Instead of an offscreen document, we:
 * - Spawn the ribosome worker directly from the background page
 * - Let the worker do sync XHR directly (Firefox workers support this)
 * - Worker creates its own LairClient from IndexedDB for signing (no SharedArrayBuffer needed)
 * - Run WebSocket + publish services in the background page (has DOM)
 *
 * No SharedArrayBuffer, no Atomics, no offscreen document.
 */

import type {
  ZomeExecutor,
  ZomeCallResult,
  RecoveryResult,
  WsStateInfo,
  RemoteSignalData,
  SignRequestData,
  SignResponseData,
  RemoteSignalCallback,
  SignRequestCallback,
  WsStateChangeCallback,
} from "../lib/zome-executor";
import type { ZomeCallRequest } from "@hwc/core/ribosome";
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

const log = createLogger("FirefoxExec");
const logNetwork = createLogger("Network");
const logSignal = createLogger("Signal");
const logPublish = createLogger("Publish");
const logZome = createLogger("ZomeCall");

export class FirefoxDirectExecutor implements ZomeExecutor {
  // --- Worker state ---
  private worker: Worker | null = null;
  private workerReady = false;
  private workerInitPromise: Promise<void> | null = null;

  // --- Services ---
  private wsService: WebSocketNetworkService | null = null;
  private publishService: PublishService | null = null;

  // --- Network config ---
  private linkerUrl = "";
  private sessionToken: string | null = null;
  private _networkConfigured = false;

  // --- Worker request tracking ---
  private pendingRequests = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private nextRequestId = 1;

  // --- WASM caching ---
  private sentWasmHashes = new Set<string>();

  // --- Recovery tracking ---
  private activeRecoveryContextId: string | null = null;

  // --- Event callbacks ---
  private remoteSignalCallback: RemoteSignalCallback | null = null;
  private signRequestCallback: SignRequestCallback | null = null;
  private wsStateChangeCallback: WsStateChangeCallback | null = null;

  // --- Storage ---
  private storage = getHappContextStorage();

  // ============================================================================
  // Lifecycle
  // ============================================================================

  async initialize(): Promise<void> {
    await this.initWorker();
  }

  isReady(): boolean {
    return this.workerReady;
  }

  get networkConfigured(): boolean {
    return this._networkConfigured;
  }

  // ============================================================================
  // Network configuration
  // ============================================================================

  async configureNetwork(config: { linkerUrl: string; sessionToken?: string }): Promise<void> {
    this.linkerUrl = config.linkerUrl;
    if (config.sessionToken !== undefined) {
      this.sessionToken = config.sessionToken || null;
    }

    logNetwork.info(`Configuring network: ${this.linkerUrl}`);

    // Forward to worker if ready
    if (this.workerReady) {
      await this.sendToWorker("CONFIGURE_NETWORK", {
        linkerUrl: this.linkerUrl,
        sessionToken: this.sessionToken,
      });
    }

    // Initialize or reconfigure WebSocket
    if (this.linkerUrl && !this.wsService) {
      this.initializeWebSocketService();
    } else if (this.wsService && this.linkerUrl) {
      const newWsUrl = this.linkerUrl
        .replace(/^http:/, "ws:")
        .replace(/^https:/, "wss:")
        .replace(/\/$/, "") + "/ws";
      if (this.wsService.getUrl() !== newWsUrl) {
        logNetwork.info(`Linker URL changed, reinitializing WebSocket`);
        this.wsService.disconnect();
        this.wsService = null;
        this.initializeWebSocketService();
      } else if (this.sessionToken) {
        this.wsService.setSessionToken(this.sessionToken);
      }
    }

    this._networkConfigured = true;
    logNetwork.info("Network configured");
  }

  async updateSessionToken(token: string | null): Promise<void> {
    if (!this._networkConfigured) return;

    this.sessionToken = token;
    if (this.workerReady) {
      await this.sendToWorker("CONFIGURE_NETWORK", {
        linkerUrl: this.linkerUrl,
        sessionToken: this.sessionToken,
      }).catch((err: unknown) => logNetwork.error("Failed to update worker session token:", err));
    }
    if (this.wsService) {
      this.wsService.setSessionToken(token || "");
    }
  }

  // ============================================================================
  // Agent registration
  // ============================================================================

  async registerAgent(dnaHashB64: string, agentPubKeyB64: string): Promise<void> {
    if (!this._networkConfigured) {
      logNetwork.debug("Skipping agent registration - network not configured");
      return;
    }

    logNetwork.info(
      `Registering agent: dna=${dnaHashB64.substring(0, 15)}..., agent=${agentPubKeyB64.substring(0, 15)}...`
    );

    if (this.wsService) {
      this.wsService.registerAgent(dnaHashB64, agentPubKeyB64);
    }
  }

  // ============================================================================
  // Zome execution
  // ============================================================================

  async executeZomeCall(contextId: string, request: ZomeCallRequest): Promise<ZomeCallResult> {
    const perfStart = performance.now();
    logZome.info(`Executing: ${request.zome}::${request.fn}`);

    await this.initWorker();
    const afterWorkerInit = performance.now();

    // Fetch hApp context from storage
    const context = await this.storage.getContext(contextId);
    if (!context) throw new Error(`Context not found: ${contextId}`);
    const afterContextFetch = performance.now();

    // Find DNA
    const dnaHash = toUint8Array(request.cellId[0]);
    const dna = context.dnas.find((d) => {
      const storedHash = toUint8Array(d.hash);
      return storedHash.length === dnaHash.length &&
        storedHash.every((byte, i) => byte === dnaHash[i]);
    });
    if (!dna) throw new Error(`DNA not found for cell`);

    // WASM caching: only send on first call per DNA
    const dnaHashKey = this.getDnaHashKey(request.cellId[0]);
    const wasmAlreadySent = this.sentWasmHashes.has(dnaHashKey);
    const dnaWasmToSend = wasmAlreadySent ? [] : Array.from(toUint8Array(dna.wasm));
    if (!wasmAlreadySent) this.sentWasmHashes.add(dnaHashKey);

    const result = await this.sendToWorker("CALL_ZOME", {
      dnaWasm: dnaWasmToSend,
      cellId: [
        Array.from(toUint8Array(request.cellId[0])),
        Array.from(toUint8Array(request.cellId[1])),
      ],
      zome: request.zome,
      fn: request.fn,
      payloadBytes: Array.from(request.payload as Uint8Array),
      provenance: Array.from(toUint8Array(request.provenance)),
      dnaManifest: dna.manifest ? normalizeUint8Arrays(dna.manifest) : undefined,
    });
    const afterWorker = performance.now();

    log.perf(
      `executeZomeCall: workerInit=${(afterWorkerInit - perfStart).toFixed(1)}ms, ctx=${(afterContextFetch - afterWorkerInit).toFixed(1)}ms, worker=${(afterWorker - afterContextFetch).toFixed(1)}ms, TOTAL=${(afterWorker - perfStart).toFixed(1)}ms`
    );

    // Publish in background (fire-and-forget)
    if (result.pendingRecords && result.pendingRecords.length > 0) {
      this.publishPendingRecords(result.pendingRecords, dnaHash).catch((err: unknown) => {
        logPublish.error("Background publish failed:", err);
      });
    }

    // Unwrap Ok/Err and decode
    let unwrappedResult = result.result;
    if (result.result && typeof result.result === "object") {
      if ("Ok" in result.result) {
        const okValue = (result.result as any).Ok;
        if (okValue instanceof Uint8Array) {
          try { unwrappedResult = decode(okValue); } catch { unwrappedResult = okValue; }
        } else {
          unwrappedResult = okValue;
        }
      } else if ("Err" in result.result) {
        const errValue = (result.result as any).Err;
        let errMessage = errValue;
        if (errValue instanceof Uint8Array) {
          try { errMessage = decode(errValue); } catch { errMessage = String(errValue); }
        }
        throw new Error(typeof errMessage === "string" ? errMessage : JSON.stringify(errMessage));
      }
    }

    // Serialize for transport (converts Uint8Arrays to number[])
    const transportResult = serializeForTransport(unwrappedResult);
    const transportSignals = (result.signals || []).map((sig: any) => ({
      cell_id: serializeForTransport(sig.cell_id),
      zome_name: sig.zome_name,
      signal: serializeForTransport(sig.signal),
    }));

    return {
      result: transportResult,
      signals: transportSignals,
      didWrite: (result.pendingRecords && result.pendingRecords.length > 0) || false,
    };
  }

  // ============================================================================
  // Genesis
  // ============================================================================

  async runGenesis(
    cellId: [number[], number[]],
    dnaWasm: number[],
    dnaManifest: unknown,
    membraneProof: number[] | null,
  ): Promise<{ pendingRecords: any[] }> {
    await this.initWorker();

    const response = await this.sendToWorker("RUN_GENESIS", {
      dnaWasm,
      cellId,
      dnaManifest,
      membraneProof,
    });

    if (response.valid) {
      // Publish genesis records (fire-and-forget)
      if (response.pendingRecords && response.pendingRecords.length > 0) {
        const dnaHash = new Uint8Array(cellId[0]) as DnaHash;
        this.publishPendingRecords(response.pendingRecords, dnaHash).catch((err: unknown) => {
          logPublish.error("Genesis publish failed:", err);
        });
      }
      return { pendingRecords: [] };
    } else {
      throw new Error(response.reason || "genesis_self_check failed");
    }
  }

  // ============================================================================
  // Records & publishing
  // ============================================================================

  async getAllRecords(dnaHash: number[], agentPubKey: number[]): Promise<{ records: any[] }> {
    await this.initWorker();
    const response = await this.sendToWorker("GET_ALL_RECORDS", { dnaHash, agentPubKey });
    return { records: response?.records || [] };
  }

  async processPublishQueue(dnaHashes: number[][]): Promise<void> {
    if (!this.publishService) {
      if (!this.linkerUrl) return;
      this.publishService = new PublishService({
        linkerUrl: this.linkerUrl,
        sessionToken: this.sessionToken || undefined,
      });
      await this.publishService.init();
    }

    for (const dnaHashArray of dnaHashes) {
      const dnaHash = new Uint8Array(dnaHashArray);
      await this.publishService.processQueue(dnaHash);
    }
  }

  // ============================================================================
  // Chain recovery
  // ============================================================================

  async recoverChain(
    contextId: string,
    dnaHashes: number[][],
    agentPubKey: number[]
  ): Promise<RecoveryResult> {
    await this.initWorker();
    this.activeRecoveryContextId = contextId;

    const response = await this.sendToWorker("RECOVER_CHAIN", { dnaHashes, agentPubKey });

    return {
      recoveredCount: response?.recoveredCount || 0,
      failedCount: response?.failedCount || 0,
      verifiedCount: response?.verifiedCount || 0,
      unverifiedCount: response?.unverifiedCount || 0,
      errors: response?.errors || [],
    };
  }

  // ============================================================================
  // Linker connectivity
  // ============================================================================

  async disconnectLinker(): Promise<void> {
    if (this.wsService) this.wsService.disconnect();
  }

  async reconnectLinker(): Promise<void> {
    if (this.wsService) this.wsService.connect();
  }

  async getWebSocketState(): Promise<WsStateInfo> {
    return {
      state: this.wsService?.getState() || "disconnected",
      isConnected: this.wsService?.isConnected() || false,
      authenticated: this.wsService?.isAuthenticated() || false,
      registrations: this.wsService?.getRegistrations(),
    };
  }

  // ============================================================================
  // Signing key preload
  // ============================================================================

  async preloadSigningKey(pubKey: Uint8Array): Promise<void> {
    await this.initWorker();
    // Tell the worker to preload this key from its own LairClient (IndexedDB).
    // Only the public key crosses the message boundary — no secret key transport.
    await this.sendToWorker("PRELOAD_SIGNING_KEY", {
      pubKey: Array.from(pubKey),
    });
    log.info(`Signing key preload requested for worker: ${btoa(String.fromCharCode(...pubKey)).substring(0, 20)}...`);
  }

  // ============================================================================
  // Events
  // ============================================================================

  onRemoteSignal(callback: RemoteSignalCallback): void {
    this.remoteSignalCallback = callback;
  }

  onSignRequest(callback: SignRequestCallback): void {
    this.signRequestCallback = callback;
  }

  onWebSocketStateChange(callback: WsStateChangeCallback): void {
    this.wsStateChangeCallback = callback;
  }

  // ============================================================================
  // Internal: Worker management
  // ============================================================================

  private async initWorker(): Promise<void> {
    if (this.workerReady) return;
    if (this.workerInitPromise) return this.workerInitPromise;

    this.workerInitPromise = (async () => {
      log.info("Initializing ribosome worker (Firefox direct mode)...");

      const workerUrl = chrome.runtime.getURL("offscreen/ribosome-worker.js");
      this.worker = new Worker(workerUrl);
      this.worker.onmessage = (event) => this.handleWorkerMessage(event);
      this.worker.onerror = (error) => log.error("Worker error:", error);

      // Wait for READY signal
      await new Promise<void>((resolve) => {
        const checkReady = (event: MessageEvent) => {
          if (event.data.type === "READY") {
            this.worker!.removeEventListener("message", checkReady);
            resolve();
          }
        };
        this.worker!.addEventListener("message", checkReady);
      });

      // Initialize worker in Firefox mode: no SharedArrayBuffers
      // Worker will use direct sync XHR and direct signing
      await this.sendToWorker("INIT", {
        firefoxMode: true,
        linkerUrl: this.linkerUrl || undefined,
        sessionToken: this.sessionToken || undefined,
      });

      this.workerReady = true;
      log.info("Ribosome worker initialized (Firefox direct mode)");

      // Send existing network config
      if (this.linkerUrl || this.sessionToken) {
        await this.sendToWorker("CONFIGURE_NETWORK", {
          linkerUrl: this.linkerUrl,
          sessionToken: this.sessionToken,
        });
      }
    })();

    return this.workerInitPromise;
  }

  private handleWorkerMessage(event: MessageEvent): void {
    const { id, type, success, result, error } = event.data;

    // Note: Worker signs locally via its own LairClient in Firefox mode.
    // No SIGN_REQUEST from worker expected.

    // Remote signals from worker (fire-and-forget)
    if (type === "SEND_REMOTE_SIGNALS") {
      this.handleSendRemoteSignals(event.data);
      return;
    }

    // Recovery progress forwarding
    if (type === "RECOVER_CHAIN_PROGRESS") {
      const progress = event.data.progress;
      if (progress && this.activeRecoveryContextId) {
        chrome.storage.local.set({
          [`hwc_recovery_progress_${this.activeRecoveryContextId}`]: progress,
        }).catch(() => {});
      }
      return;
    }

    // Response to a pending request
    if (id !== undefined) {
      const pending = this.pendingRequests.get(id);
      if (pending) {
        this.pendingRequests.delete(id);
        if (success) {
          pending.resolve(result);
        } else {
          pending.reject(new Error(error || "Unknown worker error"));
        }
      }
    }
  }

  private handleSendRemoteSignals(data: { dnaHash: number[]; signals: any[] }): void {
    if (!this.wsService || !data.signals?.length) return;

    const dnaHashB64 = encodeHashToBase64(new Uint8Array(data.dnaHash));
    logSignal.info(`Sending ${data.signals.length} remote signals via WebSocket`);
    this.wsService.sendRemoteSignals(dnaHashB64, data.signals);
  }

  private static readonly WORKER_REQUEST_TIMEOUT_MS = 60_000;

  private sendToWorker(type: string, payload?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.worker) {
        reject(new Error("Worker not initialized"));
        return;
      }
      const id = this.nextRequestId++;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Worker request timed out after ${FirefoxDirectExecutor.WORKER_REQUEST_TIMEOUT_MS}ms (type=${type}, id=${id})`));
      }, FirefoxDirectExecutor.WORKER_REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, {
        resolve: (value: any) => { clearTimeout(timer); resolve(value); },
        reject: (reason: any) => { clearTimeout(timer); reject(reason); },
      });
      this.worker.postMessage({ id, type, payload });
    });
  }

  // ============================================================================
  // Internal: WebSocket service
  // ============================================================================

  private initializeWebSocketService(): void {
    const wsUrl = this.linkerUrl
      .replace(/^http:/, "ws:")
      .replace(/^https:/, "wss:")
      .replace(/\/$/, "") + "/ws";

    logNetwork.info(`Initializing WebSocket: ${wsUrl}`);

    this.wsService = new WebSocketNetworkService({
      linkerWsUrl: wsUrl,
      sessionToken: this.sessionToken || undefined,
    });

    // Signal forwarding: invoke the callback registered by background/index.ts
    this.wsService.onSignal((signal) => {
      logSignal.info(`Remote signal: dna=${signal.dna_hash.substring(0, 15)}..., zome=${signal.zome_name}`);
      if (this.remoteSignalCallback) {
        this.remoteSignalCallback({
          dna_hash: signal.dna_hash,
          to_agent: signal.to_agent,
          from_agent: signal.from_agent,
          zome_name: signal.zome_name,
          signal: Array.from(signal.signal),
        });
      }
    });

    // State change notifications
    this.wsService.onStateChange((state: ConnectionState) => {
      logNetwork.info(`WebSocket state: ${state}`);
      if (this.wsStateChangeCallback) {
        this.wsStateChangeCallback(state, this.wsService?.isAuthenticated() || false);
      }

      // Auto-retry publishes on reconnect
      if (state === "connected") {
        setTimeout(() => {
          const registrations = this.wsService?.getRegistrations() || [];
          if (registrations.length > 0 && this.publishService) {
            const uniqueDnas = new Set(registrations.map(r => r.dna_hash));
            for (const dnaHashB64 of uniqueDnas) {
              const dnaHash = decodeHashFromBase64(dnaHashB64);
              this.publishService.processQueue(dnaHash).catch(err => {
                logPublish.warn(`Auto-retry failed:`, err);
              });
            }
          }
        }, 2000);
      }
    });

    // Sign callback for WebSocket auth
    this.wsService.onSign(async (request) => {
      if (!this.signRequestCallback) throw new Error("No sign handler");

      const response = await this.signRequestCallback({
        agent_pubkey: Array.from(request.agent_pubkey),
        message: Array.from(request.message),
      });

      if (response.success && response.signature) {
        return new Uint8Array(response.signature);
      }
      throw new Error(response.error || "Signing failed");
    });

    // Session token callback: update worker when linker auth succeeds
    this.wsService.onSessionToken((token) => {
      logNetwork.info("Received session token from linker auth");
      this.sessionToken = token;
      if (this.workerReady) {
        this.sendToWorker("CONFIGURE_NETWORK", {
          linkerUrl: this.linkerUrl,
          sessionToken: this.sessionToken,
        }).catch((err: unknown) => logNetwork.error("Worker token update failed:", err));
      }
    });

    this.wsService.connect();
  }

  // ============================================================================
  // Internal: Publishing
  // ============================================================================

  private async publishPendingRecords(transportedRecords: any[], dnaHash: DnaHash): Promise<void> {
    if (!this.linkerUrl) return;

    if (!this.publishService) {
      this.publishService = new PublishService({
        linkerUrl: this.linkerUrl,
        sessionToken: this.sessionToken || undefined,
      });
      await this.publishService.init();
    } else {
      this.publishService.setLinkerUrl(this.linkerUrl);
      if (this.sessionToken) this.publishService.setSessionToken(this.sessionToken);
    }

    const records = transportedRecords.map(this.transportedRecordToRecord);
    logPublish.info(`Publishing ${records.length} records`);

    for (const record of records) {
      try {
        await this.publishService.publishRecord(record, dnaHash);
      } catch (error) {
        logPublish.error("Failed to publish record:", error);
      }
    }
  }

  private transportedRecordToRecord(transported: any): HolochainRecord {
    let entry: any = undefined;
    if (transported.entry) {
      if (transported.entry.Present) {
        entry = {
          Present: {
            entry_type: transported.entry.Present.entry_type,
            entry: new Uint8Array(transported.entry.Present.entry),
          },
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

  // ============================================================================
  // Internal: Utilities
  // ============================================================================

  private getDnaHashKey(dnaHash: Uint8Array | number[]): string {
    const bytes = Array.isArray(dnaHash) ? dnaHash : Array.from(dnaHash);
    return btoa(String.fromCharCode(...bytes));
  }
}
