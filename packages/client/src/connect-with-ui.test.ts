/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the dynamic import of Shoelace components (runs at module level)
vi.mock('@holo-host/joining-service/ui/shoelace', () => ({}));

// Mock JoiningClient
vi.mock('@holo-host/joining-service/client', () => ({
  JoiningClient: {
    fromUrl: vi.fn(),
    discover: vi.fn(),
  },
}));

// Mock WebConductorAppClient.connect
vi.mock('./WebConductorAppClient', () => ({
  WebConductorAppClient: {
    connect: vi.fn(),
  },
}));

import { connectWithJoiningUI } from './connect-with-ui';
import { WebConductorAppClient } from './WebConductorAppClient';
import { JoiningClient } from '@holo-host/joining-service/client';
import { createMockHolochain } from './test-helpers';

// Stub custom elements so document.createElement returns elements with
// the properties/methods that connectWithJoiningUI expects.
class StubStatusEl extends HTMLElement {
  status = 'idle';
  reason?: string;
}

class StubChallengeDialogEl extends HTMLElement {
  promptResolve?: (value: string) => void;
  prompt(challenge: unknown): Promise<string> {
    return new Promise((resolve) => {
      this.promptResolve = resolve;
    });
  }
}

class StubClaimsFormEl extends HTMLElement {
  authMethods: unknown[] = [];
}

// Register stub elements (guard against duplicate registration in watch mode)
function safeDefine(name: string, ctor: CustomElementConstructor) {
  if (!customElements.get(name)) {
    customElements.define(name, ctor);
  }
}
safeDefine('joining-status-sl', StubStatusEl);
safeDefine('joining-challenge-dialog-sl', StubChallengeDialogEl);
safeDefine('joining-claims-form-sl', StubClaimsFormEl);

const mockConnect = vi.mocked(WebConductorAppClient.connect);
const mockFromUrl = vi.mocked(JoiningClient.fromUrl);

/** Flush pending microtasks (Promises) — runs multiple rounds. */
async function flushMicrotasks(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((r) => queueMicrotask(r));
  }
}

