/**
 * Chrome Offscreen Executor
 *
 * Implements ZomeExecutor using Chrome's offscreen document API.
 * The offscreen document spawns a ribosome worker that runs WASM + SQLite,
 * with synchronous network access via XHR and signing via SharedArrayBuffer/Atomics.
 *
 * This class encapsulates all Chrome-specific offscreen document management
 * that was previously spread across background/index.ts.
 */

import type {
  ZomeExecutor,
  MinimalZomeCallRequest,
  ZomeCallResult,
  WsStateInfo,
  RemoteSignalData,
  SignRequestData,
  SignResponseData,
  RemoteSignalCallback,
  SignRequestCallback,
  WsStateChangeCallback,
} from "../lib/zome-executor";
import type { ZomeCallRequest } from "@hwc/core/ribosome";
import { createLogger } from "../lib/logger";

const logOffscreen = createLogger("OffscreenMgr");
const logLinker = createLogger("Linker");
const logZome = createLogger("CallZome");
const logSignal = createLogger("Signal");
const logLair = createLogger("Lair");
const log = createLogger("Background");

const OFFSCREEN_DOCUMENT_PATH = "offscreen/offscreen.html";

export class ChromeOffscreenExecutor implements ZomeExecutor {
  // --- Offscreen document state ---
  private creatingOffscreen: Promise<void> | null = null;
  private _networkConfigured = false;
  private _offscreenReady = false;
  private offscreenReadyResolvers: Array<() => void> = [];

  // --- Event callbacks ---
  private remoteSignalCallback: RemoteSignalCallback | null = null;
  private signRequestCallback: SignRequestCallback | null = null;
  private wsStateChangeCallback: WsStateChangeCallback | null = null;

  constructor() {
    this.setupMessageListener();
  }

  // ============================================================================
  // Message listener for offscreen → background messages
  // ============================================================================

