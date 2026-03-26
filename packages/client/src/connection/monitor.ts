/**
 * Connection health monitoring for WebConductorAppClient.
 *
 * Monitors linker connection health via:
 * 1. Push notifications from the extension (authoritative, real-time)
 * 2. Polling via getConnectionStatus() (fallback when push goes silent)
 * 3. Zome call success/failure patterns (client-side heuristics)
 *
 * Extension-sourced fields (httpHealthy, wsHealthy, authenticated, linkerUrl,
 * lastError, peerCount) always come from the extension — the monitor never
 * independently guesses their values.
 *
 * Client-only fields (status, reconnectAttempt, nextReconnectMs,
 * joiningServiceError) are managed locally.
 */

import type {
  ConnectionConfig,
  ConnectionState,
  ConnectionEventMap,
  ConnectionEventListener,
} from './types';
import { ConnectionStatus } from './types';
import { createLogger } from '@hwc/shared';
const log = createLogger('ConnectionMonitor');

/**
 * Monitors linker connection health and emits events on state changes.
 */
export class ConnectionMonitor {
  private state: ConnectionState;
  private listeners = new Map<keyof ConnectionEventMap, Set<ConnectionEventListener<any>>>();
  private healthCheckTimer?: ReturnType<typeof setInterval>;
  private consecutiveFailures = 0;
  private readonly MAX_FAILURES_BEFORE_UNHEALTHY = 1;

  /** Timestamp of last push notification from the extension. */
  private lastPushAt = 0;
  /** If push is fresher than this, skip polling. */
  private readonly PUSH_STALENESS_MS = 15000;
  /** Unsubscribe handle for onConnectionChange push listener. */
  private unsubPush?: () => void;

  constructor(private config: ConnectionConfig) {
    this.state = {
      status: ConnectionStatus.Disconnected,
      httpHealthy: false,
      wsHealthy: false,
      authenticated: false,
    };
  }

  /**
   * Start health monitoring.
   * Called automatically when WebConductorAppClient connects.
   */
  start(): void {
    if (this.healthCheckTimer) return;

    // Subscribe to push notifications from the extension if available.
    const api = this.config.statusApi;
    if (api) {
      this.unsubPush = api.onConnectionChange((status) => {
        this.applyExtensionStatus(status);
      });

      // Fetch current status to catch events that fired before we subscribed.
      api.getConnectionStatus().then((status) => {
        this.applyExtensionStatus(status);
      }).catch(() => {
        // Extension not ready yet — will get push or poll later
      });
    }

    // Initial health check
    this.checkHealth();

    // Periodic health checks (fallback when push channel is silent)
    const interval = this.config.healthCheckIntervalMs ?? 10000;
    this.healthCheckTimer = setInterval(() => this.checkHealth(), interval);
  }

  /**
   * Stop health monitoring.
   */
  stop(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
    if (this.unsubPush) {
      this.unsubPush();
      this.unsubPush = undefined;
    }
  }

  /**
   * Get current connection state.
   */
  getState(): ConnectionState {
    return { ...this.state };
  }

