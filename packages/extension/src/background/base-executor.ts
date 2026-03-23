/**
 * BaseExecutor — abstract base class for ZomeExecutor implementations.
 *
 * Provides concrete implementations for:
 * - WebSocket service lifecycle (init, reconnect, signal forwarding)
 * - Publish service management (publish records, process queue)
 * - Network configuration (linker URL, session token, WebSocket init)
 * - Agent registration
 * - Event callback storage and registration
 * - Recovery result normalization
 *
 * Subclasses implement worker/offscreen-specific logic (zome calls, genesis,
 * record retrieval, chain recovery) and may override network methods if they
 * delegate to a separate execution context (e.g., Chrome offscreen document).
 *
 * Zero chrome.* dependencies — platform-specific storage is delegated to
 * the abstract writeRecoveryProgress() method.
 */

import type {
  ZomeExecutor,
  ZomeCallResult,
  RecoveryResult,
  WsStateInfo,
  RemoteSignalCallback,
  SignRequestCallback,
  WsStateChangeCallback,
  SessionTokenCallback,
} from "../lib/zome-executor";
import type { ZomeCallRequest } from "@hwc/core/ribosome";
import {
  WebSocketNetworkService,
  type ConnectionState,
} from "@hwc/core/network";
import { PublishService } from "@hwc/core/dht";
import { encodeHashToBase64, decodeHashFromBase64 } from "@holochain/client";
import type { Record as HolochainRecord, DnaHash } from "@holochain/client";
import { createLogger } from "../lib/logger";

const log = createLogger("BaseExec");
const logNetwork = createLogger("Network");
const logSignal = createLogger("Signal");
const logPublish = createLogger("Publish");

export abstract class BaseExecutor implements ZomeExecutor {
  // --- Network state ---
  protected _networkConfigured = false;
  protected linkerUrl = "";
  protected sessionToken: string | null = null;

  // --- Services ---
  protected wsService: WebSocketNetworkService | null = null;
  protected publishService: PublishService | null = null;

  // --- Event callbacks ---
  protected remoteSignalCallback: RemoteSignalCallback | null = null;
  protected signRequestCallback: SignRequestCallback | null = null;
  protected wsStateChangeCallback: WsStateChangeCallback | null = null;
  protected sessionTokenChangeCallback: SessionTokenCallback | null = null;

  // ============================================================================
  // Concrete: network-configured getter
  // ============================================================================

  get networkConfigured(): boolean {
    return this._networkConfigured;
  }

  // ============================================================================
  // Concrete: network configuration
  // ============================================================================

  async configureNetwork(config: { linkerUrl: string; sessionToken?: string }): Promise<void> {
    this.linkerUrl = config.linkerUrl;
    if (config.sessionToken !== undefined) {
      this.sessionToken = config.sessionToken || null;
    }

    logNetwork.info(`Configuring network: ${this.linkerUrl}`);

    // Initialize or reconfigure WebSocket
    if (this.linkerUrl && !this.wsService) {
      this.initializeWebSocketService();
    } else if (this.wsService && this.linkerUrl) {
      const newWsUrl = this.buildWsUrl(this.linkerUrl);
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
    if (this.wsService) {
      this.wsService.setSessionToken(token || "");
    }
  }

  /**
   * Trigger WebSocket disconnect + reconnect to obtain a fresh session token.
   * Called when an HTTP request returns 401 (session revoked or invalid).
   * Skips if the WebSocket is already reconnecting/connecting/authenticating.
   */
  triggerReauth(): void {
    if (!this.wsService) {
      logNetwork.info("triggerReauth: no wsService");
      return;
    }

    const state = this.wsService.getState();
    if (state === "connecting" || state === "authenticating" || state === "reconnecting") {
      logNetwork.info("triggerReauth: skipping, WS already in state: " + state);
      return;
    }

    logNetwork.info("401 detected — triggering WS re-auth (was: " + state + ")");
    this.wsService.disconnect();
    this.wsService.connect();
  }

  // ============================================================================
  // Concrete: agent registration
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
  // Concrete: linker connectivity
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
  // Concrete: publish queue processing
  // ============================================================================

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
  // Concrete: event registration
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

  onSessionToken(callback: SessionTokenCallback): void {
    this.sessionTokenChangeCallback = callback;
  }

  // ============================================================================
  // Protected: WebSocket service lifecycle
  // ============================================================================

  protected initializeWebSocketService(): void {
    const wsUrl = this.buildWsUrl(this.linkerUrl);
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

    // Session token callback: notify subclass when linker auth provides a new token
    this.wsService.onSessionToken((token) => {
      logNetwork.info("Received session token from linker auth");
      this.sessionToken = token;
      this.onLinkerSessionToken(token);
      this.sessionTokenChangeCallback?.(token);
    });

    this.wsService.connect();
  }

  // ============================================================================
  // Protected: publishing
  // ============================================================================

  protected async publishPendingRecords(transportedRecords: any[], dnaHash: DnaHash): Promise<void> {
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

    const records = transportedRecords.map(transportedRecordToRecord);
    logPublish.info(`Publishing ${records.length} records`);

    for (const record of records) {
      try {
        await this.publishService.publishRecord(record, dnaHash);
      } catch (error) {
        logPublish.error("Failed to publish record:", error);
      }
    }
  }

  // ============================================================================
  // Protected: recovery result normalization
  // ============================================================================

  protected normalizeRecoveryResult(response: any): RecoveryResult {
    return {
      recoveredCount: response?.recoveredCount ?? 0,
      failedCount: response?.failedCount ?? 0,
      verifiedCount: response?.verifiedCount ?? 0,
      unverifiedCount: response?.unverifiedCount ?? 0,
      errors: response?.errors ?? [],
    };
  }

  // ============================================================================
  // Protected: hooks for subclasses
  // ============================================================================

  /**
   * Called when the linker WebSocket auth provides a new session token.
   * Override to propagate token to workers or other execution contexts.
   */
  protected onLinkerSessionToken(_token: string): void {
    // Default: no-op. Firefox overrides to forward to worker.
  }

  // ============================================================================
  // Abstract: platform-specific
  // ============================================================================

  /** Write recovery progress to platform-specific storage. */
  protected abstract writeRecoveryProgress(contextId: string, progress: any): void;

  abstract initialize(): Promise<void>;
  abstract isReady(): boolean;
  abstract executeZomeCall(contextId: string, request: ZomeCallRequest): Promise<ZomeCallResult>;
  abstract runGenesis(
    cellId: [number[], number[]],
    dnaWasm: number[],
    dnaManifest: unknown,
    membraneProof: number[] | null,
  ): Promise<{ pendingRecords: any[] }>;
  abstract getAllRecords(dnaHash: number[], agentPubKey: number[]): Promise<{ records: any[] }>;
  abstract recoverChain(
    contextId: string,
    dnaHashes: number[][],
    agentPubKey: number[]
  ): Promise<RecoveryResult>;

  // ============================================================================
  // Private utilities
  // ============================================================================

  private buildWsUrl(linkerUrl: string): string {
    return linkerUrl
      .replace(/^http:/, "ws:")
      .replace(/^https:/, "wss:")
      .replace(/\/$/, "") + "/ws";
  }
}

// ============================================================================
// Shared utility: transport record conversion
// ============================================================================

/**
 * Convert a transported record (number[] fields) back to a proper HolochainRecord
 * with Uint8Array fields. Used by both Firefox executor and Chrome offscreen.
 */
export function transportedRecordToRecord(transported: any): HolochainRecord {
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
