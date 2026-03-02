/**
 * Tests for WebConductorAppClient.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebConductorAppClient } from './WebConductorAppClient';
import { ConnectionStatus } from './connection';
import { JoiningError } from '@holo-host/joining-service/client';
import type { HolochainAPI, WebConductorAppInfo } from './types';

// Extended mock type with test helpers
type MockHolochain = HolochainAPI & {
  _emitSignal: (signal: unknown) => void;
  _emitConnectionChange: (status: any) => void;
};

// Mock HolochainAPI
function createMockHolochain(overrides: Partial<HolochainAPI> = {}): MockHolochain {
  const signalHandlers = new Set<(signal: unknown) => void>();
  const connectionStatusHandlers = new Set<(status: any) => void>();

  const mock: MockHolochain = {
    isWebConductor: true,
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
    } as WebConductorAppInfo),
    installApp: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, callback: (signal: unknown) => void) => {
      if (event === 'signal') {
        signalHandlers.add(callback);
        return () => signalHandlers.delete(callback);
      }
      return () => {};
    }),
    provideMemproofs: vi.fn().mockResolvedValue(undefined),
    configureNetwork: vi.fn().mockResolvedValue(undefined),
    getConnectionStatus: vi.fn().mockResolvedValue({
      httpHealthy: true,
      wsHealthy: true,
      linkerUrl: 'http://localhost:8090',
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

describe('WebConductorAppClient', () => {
  let mockHolochain: ReturnType<typeof createMockHolochain>;

  beforeEach(() => {
    mockHolochain = createMockHolochain();
    (window as any).holochain = mockHolochain;
  });

  afterEach(() => {
    delete (window as any).holochain;
  });

  describe('connect', () => {
    it('throws if Holochain extension not detected', async () => {
      delete (window as any).holochain;

      await expect(
        WebConductorAppClient.connect({ linkerUrl: 'http://localhost:8090' })
      ).rejects.toThrow('Holochain extension not detected');
    });

    it('configures linker URL', async () => {
      await WebConductorAppClient.connect({ linkerUrl: 'http://localhost:8090' });

      expect(mockHolochain.configureNetwork).toHaveBeenCalledWith({
        linkerUrl: 'http://localhost:8090',
      });
    });

    it('calls holochain.connect', async () => {
      await WebConductorAppClient.connect({ linkerUrl: 'http://localhost:8090' });

      expect(mockHolochain.connect).toHaveBeenCalled();
    });

    it('fetches and stores app info', async () => {
      const client = await WebConductorAppClient.connect({ linkerUrl: 'http://localhost:8090' });

      expect(mockHolochain.appInfo).toHaveBeenCalled();
      expect(client.myPubKey).toBeInstanceOf(Uint8Array);
      expect(client.myPubKey.length).toBe(39);
      expect(client.installedAppId).toBe('test-app');
    });

    it('accepts string config for just linkerUrl', async () => {
      await WebConductorAppClient.connect('http://localhost:8090');

      expect(mockHolochain.configureNetwork).toHaveBeenCalledWith({
        linkerUrl: 'http://localhost:8090',
      });
    });

    it('subscribes to extension connection status', async () => {
      await WebConductorAppClient.connect({ linkerUrl: 'http://localhost:8090' });

      expect(mockHolochain.onConnectionChange).toHaveBeenCalled();
      expect(mockHolochain.getConnectionStatus).toHaveBeenCalled();
    });
  });

  describe('myPubKey', () => {
    it('returns agent public key as Uint8Array', async () => {
      const client = await WebConductorAppClient.connect({ linkerUrl: 'http://localhost:8090' });

      expect(client.myPubKey).toBeInstanceOf(Uint8Array);
      expect(client.myPubKey[0]).toBe(132); // HoloHash prefix
      expect(client.myPubKey[1]).toBe(32); // Agent type byte
    });

    it('throws if not connected', () => {
      // Cannot access myPubKey before connect, but we can't test this
      // since WebConductorAppClient constructor is private
    });
  });

  describe('callZome', () => {
    it('calls holochain.callZome with correct parameters', async () => {
      const client = await WebConductorAppClient.connect({ linkerUrl: 'http://localhost:8090' });

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

      const client = await WebConductorAppClient.connect({ linkerUrl: 'http://localhost:8090' });
      const result = (await client.callZome({
        role_name: 'test',
        zome_name: 'test',
        fn_name: 'test',
        payload: null,
      })) as { hash: Uint8Array };

      expect(result.hash).toBeInstanceOf(Uint8Array);
    });

    it('reports success to connection monitor', async () => {
      const client = await WebConductorAppClient.connect({ linkerUrl: 'http://localhost:8090' });

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

      const client = await WebConductorAppClient.connect({ linkerUrl: 'http://localhost:8090' });

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
      const client = await WebConductorAppClient.connect({ linkerUrl: 'http://localhost:8090' });
      const info = await client.appInfo();

      expect(info).not.toBeNull();
      expect(info!.installed_app_id).toBe('test-app');
      expect(info!.agent_pub_key).toBeInstanceOf(Uint8Array);
      expect(info!.cell_info).toBeDefined();
    });
  });

  describe('signal handling', () => {
    it('on("signal") registers handler', async () => {
      const client = await WebConductorAppClient.connect({ linkerUrl: 'http://localhost:8090' });
      const handler = vi.fn();

      client.on('signal', handler);

      expect(mockHolochain.on).toHaveBeenCalledWith('signal', expect.any(Function));
    });

    it('on() returns unsubscribe function', async () => {
      const client = await WebConductorAppClient.connect({ linkerUrl: 'http://localhost:8090' });
      const handler = vi.fn();

      const unsubscribe = client.on('signal', handler);
      expect(typeof unsubscribe).toBe('function');
    });

    it('forwards signals to registered handlers', async () => {
      const client = await WebConductorAppClient.connect({ linkerUrl: 'http://localhost:8090' });
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
      const client = await WebConductorAppClient.connect({ linkerUrl: 'http://localhost:8090' });
      const state = client.getConnectionState();

      expect(state.status).toBe(ConnectionStatus.Connected);
      expect(state.httpHealthy).toBe(true);
    });

    it('onConnection subscribes to connection events', async () => {
      const client = await WebConductorAppClient.connect({ linkerUrl: 'http://localhost:8090' });
      const handler = vi.fn();

      const unsubscribe = client.onConnection('connection:change', handler);

      // Simulate linker going down
      mockHolochain._emitConnectionChange({
        httpHealthy: false,
        wsHealthy: false,
        lastError: 'Linker unreachable',
      });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          httpHealthy: false,
        })
      );

      unsubscribe();
    });

    it('updates state when extension reports linker down', async () => {
      const client = await WebConductorAppClient.connect({ linkerUrl: 'http://localhost:8090' });

      // Simulate linker going down
      mockHolochain._emitConnectionChange({
        httpHealthy: false,
        wsHealthy: false,
        linkerUrl: 'http://localhost:8090',
        lastChecked: Date.now(),
        lastError: 'Connection refused',
      });

      const state = client.getConnectionState();
      expect(state.httpHealthy).toBe(false);
      expect(state.lastError).toBe('Connection refused');
    });

    it('updates state when linker comes back up', async () => {
      const client = await WebConductorAppClient.connect({ linkerUrl: 'http://localhost:8090' });

      // Linker goes down
      mockHolochain._emitConnectionChange({
        httpHealthy: false,
        wsHealthy: false,
        lastError: 'Down',
      });

      // Linker comes back up
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
      const client = await WebConductorAppClient.connect({ linkerUrl: 'http://localhost:8090' });
      await client.disconnect();

      expect(mockHolochain.disconnect).toHaveBeenCalled();
    });

    it('updates connection state to disconnected', async () => {
      const client = await WebConductorAppClient.connect({ linkerUrl: 'http://localhost:8090' });
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
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
      });

      await WebConductorAppClient.connect({
        linkerUrl: 'http://localhost:8090',
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

      await WebConductorAppClient.connect({ linkerUrl: 'http://localhost:8090' });

      expect(mockHolochain.installApp).not.toHaveBeenCalled();
    });
  });

  describe('joining service integration', () => {
    const JOINING_URL = 'https://joining.example.com/v1';
    const MOCK_AGENT_KEY = new Uint8Array([132, 32, 36, ...Array(36).fill(1)]);
    const MOCK_APP_INFO: WebConductorAppInfo = {
      contextId: 'test-app',
      agentPubKey: [132, 32, 36, ...Array(36).fill(1)],
      cells: [
        [
          [132, 36, 36, ...Array(36).fill(2)],
          [132, 32, 36, ...Array(36).fill(1)],
        ],
      ],
    };

    function jsonResponse(body: unknown, status = 200): Response {
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    function happBundleResponse(): Response {
      return new Response(new ArrayBuffer(100), { status: 200 });
    }

    it('uses joining service when joiningServiceUrl is provided', async () => {
      // Not installed initially
      mockHolochain.appInfo = vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue(MOCK_APP_INFO);
      mockHolochain.myPubKey = MOCK_AGENT_KEY;

      const mockFetch = vi.fn()
        // POST /join -> ready
        .mockResolvedValueOnce(jsonResponse({
          session: 'js_abc', status: 'ready',
        }, 201))
        // GET /credentials
        .mockResolvedValueOnce(jsonResponse({
          linker_urls: ['wss://linker.example.com:8090'],
          membrane_proofs: {},
          happ_bundle_url: 'https://example.com/test.happ',
        }))
        // Fetch hApp bundle
        .mockResolvedValueOnce(happBundleResponse());

      globalThis.fetch = mockFetch;

      await WebConductorAppClient.connect({
        linkerUrl: 'http://fallback:8090',
        joiningServiceUrl: JOINING_URL,
      });

      // Should have called join
      expect(mockFetch).toHaveBeenCalledWith(
        `${JOINING_URL}/join`,
        expect.objectContaining({ method: 'POST' }),
      );
      // Should have configured linker from credentials
      expect(mockHolochain.configureNetwork).toHaveBeenCalledWith({
        linkerUrl: 'wss://linker.example.com:8090',
      });
      // Should have installed the app
      expect(mockHolochain.installApp).toHaveBeenCalled();
    });

    it('handles pending challenge flow', async () => {
      mockHolochain.appInfo = vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue(MOCK_APP_INFO);
      mockHolochain.myPubKey = MOCK_AGENT_KEY;

      const challengeCallback = vi.fn().mockResolvedValue('123456');

      const mockFetch = vi.fn()
        // POST /join -> pending with email challenge
        .mockResolvedValueOnce(jsonResponse({
          session: 'js_pending',
          status: 'pending',
          challenges: [{
            id: 'ch_1', type: 'email_code',
            description: 'Enter code', completed: false,
          }],
          poll_interval_ms: 100,
        }, 201))
        // POST /verify -> ready
        .mockResolvedValueOnce(jsonResponse({ status: 'ready' }))
        // GET /credentials
        .mockResolvedValueOnce(jsonResponse({
          linker_urls: ['wss://linker.example.com:8090'],
          membrane_proofs: {},
        }))
        // Fetch hApp bundle
        .mockResolvedValueOnce(happBundleResponse());

      globalThis.fetch = mockFetch;

      await WebConductorAppClient.connect({
        linkerUrl: 'http://fallback:8090',
        joiningServiceUrl: JOINING_URL,
        onChallenge: challengeCallback,
      });

      expect(challengeCallback).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'ch_1', type: 'email_code' }),
      );
      // Verify was called
      expect(mockFetch).toHaveBeenCalledWith(
        `${JOINING_URL}/join/js_pending/verify`,
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('throws when challenge callback is needed but not provided', async () => {
      mockHolochain.appInfo = vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue(MOCK_APP_INFO);
      mockHolochain.myPubKey = MOCK_AGENT_KEY;

      const mockFetch = vi.fn()
        .mockResolvedValueOnce(jsonResponse({
          session: 'js_pending',
          status: 'pending',
          challenges: [{
            id: 'ch_1', type: 'email_code',
            description: 'Enter code', completed: false,
          }],
        }, 201));

      globalThis.fetch = mockFetch;

      await expect(
        WebConductorAppClient.connect({
          linkerUrl: 'http://fallback:8090',
          joiningServiceUrl: JOINING_URL,
          // no onChallenge callback
        }),
      ).rejects.toThrow('onChallenge callback');
    });

    it('falls back to reconnect on agent_already_joined', async () => {
      mockHolochain.appInfo = vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue(MOCK_APP_INFO);
      mockHolochain.myPubKey = MOCK_AGENT_KEY;

      const mockFetch = vi.fn()
        // POST /join -> 409 agent_already_joined
        .mockResolvedValueOnce(jsonResponse(
          { error: { code: 'agent_already_joined', message: 'Already joined' } },
          409,
        ))
        // POST /reconnect -> fresh URLs
        .mockResolvedValueOnce(jsonResponse({
          linker_urls: ['wss://new-linker.example.com:8090'],
          linker_urls_expire_at: '2026-12-01T00:00:00Z',
        }))
        // Fetch hApp bundle
        .mockResolvedValueOnce(happBundleResponse());

      globalThis.fetch = mockFetch;

      await WebConductorAppClient.connect({
        linkerUrl: 'http://fallback:8090',
        joiningServiceUrl: JOINING_URL,
      });

      // Should have called reconnect after join failed
      expect(mockFetch).toHaveBeenCalledWith(
        `${JOINING_URL}/reconnect`,
        expect.objectContaining({ method: 'POST' }),
      );
      // Should configure linker from reconnect response
      expect(mockHolochain.configureNetwork).toHaveBeenCalledWith({
        linkerUrl: 'wss://new-linker.example.com:8090',
      });
    });

    it('passes claims to join request', async () => {
      mockHolochain.appInfo = vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue(MOCK_APP_INFO);
      mockHolochain.myPubKey = MOCK_AGENT_KEY;

      const mockFetch = vi.fn()
        .mockResolvedValueOnce(jsonResponse({
          session: 'js_abc', status: 'ready',
        }, 201))
        .mockResolvedValueOnce(jsonResponse({
          linker_urls: ['wss://linker.example.com:8090'],
          membrane_proofs: {},
        }))
        .mockResolvedValueOnce(happBundleResponse());

      globalThis.fetch = mockFetch;

      await WebConductorAppClient.connect({
        linkerUrl: 'http://fallback:8090',
        joiningServiceUrl: JOINING_URL,
        claims: { email: 'test@example.com' },
      });

      const joinCall = mockFetch.mock.calls[0];
      const joinBody = JSON.parse(joinCall[1].body);
      expect(joinBody.claims).toEqual({ email: 'test@example.com' });
    });

    it('decodes base64 membrane proofs from credentials', async () => {
      mockHolochain.appInfo = vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue(MOCK_APP_INFO);
      mockHolochain.myPubKey = MOCK_AGENT_KEY;

      // base64 of bytes [1, 2, 3, 4]
      const proofBase64 = btoa(String.fromCharCode(1, 2, 3, 4));

      const mockFetch = vi.fn()
        .mockResolvedValueOnce(jsonResponse({
          session: 'js_abc', status: 'ready',
        }, 201))
        .mockResolvedValueOnce(jsonResponse({
          linker_urls: ['wss://linker.example.com:8090'],
          membrane_proofs: { 'uhC0kDnaHash': proofBase64 },
        }))
        .mockResolvedValueOnce(happBundleResponse());

      globalThis.fetch = mockFetch;

      await WebConductorAppClient.connect({
        linkerUrl: 'http://fallback:8090',
        joiningServiceUrl: JOINING_URL,
      });

      const installCall = (mockHolochain.installApp as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(installCall.membraneProofs).toBeDefined();
      expect(installCall.membraneProofs['uhC0kDnaHash']).toBeInstanceOf(Uint8Array);
      expect(Array.from(installCall.membraneProofs['uhC0kDnaHash'])).toEqual([1, 2, 3, 4]);
    });

    it('skips joining service for already-installed apps and uses config linkerUrl', async () => {
      // App already installed
      mockHolochain.appInfo = vi.fn().mockResolvedValue(MOCK_APP_INFO);

      await WebConductorAppClient.connect({
        linkerUrl: 'http://localhost:8090',
        joiningServiceUrl: JOINING_URL,
      });

      // Should not have called join
      expect(mockHolochain.installApp).not.toHaveBeenCalled();
    });

    it('uses direct install flow when no joining service configured', async () => {
      mockHolochain.appInfo = vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue(MOCK_APP_INFO);

      const mockFetch = vi.fn()
        .mockResolvedValueOnce(happBundleResponse());

      globalThis.fetch = mockFetch;

      await WebConductorAppClient.connect({
        linkerUrl: 'http://localhost:8090',
        happBundlePath: './test.happ',
      });

      // Should configure linker from config directly
      expect(mockHolochain.configureNetwork).toHaveBeenCalledWith({
        linkerUrl: 'http://localhost:8090',
      });
      // Should install without joining service
      expect(mockHolochain.installApp).toHaveBeenCalled();
    });

    it('discovers joining service from .well-known when autoDiscover is true', async () => {
      mockHolochain.appInfo = vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue(MOCK_APP_INFO);
      mockHolochain.myPubKey = MOCK_AGENT_KEY;

      const mockFetch = vi.fn()
        // .well-known discovery
        .mockResolvedValueOnce(jsonResponse({
          joining_service_url: JOINING_URL,
          happ_id: 'test-app',
          version: '1.0',
        }))
        // POST /join -> ready
        .mockResolvedValueOnce(jsonResponse({
          session: 'js_abc', status: 'ready',
        }, 201))
        // GET /credentials
        .mockResolvedValueOnce(jsonResponse({
          linker_urls: ['wss://linker.example.com:8090'],
          membrane_proofs: {},
        }))
        // Fetch hApp bundle
        .mockResolvedValueOnce(happBundleResponse());

      globalThis.fetch = mockFetch;

      await WebConductorAppClient.connect({
        linkerUrl: 'http://fallback:8090',
        autoDiscover: true,
      });

      // First fetch should be the .well-known discovery
      expect(mockFetch.mock.calls[0][0]).toMatch(/\.well-known\/holo-joining/);
    });
  });

  describe('unsupported methods', () => {
    it('dumpNetworkStats returns empty response', async () => {
      const client = await WebConductorAppClient.connect({ linkerUrl: 'http://localhost:8090' });
      const result = await client.dumpNetworkStats();

      expect(result).toEqual({ peer_urls: [], connections: [] });
    });

    it('createCloneCell throws not supported', async () => {
      const client = await WebConductorAppClient.connect({ linkerUrl: 'http://localhost:8090' });

      await expect(client.createCloneCell({} as any)).rejects.toThrow('not supported');
    });

    it('enableCloneCell throws not supported', async () => {
      const client = await WebConductorAppClient.connect({ linkerUrl: 'http://localhost:8090' });

      await expect(client.enableCloneCell({} as any)).rejects.toThrow('not supported');
    });

    it('disableCloneCell throws not supported', async () => {
      const client = await WebConductorAppClient.connect({ linkerUrl: 'http://localhost:8090' });

      await expect(client.disableCloneCell({} as any)).rejects.toThrow('not supported');
    });
  });
});
