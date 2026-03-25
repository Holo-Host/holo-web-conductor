/**
 * Automatic reconnection with exponential backoff.
 */

import type { ConnectionConfig, ConnectionState } from './types';
import { createLogger } from '@hwc/shared';
const log = createLogger('Reconnect');

/**
 * Handles automatic reconnection with exponential backoff.
 */
export class ReconnectionManager {
  private attempt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private isReconnecting = false;
  private cancelled = false;

  constructor(
    private config: ConnectionConfig,
    private reconnectFn: () => Promise<void>,
    private onStateChange: (state: Partial<ConnectionState>) => void
  ) {}

  /**
   * Trigger reconnection sequence.
   * Uses exponential backoff between attempts.
   */
  async reconnect(): Promise<void> {
    if (this.isReconnecting || this.cancelled) return;
    if (this.config.autoReconnect === false) return;

    this.isReconnecting = true;
    this.cancelled = false;
    this.attempt++;

    const delay = this.getDelay();

    this.onStateChange({
      reconnectAttempt: this.attempt,
      nextReconnectMs: delay,
    });

    log.debug(`Reconnect attempt ${this.attempt} in ${delay}ms`);

    await this.wait(delay);

    if (this.cancelled) {
      this.isReconnecting = false;
      return;
    }

    try {
      await this.reconnectFn();
      // Success - reset counter
      this.reset();
      log.info('Reconnection successful');
    } catch (e) {
      log.error('Reconnection failed:', e);
      this.isReconnecting = false;
      // Schedule another attempt
      this.reconnect();
    }
  }

  /**
   * Cancel ongoing reconnection.
   */
  cancel(): void {
    this.cancelled = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.isReconnecting = false;
  }

  /**
   * Reset attempt counter (call on successful connection).
   */
  reset(): void {
    this.attempt = 0;
    this.isReconnecting = false;
    this.cancelled = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Check if currently reconnecting.
   */
  isActive(): boolean {
    return this.isReconnecting;
  }

  /**
   * Get current attempt number.
   */
  getAttempt(): number {
    return this.attempt;
  }

  private getDelay(): number {
    // Exponential backoff: delay * 2^attempt, capped at max
    const baseDelay = this.config.reconnectDelayMs ?? 1000;
    const maxDelay = this.config.maxReconnectDelayMs ?? 30000;
    const delay = Math.min(baseDelay * Math.pow(2, this.attempt - 1), maxDelay);
    // Add some jitter to prevent thundering herd
    const jitter = Math.random() * 0.2 * delay;
    return Math.floor(delay + jitter);
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.timer = setTimeout(resolve, ms);
    });
  }
}
