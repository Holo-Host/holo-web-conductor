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
 *
 * Inherits WebSocket management, publish service, signal forwarding, and
 * linker connectivity from BaseExecutor. Only adds worker lifecycle and
 * zome call execution.
 */

import type {
  ZomeCallResult,
  RecoveryResult,
  WsStateInfo,
} from "../lib/zome-executor";
import type { ZomeCallRequest } from "@hwc/core/ribosome";
import { BaseExecutor } from "./base-executor";
import { encode, decode } from "@msgpack/msgpack";
import { getHappContextStorage } from "../lib/happ-context-storage";
import { toUint8Array, normalizeUint8Arrays, serializeForTransport } from "@hwc/core";
import { encodeHashToBase64 } from "@holochain/client";
import type { DnaHash } from "@holochain/client";
import { createLogger } from "../lib/logger";

const log = createLogger("FirefoxExec");
const logNetwork = createLogger("Network");
const logSignal = createLogger("Signal");
const logPublish = createLogger("Publish");
const logZome = createLogger("ZomeCall");

export class FirefoxDirectExecutor extends BaseExecutor {
  // --- Worker state ---
  private worker: Worker | null = null;
  private workerReady = false;
  private workerInitPromise: Promise<void> | null = null;

  // --- Worker request tracking ---
  private pendingRequests = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private nextRequestId = 1;

  // --- WASM caching ---
  private sentWasmHashes = new Set<string>();

  // --- Recovery tracking ---
  private activeRecoveryContextId: string | null = null;

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

  // ============================================================================
  // Network configuration (extends base with worker forwarding)
  // ============================================================================

  async configureNetwork(config: { linkerUrl: string; sessionToken?: string }): Promise<void> {
    // Base class handles WS service init/reconfigure, stores config
    await super.configureNetwork(config);

    // Forward to worker if ready
    if (this.workerReady) {
      await this.sendToWorker("CONFIGURE_NETWORK", {
        linkerUrl: this.linkerUrl,
        sessionToken: this.sessionToken,
      });
    }
  }

  async updateSessionToken(token: string | null): Promise<void> {
    // Base class handles WS service update, stores token
    await super.updateSessionToken(token);

    if (this._networkConfigured && this.workerReady) {
      await this.sendToWorker("CONFIGURE_NETWORK", {
        linkerUrl: this.linkerUrl,
        sessionToken: this.sessionToken,
      }).catch((err: unknown) => logNetwork.error("Failed to update worker session token:", err));
    }
  }

  // ============================================================================
  // Hook: linker session token propagation to worker
  // ============================================================================

  protected onLinkerSessionToken(token: string): void {
    if (this.workerReady) {
      this.sendToWorker("CONFIGURE_NETWORK", {
        linkerUrl: this.linkerUrl,
        sessionToken: this.sessionToken,
      }).catch((err: unknown) => logNetwork.error("Worker token update failed:", err));
    }
  }

  // ============================================================================
  // Zome execution
  // ============================================================================

  async executeZomeCall(contextId: string, request: ZomeCallRequest): Promise<ZomeCallResult> {
    const perfStart = performance.now();
    logZome.debug(`Executing: ${request.zome}::${request.fn}`);

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
  // Records
  // ============================================================================

  async getAllRecords(dnaHash: number[], agentPubKey: number[]): Promise<{ records: any[] }> {
    await this.initWorker();
    const response = await this.sendToWorker("GET_ALL_RECORDS", { dnaHash, agentPubKey });
    return { records: response?.records || [] };
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

    return this.normalizeRecoveryResult(response);
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

  async sendMasterKeyToWorker(masterKey: Uint8Array): Promise<void> {
    await this.initWorker();
    await this.sendToWorker("SET_MASTER_KEY", {
      masterKey: Array.from(masterKey),
    });
    log.info("Master encryption key sent to worker");
  }

  async clearWorkerMasterKey(): Promise<void> {
    if (!this.workerReady) return;
    await this.sendToWorker("CLEAR_MASTER_KEY", {});
    log.info("Worker master key cleared");
  }

  // ============================================================================
  // Platform-specific: recovery progress storage
  // ============================================================================

  protected writeRecoveryProgress(contextId: string, progress: any): void {
    chrome.storage.local.set({
      [`hwc_recovery_progress_${contextId}`]: progress,
    }).catch((err) => {
      log.warn("Failed to write recovery progress:", err);
    });
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

    // HTTP 401 from worker's direct XHR — trigger WS re-auth for fresh token
    if (type === "HTTP_401_DETECTED") {
      this.triggerReauth();
      return;
    }

    // Recovery progress forwarding
    if (type === "RECOVER_CHAIN_PROGRESS") {
      const progress = event.data.progress;
      if (progress && this.activeRecoveryContextId) {
        this.writeRecoveryProgress(this.activeRecoveryContextId, progress);
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
    logSignal.debug(`Sending ${data.signals.length} remote signals via WebSocket`);
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
  // Internal: Utilities
  // ============================================================================

  private getDnaHashKey(dnaHash: Uint8Array | number[]): string {
    const bytes = Array.isArray(dnaHash) ? dnaHash : Array.from(dnaHash);
    return btoa(String.fromCharCode(...bytes));
  }
}
