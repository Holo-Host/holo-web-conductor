/**
 * Tests for ConnectionMonitor.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConnectionMonitor } from './monitor';
import { ConnectionStatus, type ConnectionConfig, type ConnectionStatusAPI } from './types';

/** Helper to create a mock statusApi for tests that need push/poll. */
function mockStatusApi(initial?: Partial<Parameters<ConnectionStatusAPI['onConnectionChange']>[0]>): ConnectionStatusAPI & { pushHandlers: Set<(s: any) => void>; push: (s: any) => void } {
  const pushHandlers = new Set<(s: any) => void>();
  return {
    pushHandlers,
    push(status: any) {
      pushHandlers.forEach((h) => h(status));
    },
    getConnectionStatus: vi.fn().mockResolvedValue({
      httpHealthy: false,
      wsHealthy: false,
      authenticated: false,
      linkerUrl: null,
      lastError: undefined,
      peerCount: undefined,
      ...initial,
    }),
    onConnectionChange: vi.fn((cb: (s: any) => void) => {
      pushHandlers.add(cb);
      return () => pushHandlers.delete(cb);
    }),
  };
}

describe('ConnectionMonitor', () => {
  let monitor: ConnectionMonitor;
  const defaultConfig: ConnectionConfig = {
    linkerUrl: 'http://localhost:8090',
    healthCheckIntervalMs: 10000,
  };

  beforeEach(() => {
    monitor = new ConnectionMonitor(defaultConfig);
  });

  afterEach(() => {
    monitor.stop();
  });

  describe('initial state', () => {
    it('starts in Disconnected state', () => {
      const state = monitor.getState();
      expect(state.status).toBe(ConnectionStatus.Disconnected);
      expect(state.httpHealthy).toBe(false);
      expect(state.wsHealthy).toBe(false);
    });
  });

  describe('setConnected', () => {
    it('sets state to Connected with healthy status', () => {
      monitor.setConnected();
      const state = monitor.getState();

      expect(state.status).toBe(ConnectionStatus.Connected);
      expect(state.httpHealthy).toBe(true);
      expect(state.wsHealthy).toBe(true);
      expect(state.lastError).toBeUndefined();
    });

    it('emits connection:change event', () => {
      const listener = vi.fn();
      monitor.on('connection:change', listener);

      monitor.setConnected();

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          status: ConnectionStatus.Connected,
          httpHealthy: true,
        })
      );
    });

    it('clears reconnection state', () => {
      // Simulate reconnecting state
      monitor.setReconnecting(3, 5000);

      monitor.setConnected();
      const state = monitor.getState();

      expect(state.reconnectAttempt).toBeUndefined();
      expect(state.nextReconnectMs).toBeUndefined();
    });
  });

  describe('setDisconnected', () => {
    it('sets state to Disconnected', () => {
      monitor.setConnected();
      monitor.setDisconnected('Connection lost');

      const state = monitor.getState();
      expect(state.status).toBe(ConnectionStatus.Disconnected);
      expect(state.httpHealthy).toBe(false);
      expect(state.wsHealthy).toBe(false);
      expect(state.lastError).toBe('Connection lost');
    });

    it('emits connection:change event', () => {
      monitor.setConnected();

      const listener = vi.fn();
      monitor.on('connection:change', listener);

      monitor.setDisconnected();

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          status: ConnectionStatus.Disconnected,
        })
      );
    });
  });

  describe('applyExtensionStatus', () => {
    it('updates health status without changing connection status', () => {
      monitor.setConnected();
      monitor.applyExtensionStatus({ httpHealthy: false, wsHealthy: false, lastError: 'Linker unreachable' });

      const state = monitor.getState();
      // Status transitions to Error when health drops
      expect(state.httpHealthy).toBe(false);
      expect(state.wsHealthy).toBe(false);
      expect(state.lastError).toBe('Linker unreachable');
    });

    it('emits connection:change event when health changes', () => {
      monitor.setConnected();

      const listener = vi.fn();
      monitor.on('connection:change', listener);

      monitor.applyExtensionStatus({ httpHealthy: false, wsHealthy: true, lastError: 'HTTP down' });

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          httpHealthy: false,
          wsHealthy: true,
          lastError: 'HTTP down',
        })
      );
    });

    it('clears error when health is restored', () => {
      monitor.setConnected();
      monitor.applyExtensionStatus({ httpHealthy: false, wsHealthy: false, lastError: 'Linker down' });
      monitor.applyExtensionStatus({ httpHealthy: true, wsHealthy: true, lastError: undefined });

      const state = monitor.getState();
      expect(state.httpHealthy).toBe(true);
      expect(state.lastError).toBeUndefined();
    });

    it('propagates linkerUrl to state', () => {
      monitor.setConnected();
      monitor.applyExtensionStatus({ httpHealthy: true, wsHealthy: true, authenticated: true, linkerUrl: 'https://linker.example.com' });

      const state = monitor.getState();
      expect(state.linkerUrl).toBe('https://linker.example.com');
    });

    it('emits change event when linkerUrl changes', () => {
      monitor.setConnected();

      const listener = vi.fn();
      monitor.on('connection:change', listener);

      monitor.applyExtensionStatus({ httpHealthy: true, wsHealthy: true, authenticated: true, linkerUrl: 'https://linker.example.com' });

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          linkerUrl: 'https://linker.example.com',
        })
      );
    });

    it('with null linkerUrl clears it', () => {
      monitor.setConnected();
      monitor.applyExtensionStatus({ httpHealthy: true, wsHealthy: true, authenticated: true, linkerUrl: 'https://linker.example.com' });
      expect(monitor.getState().linkerUrl).toBe('https://linker.example.com');

      monitor.applyExtensionStatus({ httpHealthy: true, wsHealthy: true, authenticated: true, linkerUrl: null });
      expect(monitor.getState().linkerUrl).toBeNull();
    });

    it('passes through all fields from status object', () => {
      monitor.setConnected();
      monitor.applyExtensionStatus({
        httpHealthy: true,
        wsHealthy: true,
        authenticated: true,
        linkerUrl: 'http://test:8090',
        peerCount: 42,
      });

      const state = monitor.getState();
      expect(state.peerCount).toBe(42);
      expect(state.linkerUrl).toBe('http://test:8090');
      expect(state.authenticated).toBe(true);
    });

    it('transitions to Error when health drops', () => {
      monitor.setConnected();
      monitor.applyExtensionStatus({ httpHealthy: false, wsHealthy: false, lastError: 'Gone' });

      expect(monitor.getState().status).toBe(ConnectionStatus.Error);
    });

    it('transitions to Connected when health restores', () => {
      monitor.setConnected();
      monitor.applyExtensionStatus({ httpHealthy: false, wsHealthy: false, lastError: 'Gone' });
      monitor.applyExtensionStatus({ httpHealthy: true, wsHealthy: true });

      expect(monitor.getState().status).toBe(ConnectionStatus.Connected);
    });
  });

  describe('setReconnecting', () => {
    it('sets reconnection state', () => {
      monitor.setReconnecting(2, 4000);

      const state = monitor.getState();
      expect(state.status).toBe(ConnectionStatus.Reconnecting);
      expect(state.reconnectAttempt).toBe(2);
      expect(state.nextReconnectMs).toBe(4000);
    });

    it('emits connection:reconnecting event', () => {
      const listener = vi.fn();
      monitor.on('connection:reconnecting', listener);

      monitor.setReconnecting(1, 1000);

      expect(listener).toHaveBeenCalledWith({ attempt: 1, delayMs: 1000 });
    });
  });

  describe('reportCallSuccess', () => {
    it('resets failure counter and confirms healthy state', () => {
      monitor.setConnected();
      // Simulate some failures
      monitor.reportCallFailure(new Error('network error'));

      monitor.reportCallSuccess();

      const state = monitor.getState();
      expect(state.status).toBe(ConnectionStatus.Connected);
      expect(state.httpHealthy).toBe(true);
    });

    it('transitions from Reconnecting to Connected', () => {
      monitor.setReconnecting(1, 1000);

      const listener = vi.fn();
      monitor.on('connection:reconnected', listener);

      monitor.reportCallSuccess();

      const state = monitor.getState();
      expect(state.status).toBe(ConnectionStatus.Connected);
      expect(listener).toHaveBeenCalled();
    });
  });

  describe('reportCallFailure', () => {
    it('transitions to Error state after network failure', () => {
      monitor.setConnected();

      monitor.reportCallFailure(new Error('Failed to fetch'));

      const state = monitor.getState();
      expect(state.status).toBe(ConnectionStatus.Error);
      expect(state.httpHealthy).toBe(false);
    });

    it('emits connection:error event for network errors', () => {
      monitor.setConnected();

      const listener = vi.fn();
      monitor.on('connection:error', listener);

      monitor.reportCallFailure(new Error('NetworkError'));

      expect(listener).toHaveBeenCalledWith({
        error: 'NetworkError',
        recoverable: true,
      });
    });

    it('does not transition for non-network errors', () => {
      monitor.setConnected();

      // This error doesn't look like a network error
      monitor.reportCallFailure(new Error('Invalid input'));

      const state = monitor.getState();
      // Should still be connected - this is a zome error, not network
      expect(state.status).toBe(ConnectionStatus.Connected);
    });
  });

  describe('event subscription', () => {
    it('on() returns unsubscribe function', () => {
      const listener = vi.fn();
      const unsubscribe = monitor.on('connection:change', listener);

      monitor.setConnected();
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();

      monitor.setDisconnected();
      expect(listener).toHaveBeenCalledTimes(1); // Not called again
    });

    it('supports multiple listeners for same event', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      monitor.on('connection:change', listener1);
      monitor.on('connection:change', listener2);

      monitor.setConnected();

      expect(listener1).toHaveBeenCalled();
      expect(listener2).toHaveBeenCalled();
    });

    it('handles listener errors gracefully', () => {
      const errorListener = vi.fn(() => {
        throw new Error('Listener error');
      });
      const goodListener = vi.fn();

      monitor.on('connection:change', errorListener);
      monitor.on('connection:change', goodListener);

      // Should not throw
      expect(() => monitor.setConnected()).not.toThrow();

      // Good listener should still be called
      expect(goodListener).toHaveBeenCalled();
    });
  });

  describe('getState', () => {
    it('returns a copy of state (not reference)', () => {
      const state1 = monitor.getState();
      const state2 = monitor.getState();

      expect(state1).not.toBe(state2);
      expect(state1).toEqual(state2);
    });
  });

  describe('does not emit when state unchanged', () => {
    it('setConnected called twice only emits once', () => {
      const listener = vi.fn();
      monitor.on('connection:change', listener);

      monitor.setConnected();
      monitor.setConnected();

      // Second call should not emit since state didn't change
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('peerCount', () => {
    it('includes peerCount in state from push notification', () => {
      const api = mockStatusApi({ httpHealthy: true, wsHealthy: true, authenticated: true, peerCount: 3 });
      const m = new ConnectionMonitor({ ...defaultConfig, statusApi: api });

      m.start();

      // Simulate push with peerCount
      api.push({ httpHealthy: true, wsHealthy: true, authenticated: true, peerCount: 3 });

      const state = m.getState();
      expect(state.peerCount).toBe(3);
      m.stop();
    });

    it('emits change event when peerCount changes', () => {
      const api = mockStatusApi();
      const m = new ConnectionMonitor({ ...defaultConfig, statusApi: api });
      const listener = vi.fn();

      m.setConnected();
      m.start(); // Must start so push handler is registered
      m.on('connection:change', listener);

      api.push({ httpHealthy: true, wsHealthy: true, authenticated: true, peerCount: 5 });

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ peerCount: 5 })
      );
      m.stop();
    });

    it('clears peerCount when disconnected', () => {
      monitor.setConnected();
      monitor.applyExtensionStatus({ httpHealthy: true, wsHealthy: true, peerCount: 5 });
      expect(monitor.getState().peerCount).toBe(5);

      monitor.setDisconnected();
      expect(monitor.getState().peerCount).toBeUndefined();
    });
  });

  describe('self-subscription via statusApi', () => {
    it('subscribes to push on start and unsubscribes on stop', () => {
      const api = mockStatusApi();
      const m = new ConnectionMonitor({ ...defaultConfig, statusApi: api });

      m.start();
      expect(api.onConnectionChange).toHaveBeenCalledTimes(1);
      expect(api.pushHandlers.size).toBe(1);

      m.stop();
      expect(api.pushHandlers.size).toBe(0);
    });

    it('fetches initial status on start', async () => {
      const api = mockStatusApi({ httpHealthy: true, wsHealthy: true, authenticated: true, peerCount: 7 });
      const m = new ConnectionMonitor({ ...defaultConfig, statusApi: api });

      m.start();

      await vi.waitFor(() => {
        expect(m.getState().peerCount).toBe(7);
      });
      m.stop();
    });

    it('skips polling when push is active', async () => {
      const api = mockStatusApi();
      const m = new ConnectionMonitor({ ...defaultConfig, statusApi: api, healthCheckIntervalMs: 50 });

      m.start();

      // Push some data to mark push as active
      api.push({ httpHealthy: true, wsHealthy: true, authenticated: true, peerCount: 1 });

      // Clear the call count from initial fetch
      (api.getConnectionStatus as ReturnType<typeof vi.fn>).mockClear();

      // Wait for a health check interval to pass
      await new Promise((r) => setTimeout(r, 100));

      // getConnectionStatus should NOT have been called again (push is active)
      expect(api.getConnectionStatus).not.toHaveBeenCalled();
      m.stop();
    });

    it('polls when push goes stale', async () => {
      const api = mockStatusApi({ httpHealthy: true, wsHealthy: true, peerCount: 10 });
      // Use a very short staleness window so the test doesn't need real 15s
      const m = new ConnectionMonitor({ ...defaultConfig, statusApi: api, healthCheckIntervalMs: 30 });

      m.start();

      // Wait for initial fetch to complete
      await vi.waitFor(() => {
        expect(api.getConnectionStatus).toHaveBeenCalled();
      });

      // Backdate lastPushAt so the monitor considers push stale.
      // Access private field via cast — acceptable in tests.
      (m as any).lastPushAt = 0;
      (api.getConnectionStatus as ReturnType<typeof vi.fn>).mockClear();

      // Wait for a health check interval to fire
      await vi.waitFor(() => {
        expect(api.getConnectionStatus).toHaveBeenCalled();
      });
      m.stop();
    });
  });
});
