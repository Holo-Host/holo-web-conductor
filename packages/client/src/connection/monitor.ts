/**
 * Connection health monitoring for WebConductorAppClient.
 *
 * Monitors linker connection health via:
 * 1. Extension's connection status API
 * 2. Zome call success/failure patterns
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

    // Initial health check
    this.checkHealth();

    // Periodic health checks
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
    });
  }

  /**
   * Update linker health status without changing overall connection status.
   * Used when extension is connected but linker may be unreachable.
   *
   * Accepts a partial state object so new fields flow through automatically.
   * Note: only fields present in the object are updated. To clear a field
   * (e.g. lastError), pass it explicitly as undefined.
   */
  setLinkerHealth(status: Partial<ConnectionState>): void {
    if (this.state.wsHealthy !== (status.wsHealthy ?? this.state.wsHealthy) || this.state.authenticated !== (status.authenticated ?? this.state.authenticated)) {
      log.debug(`setLinkerHealth: ws=${status.wsHealthy} auth=${status.authenticated} (was ws=${this.state.wsHealthy} auth=${this.state.authenticated})`);
    }
    this.updateState(status);
  }

  /**
   * Set a joining service error (e.g. session expired, agent revoked).
   * This is separate from linker errors — it means the joining service
   * could not provide a linker URL for this agent.
   */
  setJoiningServiceError(error: string): void {
    this.updateState({ joiningServiceError: error });
  }

  private async checkHealth(): Promise<void> {
    try {
      // Check extension's connection status
      if (window.holochain?.getConnectionStatus) {
        const status = await window.holochain.getConnectionStatus();
        const wasHealthy = this.state.httpHealthy;
        const isHealthy = status.httpHealthy;

        // Diagnostic: log when WS/auth status changes
        if (this.state.wsHealthy !== status.wsHealthy || this.state.authenticated !== (status.authenticated ?? false)) {
          log.debug(`Status from extension: http=${status.httpHealthy} ws=${status.wsHealthy} auth=${status.authenticated} err=${status.lastError || 'none'} (was ws=${this.state.wsHealthy} auth=${this.state.authenticated})`);
        }

        if (wasHealthy && !isHealthy) {
          // Connection lost
          this.updateState({
            status: ConnectionStatus.Error,
            httpHealthy: status.httpHealthy,
            wsHealthy: status.wsHealthy,
            authenticated: status.authenticated ?? false,
            linkerUrl: status.linkerUrl,
            lastError: status.lastError || 'Linker connection lost',
            peerCount: status.peerCount,
          });
          this.emit('connection:error', {
            error: status.lastError || 'Linker connection lost',
            recoverable: true,
          });
        } else if (!wasHealthy && isHealthy) {
          // Connection restored
          this.updateState({
            status: ConnectionStatus.Connected,
            httpHealthy: true,
            wsHealthy: status.wsHealthy,
            authenticated: status.authenticated ?? false,
            linkerUrl: status.linkerUrl,
            lastError: undefined,
            peerCount: status.peerCount,
          });
          if (this.state.status === ConnectionStatus.Reconnecting) {
            this.emit('connection:reconnected', undefined as void);
          }
        } else {
          // Update state with current values
          this.updateState({
            httpHealthy: status.httpHealthy,
            wsHealthy: status.wsHealthy,
            authenticated: status.authenticated ?? false,
            linkerUrl: status.linkerUrl,
            lastError: status.lastError,
            peerCount: status.peerCount,
          });
        }
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
