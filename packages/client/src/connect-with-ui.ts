/**
 * connectWithJoiningUI — convenience wrapper that adds Shoelace-based
 * joining UI on top of WebConductorAppClient.connect().
 *
 * Usage:
 *   import { connectWithJoiningUI } from '@holo-host/web-conductor-client/ui';
 *
 *   const client = await connectWithJoiningUI({
 *     joiningServiceUrl: 'https://joining.example.com/v1',
 *     mountTo: document.getElementById('join-ui')!,
 *   });
 */

import { WebConductorAppClient, type WebConductorAppClientOptions } from './WebConductorAppClient';
import { JoiningClient } from '@holo-host/joining-service/client';
import type { AuthMethodEntry, Challenge } from '@holo-host/joining-service/client';

// Side-effect import registers the Shoelace custom elements.
// Dynamic import so Lit/Shoelace are only loaded when this module is used.
const componentRegistration = import('@holo-host/joining-service/ui/shoelace');

// Inline type aliases so we can reference the element classes without
// importing Lit at the top level (the real classes arrive via the
// dynamic import above).
interface ClaimsFormEl extends HTMLElement {
  authMethods: AuthMethodEntry[];
  updateComplete: Promise<boolean>;
}

interface ChallengeDialogEl extends HTMLElement {
  prompt(challenge: Challenge): Promise<string>;
}

interface StatusEl extends HTMLElement {
  status: string;
  reason?: string;
}

export interface ConnectWithJoiningUIOptions extends WebConductorAppClientOptions {
  /** Element to mount the joining UI into. Defaults to document.body. */
  mountTo?: HTMLElement;
}

const AUTO_METHODS = new Set<string>(['open', 'agent_whitelist']);

/**
 * Connect to the Web Conductor extension with a visual joining flow.
 *
 * Shows a Shoelace-styled claims form (if the joining service requires
 * credentials), a challenge dialog (for verification steps), and a
 * status indicator. The UI is removed once the client is connected.
 */
export async function connectWithJoiningUI(
  config: ConnectWithJoiningUIOptions,
): Promise<WebConductorAppClient> {
  // Ensure Shoelace custom elements are registered before createElement.
  await componentRegistration;

  const container = config.mountTo ?? document.body;

  const statusEl = document.createElement('joining-status-sl') as StatusEl;
  const challengeDialog = document.createElement('joining-challenge-dialog-sl') as ChallengeDialogEl;
  container.appendChild(statusEl);
  container.appendChild(challengeDialog);

  const cleanup = () => {
    statusEl.remove();
    challengeDialog.remove();
  };

  try {
    statusEl.status = 'connecting';

    // Pre-fetch /info to check whether interactive claims are needed.
    let claims = config.claims;
    if (config.joiningServiceUrl || config.autoDiscover) {
      const joiningClient = config.joiningServiceUrl
        ? JoiningClient.fromUrl(config.joiningServiceUrl)
        : await JoiningClient.discover(window.location.origin);

      const info = await joiningClient.getInfo();

      if (needsInteractiveClaims(info.auth_methods) && !hasClaims(claims)) {
        statusEl.status = 'collecting-claims';
        claims = await collectClaims(container, info.auth_methods);
      }
    }

    statusEl.status = 'joining';

    const client = await WebConductorAppClient.connect({
      ...config,
      claims,
      onChallenge: async (challenge) => {
        statusEl.status = 'verifying';
        return challengeDialog.prompt(challenge);
      },
    });

    statusEl.status = 'ready';
    // Brief success display so users see the outcome.
    await delay(800);
    cleanup();
    return client;
  } catch (e) {
    statusEl.status = 'error';
    statusEl.reason = e instanceof Error ? e.message : String(e);
    // Leave error UI visible; caller can catch and remove container.
    throw e;
  }
}

/** True when at least one auth method requires user-provided credentials. */
function needsInteractiveClaims(methods: AuthMethodEntry[]): boolean {
  for (const entry of methods) {
    if (typeof entry === 'string') {
      if (!AUTO_METHODS.has(entry)) return true;
    } else if ('any_of' in entry) {
      if (entry.any_of.some((m) => !AUTO_METHODS.has(m))) return true;
    }
  }
  return false;
}

function hasClaims(claims?: Record<string, string>): boolean {
  return !!claims && Object.keys(claims).length > 0;
}

/** Show a Shoelace claims form and resolve when the user submits. */
function collectClaims(
  container: HTMLElement,
  authMethods: AuthMethodEntry[],
): Promise<Record<string, string>> {
  return new Promise<Record<string, string>>((resolve, reject) => {
    const form = document.createElement('joining-claims-form-sl') as ClaimsFormEl;
    form.authMethods = authMethods;
    container.appendChild(form);

    const onSubmit = (e: Event) => {
      const detail = (e as CustomEvent<{ claims: Record<string, string> }>).detail;
      form.removeEventListener('claims-submitted', onSubmit);
      form.removeEventListener('claims-cancelled', onCancel);
      form.remove();
      resolve(detail.claims);
    };

    const onCancel = () => {
      form.removeEventListener('claims-submitted', onSubmit);
      form.removeEventListener('claims-cancelled', onCancel);
      form.remove();
      reject(new Error('Join cancelled by user'));
    };

    form.addEventListener('claims-submitted', onSubmit);
    form.addEventListener('claims-cancelled', onCancel);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
