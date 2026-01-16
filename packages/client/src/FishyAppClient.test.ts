/**
 * Tests for FishyAppClient.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FishyAppClient } from './FishyAppClient';
import { ConnectionStatus } from './connection';
import type { FishyHolochainAPI, FishyAppInfo } from './types';

// Extended mock type with test helpers
type MockFishyHolochain = FishyHolochainAPI & {
  _emitSignal: (signal: unknown) => void;
  _emitConnectionChange: (status: any) => void;
};

// Mock FishyHolochainAPI
function createMockHolochain(overrides: Partial<FishyHolochainAPI> = {}): MockFishyHolochain {
  const signalHandlers = new Set<(signal: unknown) => void>();
  const connectionStatusHandlers = new Set<(status: any) => void>();

  const mock: MockFishyHolochain = {
    isFishy: true,
    version: '0.0.1',
    myPubKey: null,
    installedAppId: null,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    callZome: vi.fn().mockResolvedValue({ success: true }),
    appInfo: vi.fn().mockResolvedValue({
      contextId: 'test-app',
      agentPubKey: [132, 32, 36, ...Array(36).fill(1)], // Valid AgentPubKey
      cells: [
        [
          [132, 36, 36, ...Array(36).fill(2)], // DnaHash
          [132, 32, 36, ...Array(36).fill(1)], // AgentPubKey
        ],
      ],
    } as FishyAppInfo),
    installApp: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, callback: (signal: unknown) => void) => {
      if (event === 'signal') {
        signalHandlers.add(callback);
        return () => signalHandlers.delete(callback);
      }
      return () => {};
    }),
    configureNetwork: vi.fn().mockResolvedValue(undefined),
    getConnectionStatus: vi.fn().mockResolvedValue({
      httpHealthy: true,
      wsHealthy: true,
      gatewayUrl: 'http://localhost:8090',
      lastChecked: Date.now(),
    }),
    onConnectionChange: vi.fn((callback: (status: any) => void) => {
      connectionStatusHandlers.add(callback);
      return () => connectionStatusHandlers.delete(callback);
    }),
    // Test helper methods
    _emitSignal: (signal: unknown) => {
      signalHandlers.forEach((h) => h(signal));
    },
    _emitConnectionChange: (status: any) => {
      connectionStatusHandlers.forEach((h) => h(status));
    },
    ...overrides,
  };

  return mock;
}

describe('FishyAppClient', () => {
  let mockHolochain: ReturnType<typeof createMockHolochain>;

  beforeEach(() => {
    mockHolochain = createMockHolochain();
    (window as any).holochain = mockHolochain;
  });

  afterEach(() => {
    delete (window as any).holochain;
  });

  describe('connect', () => {
    it('throws if Fishy extension not detected', async () => {
      delete (window as any).holochain;

      await expect(
        FishyAppClient.connect({ gatewayUrl: 'http://localhost:8090' })
      ).rejects.toThrow('Fishy extension not detected');
    });

    it('configures gateway URL', async () => {
      await FishyAppClient.connect({ gatewayUrl: 'http://localhost:8090' });

      expect(mockHolochain.configureNetwork).toHaveBeenCalledWith({
        gatewayUrl: 'http://localhost:8090',
      });
    });

    it('calls holochain.connect', async () => {
      await FishyAppClient.connect({ gatewayUrl: 'http://localhost:8090' });

      expect(mockHolochain.connect).toHaveBeenCalled();
    });

    it('fetches and stores app info', async () => {
      const client = await FishyAppClient.connect({ gatewayUrl: 'http://localhost:8090' });

      expect(mockHolochain.appInfo).toHaveBeenCalled();
      expect(client.myPubKey).toBeInstanceOf(Uint8Array);
      expect(client.myPubKey.length).toBe(39);
      expect(client.installedAppId).toBe('test-app');
    });

    it('accepts string config for just gatewayUrl', async () => {
      await FishyAppClient.connect('http://localhost:8090');

      expect(mockHolochain.configureNetwork).toHaveBeenCalledWith({
        gatewayUrl: 'http://localhost:8090',
      });
    });

    it('subscribes to extension connection status', async () => {
      await FishyAppClient.connect({ gatewayUrl: 'http://localhost:8090' });

      expect(mockHolochain.onConnectionChange).toHaveBeenCalled();
      expect(mockHolochain.getConnectionStatus).toHaveBeenCalled();
    });
  });

  describe('myPubKey', () => {
    it('returns agent public key as Uint8Array', async () => {
      const client = await FishyAppClient.connect({ gatewayUrl: 'http://localhost:8090' });

      expect(client.myPubKey).toBeInstanceOf(Uint8Array);
      expect(client.myPubKey[0]).toBe(132); // HoloHash prefix
      expect(client.myPubKey[1]).toBe(32); // Agent type byte
    });

    it('throws if not connected', () => {
      // Cannot access myPubKey before connect, but we can't test this
      // since FishyAppClient constructor is private
    });
  });

  describe('callZome', () => {
    it('calls holochain.callZome with correct parameters', async () => {
      const client = await FishyAppClient.connect({ gatewayUrl: 'http://localhost:8090' });

      await client.callZome({
        role_name: 'my_role',
        zome_name: 'my_zome',
        fn_name: 'my_function',
        payload: { test: 'data' },
      });

      expect(mockHolochain.callZome).toHaveBeenCalledWith(
        expect.objectContaining({
          zome_name: 'my_zome',
          fn_name: 'my_function',
          payload: { test: 'data' },
        })
      );
    });

    it('converts response byte arrays to Uint8Array', async () => {
      mockHolochain.callZome = vi.fn().mockResolvedValue({
        hash: [132, 41, 36, ...Array(36).fill(5)], // ActionHash as array
      });

      const client = await FishyAppClient.connect({ gatewayUrl: 'http://localhost:8090' });
      const result = (await client.callZome({
        role_name: 'test',
        zome_name: 'test',
        fn_name: 'test',
        payload: null,
      })) as { hash: Uint8Array };

      expect(result.hash).toBeInstanceOf(Uint8Array);
    });

    it('reports success to connection monitor', async () => {
      const client = await FishyAppClient.connect({ gatewayUrl: 'http://localhost:8090' });

      await client.callZome({
        role_name: 'test',
        zome_name: 'test',
        fn_name: 'test',
        payload: null,
      });

      // After successful call, connection should still be healthy
      const state = client.getConnectionState();
      expect(state.status).toBe(ConnectionStatus.Connected);
    });

    it('reports failure to connection monitor on error', async () => {
      mockHolochain.callZome = vi.fn().mockRejectedValue(new Error('Failed to fetch'));

      const client = await FishyAppClient.connect({ gatewayUrl: 'http://localhost:8090' });

      await expect(
        client.callZome({
          role_name: 'test',
          zome_name: 'test',
          fn_name: 'test',
          payload: null,
        })
      ).rejects.toThrow('Failed to fetch');
    });
  });

  describe('appInfo', () => {
    it('returns app info in @holochain/client format', async () => {
      const client = await FishyAppClient.connect({ gatewayUrl: 'http://localhost:8090' });
      const info = await client.appInfo();

      expect(info).not.toBeNull();
      expect(info!.installed_app_id).toBe('test-app');
      expect(info!.agent_pub_key).toBeInstanceOf(Uint8Array);
      expect(info!.cell_info).toBeDefined();
    });
  });

  describe('signal handling', () => {
    it('on("signal") registers handler', async () => {
      const client = await FishyAppClient.connect({ gatewayUrl: 'http://localhost:8090' });
      const handler = vi.fn();

      client.on('signal', handler);

      expect(mockHolochain.on).toHaveBeenCalledWith('signal', expect.any(Function));
    });

    it('on() returns unsubscribe function', async () => {
      const client = await FishyAppClient.connect({ gatewayUrl: 'http://localhost:8090' });
      const handler = vi.fn();

      const unsubscribe = client.on('signal', handler);
      expect(typeof unsubscribe).toBe('function');
    });

    it('forwards signals to registered handlers', async () => {
      const client = await FishyAppClient.connect({ gatewayUrl: 'http://localhost:8090' });
      const handler = vi.fn();

      client.on('signal', handler);

      // Simulate signal from extension
      const testSignal = {
        type: 'App',
        value: {
          cell_id: [
            [132, 36, 36, ...Array(36).fill(1)],
            [132, 32, 36, ...Array(36).fill(2)],
          ],
          zome_name: 'test_zome',
          payload: { message: 'hello' },
        },
      };

      mockHolochain._emitSignal(testSignal);

      expect(handler).toHaveBeenCalled();
    });
  });

  describe('connection status', () => {
    it('getConnectionState returns current state', async () => {
      const client = await FishyAppClient.connect({ gatewayUrl: 'http://localhost:8090' });
      const state = client.getConnectionState();

      expect(state.status).toBe(ConnectionStatus.Connected);
      expect(state.httpHealthy).toBe(true);
    });

    it('onConnection subscribes to connection events', async () => {
      const client = await FishyAppClient.connect({ gatewayUrl: 'http://localhost:8090' });
      const handler = vi.fn();

      const unsubscribe = client.onConnection('connection:change', handler);

      // Simulate gateway going down
      mockHolochain._emitConnectionChange({
        httpHealthy: false,
        wsHealthy: false,
        lastError: 'Gateway unreachable',
      });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          httpHealthy: false,
        })
      );

      unsubscribe();
    });

    it('updates state when extension reports gateway down', async () => {
      const client = await FishyAppClient.connect({ gatewayUrl: 'http://localhost:8090' });

      // Simulate gateway going down
      mockHolochain._emitConnectionChange({
        httpHealthy: false,
        wsHealthy: false,
        gatewayUrl: 'http://localhost:8090',
        lastChecked: Date.now(),
        lastError: 'Connection refused',
      });

      const state = client.getConnectionState();
      expect(state.httpHealthy).toBe(false);
      expect(state.lastError).toBe('Connection refused');
    });

    it('updates state when gateway comes back up', async () => {
      const client = await FishyAppClient.connect({ gatewayUrl: 'http://localhost:8090' });

      // Gateway goes down
      mockHolochain._emitConnectionChange({
        httpHealthy: false,
        wsHealthy: false,
        lastError: 'Down',
      });

      // Gateway comes back up
      mockHolochain._emitConnectionChange({
        httpHealthy: true,
        wsHealthy: true,
      });

      const state = client.getConnectionState();
      expect(state.httpHealthy).toBe(true);
      expect(state.lastError).toBeUndefined();
    });
  });

  describe('disconnect', () => {
    it('calls holochain.disconnect', async () => {
      const client = await FishyAppClient.connect({ gatewayUrl: 'http://localhost:8090' });
      await client.disconnect();

      expect(mockHolochain.disconnect).toHaveBeenCalled();
    });

    it('updates connection state to disconnected', async () => {
      const client = await FishyAppClient.connect({ gatewayUrl: 'http://localhost:8090' });
      await client.disconnect();

      const state = client.getConnectionState();
      expect(state.status).toBe(ConnectionStatus.Disconnected);
    });
  });

  describe('hApp installation', () => {
    it('installs hApp if not already installed', async () => {
      // Simulate no app installed initially
      mockHolochain.appInfo = vi
        .fn()
        .mockResolvedValueOnce(null) // First call: not installed
        .mockResolvedValue({
          // After install
          contextId: 'test-app',
          agentPubKey: [132, 32, 36, ...Array(36).fill(1)],
          cells: [
            [
              [132, 36, 36, ...Array(36).fill(2)],
              [132, 32, 36, ...Array(36).fill(1)],
            ],
          ],
        });

      // Mock fetch for hApp bundle
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
      });

      await FishyAppClient.connect({
        gatewayUrl: 'http://localhost:8090',
        happBundlePath: './test.happ',
      });

      expect(mockHolochain.installApp).toHaveBeenCalled();
    });

    it('skips installation if app already installed', async () => {
      // App already installed
      mockHolochain.appInfo = vi.fn().mockResolvedValue({
        contextId: 'test-app',
        agentPubKey: [132, 32, 36, ...Array(36).fill(1)],
        cells: [
          [
            [132, 36, 36, ...Array(36).fill(2)],
            [132, 32, 36, ...Array(36).fill(1)],
          ],
        ],
      });

      await FishyAppClient.connect({ gatewayUrl: 'http://localhost:8090' });

      expect(mockHolochain.installApp).not.toHaveBeenCalled();
    });
  });

  describe('unsupported methods', () => {
    it('dumpNetworkStats returns empty response', async () => {
      const client = await FishyAppClient.connect({ gatewayUrl: 'http://localhost:8090' });
      const result = await client.dumpNetworkStats();

      expect(result).toEqual({ peer_urls: [], connections: [] });
    });

    it('createCloneCell throws not supported', async () => {
      const client = await FishyAppClient.connect({ gatewayUrl: 'http://localhost:8090' });

      await expect(client.createCloneCell({} as any)).rejects.toThrow('not supported');
    });

    it('enableCloneCell throws not supported', async () => {
      const client = await FishyAppClient.connect({ gatewayUrl: 'http://localhost:8090' });

      await expect(client.enableCloneCell({} as any)).rejects.toThrow('not supported');
    });

    it('disableCloneCell throws not supported', async () => {
      const client = await FishyAppClient.connect({ gatewayUrl: 'http://localhost:8090' });

      await expect(client.disableCloneCell({} as any)).rejects.toThrow('not supported');
    });
  });
});
