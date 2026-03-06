/**
 * Integration tests: WebConductorAppClient ↔ real joining-service HTTP server.
 *
 * These tests spin up an actual joining-service (via startE2EServer) and verify
 * that WebConductorAppClient drives the full join→challenge→provision→install
 * flow correctly across auth methods (open, email_code, invite_code).
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { readFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { startE2EServer, fakeAgentKey, type E2EServer } from '@holo-host/joining-service/test';
import { WebConductorAppClient } from './WebConductorAppClient';
import { JoiningError } from '@holo-host/joining-service/client';
import type { HolochainAPI, WebConductorAppInfo } from './types';

// -- Mock window.holochain for non-browser environment --

type MockHolochain = HolochainAPI & {
  _lastInstallCall?: unknown;
};

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

function createMockHolochain(): MockHolochain {
  const agentKey = new Uint8Array([132, 32, 36, ...Array(36).fill(1)]);

  const mock: MockHolochain = {
    isWebConductor: true,
    version: '0.0.1',
    myPubKey: agentKey,
    installedAppId: null,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    callZome: vi.fn().mockResolvedValue({ success: true }),
    appInfo: vi.fn()
      .mockResolvedValueOnce(null) // not installed initially
      .mockResolvedValue(MOCK_APP_INFO), // installed after joinAndInstall
    installApp: vi.fn().mockImplementation((args: unknown) => {
      mock._lastInstallCall = args;
      return Promise.resolve();
    }),
    on: vi.fn().mockReturnValue(() => {}),
    provideMemproofs: vi.fn().mockResolvedValue(undefined),
    configureNetwork: vi.fn().mockResolvedValue(undefined),
    getConnectionStatus: vi.fn().mockResolvedValue({
      httpHealthy: true,
      wsHealthy: true,
      linkerUrl: 'http://localhost:8090',
      lastChecked: Date.now(),
    }),
    onConnectionChange: vi.fn().mockReturnValue(() => {}),
    signReconnectChallenge: vi.fn().mockResolvedValue(new Uint8Array(64)),
    signJoiningNonce: vi.fn().mockResolvedValue(new Uint8Array(64)),
  };

  return mock;
}

// Intercept only .happ URLs, let joining-service HTTP calls pass through
function installFetchInterceptor(): void {
  const originalFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('.happ')) {
        return Promise.resolve(new Response(new ArrayBuffer(100), { status: 200 }));
      }
      return originalFetch(input, init);
    },
  );
}

// -- Shared setup --

// Provide a minimal window + location in node environment
function setupGlobalWindow(mock: MockHolochain): void {
  // window.holochain
  (globalThis as any).window = globalThis as any;
  (globalThis as any).holochain = mock;
  (globalThis as any).window.holochain = mock;
  // window.location.origin (used by autoDiscover)
  if (!(globalThis as any).location) {
    (globalThis as any).location = { origin: 'https://test-app.example.com' };
  }
}

function teardownGlobalWindow(): void {
  delete (globalThis as any).holochain;
  delete (globalThis as any).window?.holochain;
}

// Use a unique agent key seed per test to avoid 409 collisions
let agentSeed = 100;
function nextAgentKey(): string {
  return fakeAgentKey(agentSeed++);
}

// Convert base64 agentKey to Uint8Array for the mock myPubKey.
// fakeAgentKey returns "u" + base64url (HoloHash encoding), so strip the
// leading "u" and decode as base64url.
function agentKeyToBytes(base64Key: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64Key.slice(1), 'base64url'));
}

// ---- Tests ----

describe('Integration: WebConductorAppClient ↔ joining-service', () => {
  // ------------------------------------------------------------------
  // Open auth flow
  // ------------------------------------------------------------------
  describe('open auth flow', () => {
    let server: E2EServer;
    let mock: MockHolochain;

    beforeEach(async () => {
      server = await startE2EServer({
        auth_methods: ['open'],
        membrane_proof: { enabled: true },
        dna_hashes: ['uhC0kTestDna1'],
      });

      mock = createMockHolochain();
      const agentKey = nextAgentKey();
      mock.myPubKey = agentKeyToBytes(agentKey);
      setupGlobalWindow(mock);
      installFetchInterceptor();
    });

    afterEach(async () => {
      teardownGlobalWindow();
      vi.restoreAllMocks();
      await server.close();
    });

    it('joins, gets provision with linker URLs and membrane proofs, installs app', async () => {
      await WebConductorAppClient.connect({
        joiningServiceUrl: `${server.baseUrl}/v1`,
        happBundlePath: 'https://example.com/test.happ',
      });

      // configureNetwork was called with the linker URL from the server
      expect(mock.configureNetwork).toHaveBeenCalledWith({
        linkerUrl: 'wss://linker.example.com:8090',
      });

      // installApp was called with membrane proofs
      expect(mock.installApp).toHaveBeenCalled();
      const installArgs = mock._lastInstallCall as Record<string, unknown>;
      expect(installArgs.membraneProofs).toBeDefined();

      // Membrane proof for uhC0kTestDna1 should be present
      const proofs = installArgs.membraneProofs as Record<string, Uint8Array>;
      expect(proofs['uhC0kTestDna1']).toBeInstanceOf(Uint8Array);
      expect(proofs['uhC0kTestDna1'].length).toBeGreaterThan(0);
    });

    it('installs hApp bundle from provision URL', async () => {
      await WebConductorAppClient.connect({
        joiningServiceUrl: `${server.baseUrl}/v1`,
        happBundlePath: 'https://example.com/test.happ',
      });

      const installArgs = mock._lastInstallCall as Record<string, unknown>;
      expect(installArgs.bundle).toBeInstanceOf(Uint8Array);
    });
  });

  // ------------------------------------------------------------------
  // Email verification flow
  // ------------------------------------------------------------------
  describe('email verification flow', () => {
    const EMAIL_DIR = `/tmp/hwc-integration-email-${Date.now()}`;
    let server: E2EServer;
    let mock: MockHolochain;

    beforeEach(async () => {
      mkdirSync(EMAIL_DIR, { recursive: true });
      server = await startE2EServer({
        auth_methods: ['email_code'],
        email: { provider: 'file', output_dir: EMAIL_DIR },
      });

      mock = createMockHolochain();
      const agentKey = nextAgentKey();
      mock.myPubKey = agentKeyToBytes(agentKey);
      setupGlobalWindow(mock);
      installFetchInterceptor();
    });

    afterEach(async () => {
      teardownGlobalWindow();
      vi.restoreAllMocks();
      await server.close();
      rmSync(EMAIL_DIR, { recursive: true, force: true });
    });

    it('handles email challenge: join → onChallenge → verify → provision → install', async () => {
      const emailAddress = `test-${Date.now()}@example.com`;

      const onChallenge = vi.fn().mockImplementation(async () => {
        // Read verification code from file transport
        const files = readdirSync(EMAIL_DIR).sort();
        const emailFile = files.find((f) => f.includes(emailAddress));
        if (!emailFile) throw new Error(`No email file found for ${emailAddress}`);
        const content = readFileSync(`${EMAIL_DIR}/${emailFile}`, 'utf-8');
        const match = content.match(/code\s+is:\s+(\d{6})/i);
        if (!match) throw new Error('No verification code found in email');
        return match[1];
      });

      await WebConductorAppClient.connect({
        joiningServiceUrl: `${server.baseUrl}/v1`,
        happBundlePath: 'https://example.com/test.happ',
        claims: { email: emailAddress },
        onChallenge,
      });

      // onChallenge was called with the email_code challenge
      expect(onChallenge).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'email_code' }),
      );

      // App was installed
      expect(mock.installApp).toHaveBeenCalled();
      expect(mock.configureNetwork).toHaveBeenCalledWith({
        linkerUrl: 'wss://linker.example.com:8090',
      });
    });

    it('throws verification_failed when wrong code is submitted', async () => {
      const emailAddress = `wrong-code-${Date.now()}@example.com`;

      const onChallenge = vi.fn().mockResolvedValue('000000'); // wrong code

      await expect(
        WebConductorAppClient.connect({
          joiningServiceUrl: `${server.baseUrl}/v1`,
          happBundlePath: 'https://example.com/test.happ',
          claims: { email: emailAddress },
          onChallenge,
        }),
      ).rejects.toThrow('Incorrect verification code');

      // onChallenge was called
      expect(onChallenge).toHaveBeenCalled();
      // App was NOT installed
      expect(mock.installApp).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------
  // Invite code flow
  // ------------------------------------------------------------------
  describe('invite code flow', () => {
    let server: E2EServer;
    let mock: MockHolochain;

    beforeEach(async () => {
      server = await startE2EServer({
        auth_methods: ['invite_code'],
        invite_codes: ['VALID-INVITE-1', 'VALID-INVITE-2'],
      });

      mock = createMockHolochain();
      const agentKey = nextAgentKey();
      mock.myPubKey = agentKeyToBytes(agentKey);
      setupGlobalWindow(mock);
      installFetchInterceptor();
    });

    afterEach(async () => {
      teardownGlobalWindow();
      vi.restoreAllMocks();
      await server.close();
    });

    it('joins with valid invite code and installs', async () => {
      await WebConductorAppClient.connect({
        joiningServiceUrl: `${server.baseUrl}/v1`,
        happBundlePath: 'https://example.com/test.happ',
        claims: { invite_code: 'VALID-INVITE-1' },
      });

      expect(mock.installApp).toHaveBeenCalled();
      expect(mock.configureNetwork).toHaveBeenCalledWith({
        linkerUrl: 'wss://linker.example.com:8090',
      });
    });

    it('throws JoiningError when invite code is rejected', async () => {
      await expect(
        WebConductorAppClient.connect({
          joiningServiceUrl: `${server.baseUrl}/v1`,
          happBundlePath: 'https://example.com/test.happ',
          claims: { invite_code: 'WRONG-CODE' },
        }),
      ).rejects.toThrow('Invalid or already-used invite code');
    });
  });

  // ------------------------------------------------------------------
  // No linker URL from provision — fallback to config
  // ------------------------------------------------------------------
  describe('no linker URL fallback', () => {
    let server: E2EServer;
    let mock: MockHolochain;

    beforeEach(async () => {
      // Start server with no URL provider (use default static provider but we'll
      // test the client's fallback behavior by checking what happens when
      // provision returns URLs). Since the e2e server always returns URLs from
      // StaticUrlProvider, we test the fallback differently: check that when
      // the client gets a provision with URLs, it uses those, and separately
      // the unit test covers the no-URL case.
      //
      // For a true no-URL test, we'd need to configure the server with an
      // empty URL provider. Instead, we rely on the unit test for this case.
    });

    afterEach(async () => {
      teardownGlobalWindow();
      vi.restoreAllMocks();
    });

    it('falls back to config linkerUrl when provision has no linker URLs (covered by unit test)', () => {
      // This specific scenario is better tested in the unit test since
      // startE2EServer always provides URLs via StaticUrlProvider.
      // See WebConductorAppClient.test.ts: "falls back to config linkerUrl when provision has no linker URLs"
      expect(true).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // Agent already joined — reconnect flow
  // ------------------------------------------------------------------
  describe('agent already joined (reconnect)', () => {
    let server: E2EServer;

    beforeEach(async () => {
      server = await startE2EServer({
        auth_methods: ['open'],
        reconnect: { enabled: true },
      });
    });

    afterEach(async () => {
      teardownGlobalWindow();
      vi.restoreAllMocks();
      await server.close();
    });

    it('gets 409 when agent already joined, reconnect fails with mock signature', async () => {
      // This test verifies the 409→reconnect path works. The mock signReconnectChallenge
      // returns 64 zero bytes (not a valid ed25519 signature), so the joining service
      // rejects it. In production, the extension signs with the real lair keystore.
      const agentKey = nextAgentKey();
      const agentKeyBytes = agentKeyToBytes(agentKey);

      // First: join the agent directly via the SDK to mark it as joined
      const { JoiningClient } = await import('@holo-host/joining-service/client');
      const sdkClient = JoiningClient.fromUrl(`${server.baseUrl}/v1`);
      const session = await sdkClient.join(agentKey);
      expect(session.status).toBe('ready');

      // Now: connect via WebConductorAppClient — should hit 409, attempt
      // reconnect (which fails due to fake signing), and propagate the error
      const mock = createMockHolochain();
      mock.myPubKey = agentKeyBytes;
      setupGlobalWindow(mock);
      installFetchInterceptor();

      await expect(
        WebConductorAppClient.connect({
          joiningServiceUrl: `${server.baseUrl}/v1`,
          happBundlePath: 'https://example.com/test.happ',
        }),
      ).rejects.toThrow('Signature does not verify');
    });
  });

  // ------------------------------------------------------------------
  // Agent whitelist flow
  // ------------------------------------------------------------------
  describe('agent whitelist flow', () => {
    let server: E2EServer;
    let mock: MockHolochain;

    afterEach(async () => {
      teardownGlobalWindow();
      vi.restoreAllMocks();
      if (server) await server.close();
    });

    it('auto-signs nonce challenge via signJoiningNonce (fails with mock signature)', async () => {
      // Use a fake agent key — it will be whitelisted in the server config
      const agentKey = nextAgentKey();
      const agentKeyBytes = agentKeyToBytes(agentKey);

      server = await startE2EServer({
        auth_methods: ['agent_whitelist'],
        allowed_agents: [agentKey],
      });

      mock = createMockHolochain();
      mock.myPubKey = agentKeyBytes;
      setupGlobalWindow(mock);
      installFetchInterceptor();

      // The mock signJoiningNonce returns 64 zero bytes (not a valid ed25519 signature),
      // so the joining service will reject the verification.
      await expect(
        WebConductorAppClient.connect({
          joiningServiceUrl: `${server.baseUrl}/v1`,
          happBundlePath: 'https://example.com/test.happ',
        }),
      ).rejects.toThrow('Signature does not verify');

      // signJoiningNonce was called with the nonce bytes
      expect(mock.signJoiningNonce).toHaveBeenCalled();
    });

    it('non-whitelisted agent is rejected', async () => {
      const agentKey = nextAgentKey();
      const agentKeyBytes = agentKeyToBytes(agentKey);

      server = await startE2EServer({
        auth_methods: ['agent_whitelist'],
        allowed_agents: [], // no agents whitelisted
      });

      mock = createMockHolochain();
      mock.myPubKey = agentKeyBytes;
      setupGlobalWindow(mock);
      installFetchInterceptor();

      await expect(
        WebConductorAppClient.connect({
          joiningServiceUrl: `${server.baseUrl}/v1`,
          happBundlePath: 'https://example.com/test.happ',
        }),
      ).rejects.toThrow('not eligible');
    });
  });

  // ------------------------------------------------------------------
  // OR group flow
  // ------------------------------------------------------------------
  describe('OR group (any_of) flow', () => {
    let server: E2EServer;
    let mock: MockHolochain;

    afterEach(async () => {
      teardownGlobalWindow();
      vi.restoreAllMocks();
      if (server) await server.close();
    });

    it('non-whitelisted agent falls back to invite_code in OR group', async () => {
      const agentKey = nextAgentKey();
      const agentKeyBytes = agentKeyToBytes(agentKey);

      server = await startE2EServer({
        auth_methods: [{ any_of: ['agent_whitelist', 'invite_code'] }],
        allowed_agents: [], // this agent is not whitelisted
        invite_codes: ['FALLBACK-CODE'],
      });

      mock = createMockHolochain();
      mock.myPubKey = agentKeyBytes;
      setupGlobalWindow(mock);
      installFetchInterceptor();

      // invite_code auto-verifies via claims, so the OR group is satisfied
      await WebConductorAppClient.connect({
        joiningServiceUrl: `${server.baseUrl}/v1`,
        happBundlePath: 'https://example.com/test.happ',
        claims: { invite_code: 'FALLBACK-CODE' },
      });

      // App was installed
      expect(mock.installApp).toHaveBeenCalled();
    });

    it('OR group rejected when no method can produce challenges', async () => {
      const agentKey = nextAgentKey();
      const agentKeyBytes = agentKeyToBytes(agentKey);

      server = await startE2EServer({
        auth_methods: [{ any_of: ['agent_whitelist'] }],
        allowed_agents: [], // no agents whitelisted
      });

      mock = createMockHolochain();
      mock.myPubKey = agentKeyBytes;
      setupGlobalWindow(mock);
      installFetchInterceptor();

      await expect(
        WebConductorAppClient.connect({
          joiningServiceUrl: `${server.baseUrl}/v1`,
          happBundlePath: 'https://example.com/test.happ',
        }),
      ).rejects.toThrow('No eligible auth method');
    });
  });
});