  private setupMessageListener(): void {
    chrome.runtime.onMessage.addListener(
      (rawMessage: any, _sender: chrome.runtime.MessageSender, sendResponse: (response: any) => void) => {
        if (rawMessage?.target !== "background") return false;

        if (rawMessage.type === "OFFSCREEN_READY") {
          this.markOffscreenReady();
          return false;
        }

        if (rawMessage.type === "REMOTE_SIGNAL") {
          if (this.remoteSignalCallback) {
            // Fire-and-forget: invoke callback, respond with success
            Promise.resolve()
              .then(() => this.remoteSignalCallback!(rawMessage as RemoteSignalData))
              .then(() => sendResponse({ success: true }))
              .catch((error) => {
                logSignal.error("Error handling remote signal:", error);
                sendResponse({ success: false, error: String(error) });
              });
            return true; // Async response
          }
          return false;
        }

        if (rawMessage.type === "WS_STATE_CHANGE") {
          logLinker.debug(`WebSocket state changed: ${rawMessage.state}`);
          if (this.wsStateChangeCallback) {
            this.wsStateChangeCallback(rawMessage.state);
          }
          return false;
        }

        if (rawMessage.type === "SIGN_REQUEST") {
          if (this.signRequestCallback) {
            this.signRequestCallback(rawMessage as SignRequestData)
              .then((result) => sendResponse(result))
              .catch((error) => {
                logLair.error("Sign request error:", error);
                sendResponse({ success: false, error: String(error) });
              });
            return true; // Async response
          }
          return false;
        }

        if (rawMessage.type === "RECOVER_CHAIN_PROGRESS") {
          const { contextId, progress } = rawMessage;
          if (contextId && progress) {
            chrome.storage.local.set({
              [`hwc_recovery_progress_${contextId}`]: progress,
            }).catch((err) => {
              console.warn("Failed to write recovery progress:", err);
            });
          }
          return false;
        }

        // Unknown internal message
        return false;
      }
    );
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  async initialize(): Promise<void> {
    await this.ensureOffscreenDocument();
  }

  isReady(): boolean {
    return this._offscreenReady;
  }

  // ============================================================================
  // Network configuration
  // ============================================================================

  async configureNetwork(config: { linkerUrl: string; sessionToken?: string }): Promise<void> {
    logLinker.info(`Configuring offscreen network with linker: ${config.linkerUrl}`);

    try {
      await this.ensureOffscreenDocument();
      await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "CONFIGURE_NETWORK",
        linkerUrl: config.linkerUrl,
        sessionToken: config.sessionToken,
      });
      this._networkConfigured = true;
      logLinker.info("Offscreen network configured");
    } catch (error) {
      logLinker.error("Failed to configure offscreen network:", error);
      throw error;
    }
  }

  async updateSessionToken(token: string | null): Promise<void> {
    if (!this._networkConfigured) return;

    try {
      await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "UPDATE_SESSION_TOKEN",
        sessionToken: token,
      });
      logLinker.debug("Session token updated in offscreen");
    } catch (error) {
      logLinker.error("Failed to update session token:", error);
    }
  }

  // ============================================================================
  // Agent registration
  // ============================================================================

  async registerAgent(dnaHashB64: string, agentPubKeyB64: string): Promise<void> {
    if (!this._networkConfigured) {
      logLinker.debug("Skipping agent registration - network not configured");
      return;
    }

    logLinker.info(
      `Registering agent with linker: dna=${dnaHashB64.substring(0, 15)}..., agent=${agentPubKeyB64.substring(0, 15)}...`
    );

    try {
      await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "REGISTER_AGENT",
        dna_hash: dnaHashB64,
        agent_pubkey: agentPubKeyB64,
      });
      logLinker.debug("Agent registered with linker");
    } catch (error) {
      logLinker.error("Failed to register agent with linker:", error);
    }
  }

  // ============================================================================
  // Zome execution
  // ============================================================================

  async executeZomeCall(contextId: string, request: ZomeCallRequest): Promise<ZomeCallResult> {
    const perfStart = performance.now();

    await this.ensureOffscreenDocument();
    const afterOffscreen = performance.now();

    const requestId = crypto.randomUUID();
    const dnaHashBase64 = btoa(String.fromCharCode(...request.cellId[0]));

    // Pre-conversion: Convert Uint8Arrays to number[] before Chrome message passing.
    // Chrome's structured cloning converts Uint8Array to {0:x, 1:y} objects which is harder
    // to work with. Using Array.from() produces clean number[] that toUint8Array() can restore.
    const minimalRequest: MinimalZomeCallRequest = {
      contextId,
      dnaHashBase64,
      cellId: [
        Array.from(request.cellId[0]),
        Array.from(request.cellId[1]),
      ],
      zome: request.zome,
      fn: request.fn,
      payload: Array.from(request.payload as Uint8Array),
      provenance: Array.from(request.provenance),
    };

    const afterBuild = performance.now();
    logZome.info(
      `Sending zome call to offscreen: ${request.zome}::${request.fn} (context: ${contextId})`
    );

    const response = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "EXECUTE_ZOME_CALL",
      requestId,
      zomeCallRequest: minimalRequest,
    });
    const afterMessage = performance.now();

    log.perf(
      `executeZomeCall breakdown: ensureOffscreen=${(afterOffscreen - perfStart).toFixed(1)}ms, buildRequest=${(afterBuild - afterOffscreen).toFixed(1)}ms, sendMessage=${(afterMessage - afterBuild).toFixed(1)}ms, TOTAL=${(afterMessage - perfStart).toFixed(1)}ms`
    );

    if (!response.success) {
      throw new Error(response.error || "Offscreen zome call failed");
    }

    return {
      result: response.result,
      signals: response.signals || [],
      didWrite: response.didWrite || false,
    };
  }

  // ============================================================================
  // Records & publishing
  // ============================================================================

  async getAllRecords(dnaHash: number[], agentPubKey: number[]): Promise<{ records: any[] }> {
    await this.ensureOffscreenDocument();

    const response = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "GET_ALL_RECORDS",
      dnaHash,
      agentPubKey,
    });

    if (!response.success) {
      throw new Error(response.error || "Failed to get all records");
    }

    return { records: response.records || [] };
  }

  async processPublishQueue(dnaHashes: number[][]): Promise<void> {
    await this.ensureOffscreenDocument();

    await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "PROCESS_PUBLISH_QUEUE",
      dnaHashes,
    });
  }

  // ============================================================================
  // Chain recovery
  // ============================================================================

  async recoverChain(
    contextId: string,
    dnaHashes: number[][],
    agentPubKey: number[]
  ): Promise<{ recoveredCount: number; failedCount: number; errors: string[] }> {
    await this.ensureOffscreenDocument();

    const response = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "RECOVER_CHAIN",
      contextId,
      dnaHashes,
      agentPubKey,
    });

    if (!response.success) {
      throw new Error(response.error || "Chain recovery failed");
    }

    return {
      recoveredCount: response.recoveredCount ?? 0,
      failedCount: response.failedCount ?? 0,
      errors: response.errors ?? [],
    };
  }

  // ============================================================================
  // Linker connectivity
  // ============================================================================

  async disconnectLinker(): Promise<void> {
    await this.ensureOffscreenDocument();
    await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "LINKER_DISCONNECT",
    });
  }

  async reconnectLinker(): Promise<void> {
    await this.ensureOffscreenDocument();
    await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "LINKER_RECONNECT",
    });
  }

  async getWebSocketState(): Promise<WsStateInfo> {
    try {
      const response = await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "GET_WS_STATE",
      });

      if (response?.success) {
        return {
          state: response.state || "disconnected",
          isConnected: response.isConnected || false,
          registrations: response.registrations,
        };
      }
    } catch (error) {
      logLinker.debug("Could not get WebSocket state from offscreen:", error);
    }

    return { state: "disconnected", isConnected: false };
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
  // Internal: Offscreen document management
  // ============================================================================

  private async hasOffscreenDocument(): Promise<boolean> {
    const runtime = chrome.runtime as any;
    const contexts = await runtime.getContexts({
      contextTypes: [runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
    });
    return contexts.length > 0;
  }

  private markOffscreenReady(): void {
    this._offscreenReady = true;
    for (const resolve of this.offscreenReadyResolvers) {
      resolve();
    }
    this.offscreenReadyResolvers = [];

    // Sync WebSocket state from offscreen to ensure connection status is accurate
    this.getWebSocketState().catch(() => {
      // Ignore errors during startup sync
    });
  }

  private async waitForOffscreenReady(timeoutMs: number = 5000): Promise<void> {
    if (this._offscreenReady) return;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.offscreenReadyResolvers = this.offscreenReadyResolvers.filter((r) => r !== resolve);
        reject(new Error("Offscreen document ready timeout"));
      }, timeoutMs);

      this.offscreenReadyResolvers.push(() => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  private async ensureOffscreenDocument(): Promise<void> {
    const exists = await this.hasOffscreenDocument();

    if (exists && this._offscreenReady) {
      logOffscreen.debug("Offscreen document already exists and ready");
      return;
    }

    if (exists && !this._offscreenReady) {
      logOffscreen.debug("Offscreen exists but not ready, waiting...");
      try {
        await this.waitForOffscreenReady(3000);
        logOffscreen.debug("Offscreen is now ready");
        return;
      } catch {
        logOffscreen.warn("Offscreen not ready after timeout, recreating...");
        await chrome.offscreen.closeDocument();
        this._offscreenReady = false;
      }
    }

    // Avoid creating multiple offscreen documents
    if (this.creatingOffscreen) {
      await this.creatingOffscreen;
      return;
    }

    logOffscreen.info("Creating offscreen document...");
    this._offscreenReady = false;
    this.creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: "Running WASM with synchronous network access for zome calls",
    });

    await this.creatingOffscreen;
    this.creatingOffscreen = null;
    logOffscreen.info("Offscreen document created, waiting for ready...");

    try {
      await this.waitForOffscreenReady(10000);
      logOffscreen.info("Offscreen document ready");
    } catch {
      logOffscreen.error("Offscreen document failed to become ready");
      throw new Error("Offscreen document initialization failed");
    }
  }

  /** Whether the network has been configured on the offscreen document. */
  get networkConfigured(): boolean {
    return this._networkConfigured;
  }
}
