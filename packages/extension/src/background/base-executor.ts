/**
 * BaseExecutor — abstract base class for ZomeExecutor implementations.
 *
 * Extracts shared state and logic common to all executor implementations:
 * - Event callback storage and registration
 * - Network-configured state tracking
 * - Recovery result normalization
 *
 * Platform-specific behavior (chrome.storage, offscreen docs, workers) stays
 * in subclasses, keeping this class free of browser API dependencies.
 */

import type {
  ZomeExecutor,
  ZomeCallResult,
  RecoveryResult,
  WsStateInfo,
  RemoteSignalCallback,
  SignRequestCallback,
  WsStateChangeCallback,
} from "../lib/zome-executor";
import type { ZomeCallRequest } from "@hwc/core/ribosome";

export abstract class BaseExecutor implements ZomeExecutor {
  // --- Network state ---
  protected _networkConfigured = false;

  // --- Event callbacks ---
  protected remoteSignalCallback: RemoteSignalCallback | null = null;
  protected signRequestCallback: SignRequestCallback | null = null;
  protected wsStateChangeCallback: WsStateChangeCallback | null = null;

  // ============================================================================
  // Concrete: network-configured getter
  // ============================================================================

  get networkConfigured(): boolean {
    return this._networkConfigured;
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

  // ============================================================================
  // Concrete: recovery result normalization
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
  // Abstract: platform-specific storage for recovery progress
  // ============================================================================

  protected abstract writeRecoveryProgress(contextId: string, progress: any): void;

  // ============================================================================
  // Abstract: ZomeExecutor interface methods
  // ============================================================================

  abstract initialize(): Promise<void>;
  abstract isReady(): boolean;
  abstract configureNetwork(config: { linkerUrl: string; sessionToken?: string }): Promise<void>;
  abstract updateSessionToken(token: string | null): Promise<void>;
  abstract registerAgent(dnaHashB64: string, agentPubKeyB64: string): Promise<void>;
  abstract executeZomeCall(contextId: string, request: ZomeCallRequest): Promise<ZomeCallResult>;
  abstract runGenesis(
    cellId: [number[], number[]],
    dnaWasm: number[],
    dnaManifest: unknown,
    membraneProof: number[] | null,
  ): Promise<{ pendingRecords: any[] }>;
  abstract getAllRecords(dnaHash: number[], agentPubKey: number[]): Promise<{ records: any[] }>;
  abstract processPublishQueue(dnaHashes: number[][]): Promise<void>;
  abstract recoverChain(
    contextId: string,
    dnaHashes: number[][],
    agentPubKey: number[]
  ): Promise<RecoveryResult>;
  abstract disconnectLinker(): Promise<void>;
  abstract reconnectLinker(): Promise<void>;
  abstract getWebSocketState(): Promise<WsStateInfo>;
}
