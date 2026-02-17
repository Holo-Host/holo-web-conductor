/**
 * Tests for ReconnectionManager.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ReconnectionManager } from './reconnect';
import type { ConnectionConfig, ConnectionState } from './types';

describe('ReconnectionManager', () => {
  let manager: ReconnectionManager;
  let reconnectFn: ReturnType<typeof vi.fn>;
  let onStateChange: ReturnType<typeof vi.fn>;
  const defaultConfig: ConnectionConfig = {
    linkerUrl: 'http://localhost:8090',
    autoReconnect: true,
    reconnectDelayMs: 100, // Short delays for testing
    maxReconnectDelayMs: 1000,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    reconnectFn = vi.fn().mockResolvedValue(undefined);
    onStateChange = vi.fn();
    manager = new ReconnectionManager(defaultConfig, reconnectFn, onStateChange);
  });

  afterEach(() => {
    manager.cancel();
    vi.useRealTimers();
  });

  describe('initial state', () => {
    it('is not active initially', () => {
      expect(manager.isActive()).toBe(false);
    });

    it('has zero attempts initially', () => {
      expect(manager.getAttempt()).toBe(0);
    });
  });

  describe('reconnect', () => {
    it('does nothing if autoReconnect is false', async () => {
      const config = { ...defaultConfig, autoReconnect: false };
      manager = new ReconnectionManager(config, reconnectFn, onStateChange);

      await manager.reconnect();

      expect(reconnectFn).not.toHaveBeenCalled();
    });

    it('calls reconnect function after delay', async () => {
      const promise = manager.reconnect();

      expect(manager.isActive()).toBe(true);
      expect(reconnectFn).not.toHaveBeenCalled();

      // Advance past the delay (with jitter, could be up to 120ms)
      await vi.advanceTimersByTimeAsync(200);

      expect(reconnectFn).toHaveBeenCalledTimes(1);
      await promise;
    });

    it('notifies state change with attempt info', async () => {
      manager.reconnect();

      expect(onStateChange).toHaveBeenCalledWith(
        expect.objectContaining({
          reconnectAttempt: 1,
          nextReconnectMs: expect.any(Number),
        })
      );
    });

    it('resets on successful reconnection', async () => {
      const promise = manager.reconnect();
      await vi.advanceTimersByTimeAsync(200);
      await promise;

      expect(manager.isActive()).toBe(false);
      expect(manager.getAttempt()).toBe(0);
    });

    it('retries on failure', async () => {
      reconnectFn.mockRejectedValueOnce(new Error('Connection failed'));

      manager.reconnect();

      // First attempt
      await vi.advanceTimersByTimeAsync(200);
      expect(reconnectFn).toHaveBeenCalledTimes(1);

      // Should schedule another attempt after failure
      await vi.advanceTimersByTimeAsync(500); // Exponential backoff
      expect(reconnectFn).toHaveBeenCalledTimes(2);
    });

    it('does not start multiple reconnections', async () => {
      manager.reconnect();
      manager.reconnect();
      manager.reconnect();

      await vi.advanceTimersByTimeAsync(200);

      // Should only have called once despite multiple reconnect calls
      expect(reconnectFn).toHaveBeenCalledTimes(1);
    });

    it('increments attempt counter', async () => {
      reconnectFn
        .mockRejectedValueOnce(new Error('fail 1'))
        .mockRejectedValueOnce(new Error('fail 2'))
        .mockResolvedValue(undefined);

      manager.reconnect();

      // First attempt
      expect(manager.getAttempt()).toBe(1);

      await vi.advanceTimersByTimeAsync(200);
      // After first failure, preparing second
      expect(manager.getAttempt()).toBe(2);

      await vi.advanceTimersByTimeAsync(500);
      // After second failure, preparing third
      expect(manager.getAttempt()).toBe(3);

      await vi.advanceTimersByTimeAsync(1000);
      // Third succeeds, reset
      expect(manager.getAttempt()).toBe(0);
    });
  });

  describe('exponential backoff', () => {
    it('increases delay exponentially', async () => {
      reconnectFn.mockRejectedValue(new Error('always fail'));

      manager.reconnect();

      // Capture the delays reported
      const delays: number[] = [];
      onStateChange.mockImplementation((state: Partial<ConnectionState>) => {
        if (state.nextReconnectMs) {
          delays.push(state.nextReconnectMs);
        }
      });

      // Let several attempts happen
      await vi.advanceTimersByTimeAsync(100);
      await vi.advanceTimersByTimeAsync(200);
      await vi.advanceTimersByTimeAsync(400);

      manager.cancel();

      // With jitter, delays should roughly double each time
      // baseDelay * 2^(attempt-1): 100, 200, 400, 800, 1000 (capped)
      expect(delays.length).toBeGreaterThan(1);
      // Each delay should be greater than or equal to previous (with jitter tolerance)
      for (let i = 1; i < delays.length; i++) {
        // Allow some tolerance for jitter
        expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1] * 0.8);
      }
    });

    it('caps delay at maxReconnectDelayMs', async () => {
      reconnectFn.mockRejectedValue(new Error('always fail'));

      manager.reconnect();

      // Run through many attempts
      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(2000);
      }

      manager.cancel();

      // Check that delays never exceeded max (with jitter tolerance)
      const maxWithJitter = defaultConfig.maxReconnectDelayMs! * 1.2;
      const calls = onStateChange.mock.calls;
      for (const call of calls) {
        const state = call[0] as Partial<ConnectionState>;
        if (state.nextReconnectMs) {
          expect(state.nextReconnectMs).toBeLessThanOrEqual(maxWithJitter);
        }
      }
    });
  });

  describe('cancel', () => {
    it('stops pending reconnection', async () => {
      manager.reconnect();
      expect(manager.isActive()).toBe(true);

      manager.cancel();
      expect(manager.isActive()).toBe(false);

      await vi.advanceTimersByTimeAsync(500);
      expect(reconnectFn).not.toHaveBeenCalled();
    });

    it('prevents callback after cancel', async () => {
      manager.reconnect();

      // Cancel just before delay completes
      await vi.advanceTimersByTimeAsync(50);
      manager.cancel();
      await vi.advanceTimersByTimeAsync(200);

      expect(reconnectFn).not.toHaveBeenCalled();
    });
  });

  describe('reset', () => {
    it('resets attempt counter', async () => {
      reconnectFn.mockRejectedValueOnce(new Error('fail'));

      manager.reconnect();
      await vi.advanceTimersByTimeAsync(200);

      expect(manager.getAttempt()).toBeGreaterThan(0);

      manager.reset();
      expect(manager.getAttempt()).toBe(0);
    });

    it('clears active state', () => {
      manager.reconnect();
      expect(manager.isActive()).toBe(true);

      manager.reset();
      expect(manager.isActive()).toBe(false);
    });

    it('clears any pending timer', async () => {
      manager.reconnect();
      manager.reset();

      await vi.advanceTimersByTimeAsync(500);
      expect(reconnectFn).not.toHaveBeenCalled();
    });
  });
});
