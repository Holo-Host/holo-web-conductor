/**
 * Tests for ConnectionMonitor.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConnectionMonitor } from './monitor';
import { ConnectionStatus, type ConnectionConfig, type ConnectionState } from './types';

describe('ConnectionMonitor', () => {
  let monitor: ConnectionMonitor;
  const defaultConfig: ConnectionConfig = {
    gatewayUrl: 'http://localhost:8090',
    healthCheckIntervalMs: 10000,
  };

  beforeEach(() => {
    monitor = new ConnectionMonitor(defaultConfig);
    // Mock window.holochain
    delete (window as any).holochain;
  });

  afterEach(() => {
    monitor.stop();
    delete (window as any).holochain;
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

  describe('setGatewayHealth', () => {
    it('updates health status without changing connection status', () => {
      monitor.setConnected();
      monitor.setGatewayHealth(false, false, 'Gateway unreachable');

      const state = monitor.getState();
      // Status should still be Connected (extension is connected)
      expect(state.status).toBe(ConnectionStatus.Connected);
      // But health reflects gateway being down
      expect(state.httpHealthy).toBe(false);
      expect(state.wsHealthy).toBe(false);
      expect(state.lastError).toBe('Gateway unreachable');
    });

    it('emits connection:change event when health changes', () => {
      monitor.setConnected();

      const listener = vi.fn();
      monitor.on('connection:change', listener);

      monitor.setGatewayHealth(false, true, 'HTTP down');

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
      monitor.setGatewayHealth(false, false, 'Gateway down');
      monitor.setGatewayHealth(true, true);

      const state = monitor.getState();
      expect(state.httpHealthy).toBe(true);
      expect(state.lastError).toBeUndefined();
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
});