describe('connectWithJoiningUI', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    mockConnect.mockReset();
    mockFromUrl.mockReset();

    // Mock window.holochain so Phase 1 (extension detection) passes.
    // appInfo returns null to simulate a fresh install (no app installed yet),
    // so the joining flow is exercised rather than the "already installed" shortcut.
    window.holochain = createMockHolochain({
      myPubKey: new Uint8Array(39),
      appInfo: vi.fn().mockResolvedValue(null),
    });
  });

  afterEach(() => {
    container.remove();
    delete (window as any).holochain;
  });

  it('mounts overlay during extension approval, cleans up on success', async () => {
    const fakeClient = {} as WebConductorAppClient;
    mockConnect.mockResolvedValue(fakeClient);

    const client = await connectWithJoiningUI({
      linkerUrl: 'http://localhost:8090',
      mountTo: container,
    });

    expect(client).toBe(fakeClient);

    // Overlay cleaned up after success
    expect(container.children.length).toBe(0);
  });

  it('passes claims and onChallenge to WebConductorAppClient.connect', async () => {
    const fakeClient = {} as WebConductorAppClient;
    mockConnect.mockResolvedValue(fakeClient);

    await connectWithJoiningUI({
      linkerUrl: 'http://localhost:8090',
      claims: { invite_code: 'ABC' },
      mountTo: container,
    });

    expect(mockConnect).toHaveBeenCalledOnce();
    const passedConfig = mockConnect.mock.calls[0][0];
    expect(passedConfig).toMatchObject({
      linkerUrl: 'http://localhost:8090',
      claims: { invite_code: 'ABC' },
    });
    expect(typeof passedConfig.onChallenge).toBe('function');
  });

  it('shows claims form when joining service requires interactive auth', async () => {
    const fakeClient = {} as WebConductorAppClient;
    // Delay connect resolution so we can check intermediate state
    let resolveConnect: (v: WebConductorAppClient) => void;
    mockConnect.mockReturnValue(
      new Promise((r) => { resolveConnect = r; }),
    );

    mockFromUrl.mockReturnValue({
      getInfo: vi.fn().mockResolvedValue({
        happ: { id: 'test', name: 'Test' },
        auth_methods: ['invite_code'],
      }),
    } as unknown as ReturnType<typeof JoiningClient.fromUrl>);

    const connectPromise = connectWithJoiningUI({
      joiningServiceUrl: 'https://joining.example.com/v1',
      mountTo: container,
    });

    // Flush: componentRegistration + getInfo()
    await flushMicrotasks();
    await flushMicrotasks();
    await flushMicrotasks();

    // Claims form should be mounted
    const claimsForm = container.querySelector('joining-claims-form-sl');
    expect(claimsForm).not.toBeNull();

    // Simulate user submitting claims
    claimsForm!.dispatchEvent(
      new CustomEvent('claims-submitted', {
        detail: { claims: { invite_code: 'MY_CODE' } },
        bubbles: true,
      }),
    );

    // Now connect() will be called; resolve it
    await flushMicrotasks();
    resolveConnect!(fakeClient);

    const client = await connectPromise;
    expect(client).toBe(fakeClient);

    // Claims should have been passed to connect()
    const passedConfig = mockConnect.mock.calls[0][0];
    expect(passedConfig.claims).toEqual({ invite_code: 'MY_CODE' });
  });

  it('skips claims form for open auth', async () => {
    const fakeClient = {} as WebConductorAppClient;
    mockConnect.mockResolvedValue(fakeClient);
    mockFromUrl.mockReturnValue({
      getInfo: vi.fn().mockResolvedValue({
        happ: { id: 'test', name: 'Test' },
        auth_methods: ['open'],
      }),
    } as unknown as ReturnType<typeof JoiningClient.fromUrl>);

    await connectWithJoiningUI({
      joiningServiceUrl: 'https://joining.example.com/v1',
      mountTo: container,
    });

    // connect() should have been called without showing claims form
    expect(mockConnect).toHaveBeenCalledOnce();
  });

  it('shows error with retry button on failure', async () => {
    mockConnect.mockRejectedValueOnce(new Error('Connection failed'));

    // Start the connect flow (it will catch the error and show retry UI)
    const connectPromise = connectWithJoiningUI({
      linkerUrl: 'http://localhost:8090',
      mountTo: container,
    });

    // Flush microtasks so the error is caught and retry UI is shown
    await flushMicrotasks();

    // The overlay card should contain the error message and retry button
    const retryBtn = container.querySelector('button');
    expect(retryBtn).not.toBeNull();
    expect(retryBtn!.textContent).toBe('Retry');
    expect(container.textContent).toContain('Connection failed');

    // Click retry, this time connect succeeds
    const fakeClient = {} as WebConductorAppClient;
    mockConnect.mockResolvedValueOnce(fakeClient);
    retryBtn!.click();

    const client = await connectPromise;
    expect(client).toBe(fakeClient);
  });

  it('skips claims form when claims are pre-provided', async () => {
    const fakeClient = {} as WebConductorAppClient;
    mockConnect.mockResolvedValue(fakeClient);
    mockFromUrl.mockReturnValue({
      getInfo: vi.fn().mockResolvedValue({
        happ: { id: 'test', name: 'Test' },
        auth_methods: ['invite_code'],
      }),
    } as unknown as ReturnType<typeof JoiningClient.fromUrl>);

    await connectWithJoiningUI({
      joiningServiceUrl: 'https://joining.example.com/v1',
      claims: { invite_code: 'ALREADY_HAVE' },
      mountTo: container,
    });

    // Should not show claims form since claims were pre-provided
    expect(mockConnect).toHaveBeenCalledOnce();
    expect(mockConnect.mock.calls[0][0].claims).toEqual({ invite_code: 'ALREADY_HAVE' });
  });
});
