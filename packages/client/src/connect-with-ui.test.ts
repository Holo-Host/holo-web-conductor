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

/** Flush pending microtasks (Promises). */
function flushMicrotasks(): Promise<void> {
  return new Promise((r) => queueMicrotask(r));
}

describe('connectWithJoiningUI', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    mockConnect.mockReset();
    mockFromUrl.mockReset();
  });

  afterEach(() => {
    container.remove();
  });

  it('mounts status and challenge dialog, cleans up on success', async () => {
    const fakeClient = {} as WebConductorAppClient;
    mockConnect.mockResolvedValue(fakeClient);

    const connectPromise = connectWithJoiningUI({
      linkerUrl: 'http://localhost:8090',
      mountTo: container,
    });

    // Wait for componentRegistration (mocked, resolves immediately) and
    // the connect mock to resolve.
    await flushMicrotasks();
    await flushMicrotasks();

    // Status and challenge dialog should be mounted
    expect(container.querySelector('joining-status-sl')).not.toBeNull();
    expect(container.querySelector('joining-challenge-dialog-sl')).not.toBeNull();

    // Wait for the full flow (including 800ms success delay)
    const client = await connectPromise;
    expect(client).toBe(fakeClient);

    // Elements cleaned up after success
    expect(container.querySelector('joining-status-sl')).toBeNull();
    expect(container.querySelector('joining-challenge-dialog-sl')).toBeNull();
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

  it('leaves error UI visible on failure', async () => {
    mockConnect.mockRejectedValue(new Error('Connection failed'));

    await expect(
      connectWithJoiningUI({
        linkerUrl: 'http://localhost:8090',
        mountTo: container,
      }),
    ).rejects.toThrow('Connection failed');

    // Status element should still be mounted with error
    const statusEl = container.querySelector('joining-status-sl') as StubStatusEl;
    expect(statusEl).not.toBeNull();
    expect(statusEl.status).toBe('error');
    expect(statusEl.reason).toBe('Connection failed');
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
