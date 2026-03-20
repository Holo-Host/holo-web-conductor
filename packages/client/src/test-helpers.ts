/**
 * Shared test helpers for client package tests.
 */

import { vi } from 'vitest';
import type { HolochainAPI, WebConductorAppInfo } from './types';

export type MockHolochain = HolochainAPI & {
  _emitSignal: (signal: unknown) => void;
  _emitConnectionChange: (status: any) => void;
  _lastInstallCall?: unknown;
};

export const MOCK_APP_INFO: WebConductorAppInfo = {
  contextId: 'test-app',
  agentPubKey: [132, 32, 36, ...Array(36).fill(1)],
  cells: [
    [
      [132, 36, 36, ...Array(36).fill(2)],
      [132, 32, 36, ...Array(36).fill(1)],
    ],
  ],
};

export const MOCK_AGENT_KEY = new Uint8Array([132, 32, 36, ...Array(36).fill(1)]);

export function createMockHolochain(overrides: Partial<HolochainAPI> = {}): MockHolochain {
  const signalHandlers = new Set<(signal: unknown) => void>();
  const connectionStatusHandlers = new Set<(status: any) => void>();

  const mock: MockHolochain = {
    isWebConductor: true,
    version: '0.6.1',
    myPubKey: null,
    installedAppId: null,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    callZome: vi.fn().mockResolvedValue({ success: true }),
    appInfo: vi.fn().mockResolvedValue(MOCK_APP_INFO),
    installApp: vi.fn().mockImplementation((args: unknown) => {
      mock._lastInstallCall = args;
      return Promise.resolve();
    }),
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
    signReconnectChallenge: vi.fn().mockResolvedValue(new Uint8Array(64)),
    signJoiningNonce: vi.fn().mockResolvedValue(new Uint8Array(64)),
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