  /**
   * Subscribe to connection events.
   *
   * @param event - Event name to subscribe to
   * @param callback - Function to call when event fires
   * @returns Unsubscribe function
   */
  on<K extends keyof ConnectionEventMap>(
    event: K,
    callback: ConnectionEventListener<K>
  ): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);

    return () => {
      this.listeners.get(event)?.delete(callback);
    };
  }

  /**
   * Report a successful zome call (resets failure counter).
   * Called internally by WebConductorAppClient.
   */
  reportCallSuccess(): void {
    this.consecutiveFailures = 0;

    if (this.state.status === ConnectionStatus.Reconnecting) {
      this.updateState({
        status: ConnectionStatus.Connected,
        httpHealthy: true,
        reconnectAttempt: undefined,
        nextReconnectMs: undefined,
        lastError: undefined,
      });
      this.emit('connection:reconnected', undefined as void);
    } else if (this.state.status !== ConnectionStatus.Connected) {
      this.updateState({
        status: ConnectionStatus.Connected,
        httpHealthy: true,
      });
    }
  }

  /**
   * Report a failed zome call.
   * Called internally by WebConductorAppClient.
   */
  reportCallFailure(error: Error): void {
    this.consecutiveFailures++;

    const isNetworkError =
      error.message.includes('network') ||
      error.message.includes('fetch') ||
      error.message.includes('Failed to fetch') ||
      error.message.includes('NetworkError') ||
      error.message.includes('linker');

    if (isNetworkError && this.consecutiveFailures >= this.MAX_FAILURES_BEFORE_UNHEALTHY) {
      this.updateState({
        status: ConnectionStatus.Error,
        httpHealthy: false,
        lastError: error.message,
      });
      this.emit('connection:error', { error: error.message, recoverable: true });
    }
  }

  /**
   * Update state for reconnection attempt.
   * Called by ReconnectionManager.
   */
  setReconnecting(attempt: number, delayMs: number): void {
    this.updateState({
      status: ConnectionStatus.Reconnecting,
      reconnectAttempt: attempt,
      nextReconnectMs: delayMs,
    });
    this.emit('connection:reconnecting', { attempt, delayMs });
  }

  /**
   * Mark as connected.
   */
  setConnected(): void {
    this.consecutiveFailures = 0;
    this.updateState({
      status: ConnectionStatus.Connected,
      httpHealthy: true,
      wsHealthy: true,
      lastError: undefined,
      reconnectAttempt: undefined,
      nextReconnectMs: undefined,
    });
  }

  /**
   * Mark as disconnected with error.
   */
  setDisconnected(error?: string): void {
    this.updateState({
      status: ConnectionStatus.Disconnected,
      httpHealthy: false,
      wsHealthy: false,
      lastError: error,
      peerCount: undefined,
    });
  }

  /**
   * Set a joining service error (e.g. session expired, agent revoked).
   * This is separate from linker errors — it means the joining service
   * could not provide a linker URL for this agent.
   */
  setJoiningServiceError(error: string): void {
    this.updateState({ joiningServiceError: error });
  }

  /**
   * Apply extension-sourced connection status.
   *
   * This is the single entry point for all data from the extension
   * (both push notifications and poll responses). Extension-sourced
   * fields overwrite local state; client-only fields are preserved.
   */
  applyExtensionStatus(status: {
    httpHealthy: boolean;
    wsHealthy: boolean;
    authenticated?: boolean;
    linkerUrl?: string | null;
    lastError?: string;
    peerCount?: number;
  }): void {
    this.lastPushAt = Date.now();

    const wasHealthy = this.state.httpHealthy;
    const isHealthy = status.httpHealthy;

    // Extension-sourced fields — always overwrite
    const extensionFields: Partial<ConnectionState> = {
      httpHealthy: status.httpHealthy,
      wsHealthy: status.wsHealthy,
      authenticated: status.authenticated ?? false,
      linkerUrl: status.linkerUrl,
      lastError: status.lastError,
      peerCount: status.peerCount,
    };

    if (wasHealthy && !isHealthy) {
      this.updateState({
        ...extensionFields,
        status: ConnectionStatus.Error,
      });
      this.emit('connection:error', {
        error: status.lastError || 'Linker connection lost',
        recoverable: true,
      });
    } else if (!wasHealthy && isHealthy) {
      const wasReconnecting = this.state.status === ConnectionStatus.Reconnecting;
      this.updateState({
        ...extensionFields,
        status: ConnectionStatus.Connected,
      });
      if (wasReconnecting) {
        this.emit('connection:reconnected', undefined as void);
      }
    } else {
      // Steady state — update fields without changing status
      this.updateState(extensionFields);
    }
  }

  /**
   * Poll extension for status. Only runs if push channel is stale.
   */
  private async checkHealth(): Promise<void> {
    // If push is active, skip polling — push is authoritative and faster.
    if (Date.now() - this.lastPushAt < this.PUSH_STALENESS_MS) return;

    try {
      const api = this.config.statusApi;
      if (api) {
        const status = await api.getConnectionStatus();
        this.applyExtensionStatus(status);
      }
    } catch (e) {
      // Health check failed - likely extension communication issue
      console.warn('[ConnectionMonitor] Health check failed:', e);
    }
  }

  private updateState(partial: Partial<ConnectionState>): void {
    const prevState = { ...this.state };
    this.state = { ...this.state, ...partial };

    // Emit change event if any relevant field changed
    const changed =
      prevState.status !== this.state.status ||
      prevState.httpHealthy !== this.state.httpHealthy ||
      prevState.wsHealthy !== this.state.wsHealthy ||
      prevState.authenticated !== this.state.authenticated ||
      prevState.linkerUrl !== this.state.linkerUrl ||
      prevState.lastError !== this.state.lastError ||
      prevState.reconnectAttempt !== this.state.reconnectAttempt ||
      prevState.joiningServiceError !== this.state.joiningServiceError ||
      prevState.peerCount !== this.state.peerCount;

    if (changed) {
      this.emit('connection:change', this.getState());
    }
  }

  private emit<K extends keyof ConnectionEventMap>(event: K, data: ConnectionEventMap[K]): void {
    const listeners = this.listeners.get(event);
    if (listeners) {
      listeners.forEach((callback) => {
        try {
          callback(data);
        } catch (e) {
          console.error(`[ConnectionMonitor] Error in ${event} listener:`, e);
        }
      });
    }
  }
}
