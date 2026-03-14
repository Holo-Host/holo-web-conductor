/**
 * connectWithJoiningUI — convenience wrapper that adds Shoelace-based
 * joining UI on top of WebConductorAppClient.connect().
 *
 * Usage:
 *   import { connectWithJoiningUI } from '@holo-host/web-conductor-client/ui';
 *
 *   const client = await connectWithJoiningUI({
 *     joiningServiceUrl: 'https://joining.example.com/v1',
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

const AUTO_METHODS = new Set<string>(['open', 'agent_allow_list']);

// ---------------------------------------------------------------------------
// Overlay helpers
// ---------------------------------------------------------------------------

/** Create a full-screen overlay with a centered card. */
function createOverlay(): { overlay: HTMLElement; card: HTMLElement } {
  const overlay = document.createElement('div');
  overlay.style.cssText = [
    'position: fixed',
    'inset: 0',
    'display: flex',
    'align-items: center',
    'justify-content: center',
    'background: var(--joining-overlay-bg, transparent)',
    'z-index: 10000',
    'padding: 2rem',
  ].join(';');

  const card = document.createElement('div');
  card.style.cssText = [
    'width: 100%',
    'max-width: 28rem',
    'border-radius: 0.5rem',
    'box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1)',
    'padding: 1.5rem',
    'background: var(--joining-card-bg, #fff)',
  ].join(';');

  overlay.appendChild(card);
  return { overlay, card };
}

/** CSS-only spinner keyframes (injected once). */
let spinnerStyleInjected = false;
function injectSpinnerStyle() {
  if (spinnerStyleInjected) return;
  spinnerStyleInjected = true;
  const style = document.createElement('style');
  style.textContent = '@keyframes hwc-spin{to{transform:rotate(360deg)}}';
  document.head.appendChild(style);
}

/** Build a plain-DOM message with a CSS spinner. HWC-specific, no Shoelace. */
function createSpinnerMessage(text: string): HTMLElement {
  injectSpinnerStyle();
  const el = document.createElement('div');
  el.style.cssText = 'display:flex;align-items:center;gap:0.75rem;padding:1rem 0';

  const spinner = document.createElement('div');
  spinner.style.cssText = [
    'width: 1.5rem',
    'height: 1.5rem',
    'border: 3px solid rgba(0,0,0,0.15)',
    'border-top-color: currentColor',
    'border-radius: 50%',
    'animation: hwc-spin 0.8s linear infinite',
    'flex-shrink: 0',
  ].join(';');

  const msg = document.createElement('span');
  msg.textContent = text;

  el.appendChild(spinner);
  el.appendChild(msg);
  return el;
}

/** Build a plain-DOM error message with an optional retry button. HWC-specific, no Shoelace. */
function createErrorMessage(text: string, onRetry?: () => void): HTMLElement {
  const el = document.createElement('div');
  el.style.cssText = [
    'padding: 1rem',
    'border-radius: 0.375rem',
    'background: #fef2f2',
    'color: #991b1b',
    'border: 1px solid #fecaca',
  ].join(';');

  const msgEl = document.createElement('div');
  msgEl.textContent = text;
  el.appendChild(msgEl);

  if (onRetry) {
    const btn = document.createElement('button');
    btn.textContent = 'Retry';
    btn.style.cssText = [
      'margin-top: 0.75rem',
      'padding: 0.5rem 1.25rem',
      'border: 1px solid #b91c1c',
      'border-radius: 0.375rem',
      'background: #b91c1c',
      'color: #fff',
      'cursor: pointer',
      'font-size: 0.875rem',
      'font-weight: 500',
      'line-height: 1.25rem',
      'transition: background 0.15s',
    ].join(';');
    btn.addEventListener('mouseenter', () => { btn.style.background = '#991b1b'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = '#b91c1c'; });
    btn.addEventListener('click', onRetry);
    el.appendChild(btn);
  }

  return el;
}

/**
 * Attempt holochain.connect() showing a spinner, with retry on failure.
 * Distinguishes timeout from denial and shows the appropriate message.
 * Resolves once the connection succeeds; clears card content on success.
 */
function connectExtensionWithRetry(
  holochain: NonNullable<typeof window.holochain>,
  card: HTMLElement,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const attempt = () => {
      // Clear previous card content
      card.innerHTML = '';
      const msg = createSpinnerMessage('Waiting for approval to connect to the Holo Web Conductor extension...');
      card.appendChild(msg);

      holochain.connect().then(
        () => {
          // Success — clear card and resolve
          card.innerHTML = '';
          resolve();
        },
        (err: unknown) => {
          card.innerHTML = '';
          const errMsg = err instanceof Error ? err.message : String(err);
          const isTimeout = /timeout/i.test(errMsg);
          const url = window.location.origin;

          const text = isTimeout
            ? `Connection request to the Holo Web Conductor timed out for ${url}.`
            : `Approval for ${url} with the Holo Web Conductor was denied.`;

          const errorEl = createErrorMessage(text, attempt);
          card.appendChild(errorEl);
        },
      );
    };
    attempt();
  });
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Connect to the Web Conductor extension with a visual joining flow.
 *
 * Phase 1 — Extension approval (HWC-specific UI):
 *   Shows "Waiting for approval..." while the extension's Connection Request
 *   popup is displayed. If denied, shows an error and throws.
 *
 * Phase 2 — Joining service (joining-service UI components):
 *   If interactive claims are needed, shows the claims form in an overlay.
 *   Then connects via WebConductorAppClient which handles the join + install.
 */
export async function connectWithJoiningUI(
  config: ConnectWithJoiningUIOptions,
): Promise<WebConductorAppClient> {
  // Ensure Shoelace custom elements are registered before createElement.
  await componentRegistration;

  const mountTarget = config.mountTo ?? document.body;

  // --- Phase 1: Extension approval (HWC-specific) ---
  const holochain = window.holochain;
  if (!holochain?.isWebConductor) {
    throw new Error('Holochain extension not detected. Please install the Holochain browser extension.');
  }

  const { overlay, card } = createOverlay();
  mountTarget.appendChild(overlay);

  // Attempt extension connect with retry support
  await connectExtensionWithRetry(holochain, card);

  const cleanup = () => {
    overlay.remove();
  };

  // --- Check if already installed (skip joining UI entirely) ---
  try {
    const existingInfo = await holochain.appInfo();
    if (existingInfo?.agentPubKey && existingInfo?.cells?.length > 0) {
      // App already installed — go straight to WebConductorAppClient.connect()
      // which will handle reconnection / linker URL refresh internally.
      cleanup();
      return WebConductorAppClient.connect({
        ...config,
        skipExtensionConnect: true,
      });
    }
  } catch {
    // Not installed — continue with joining flow
  }

  // --- Phase 2: Joining service flow (agnostic joining-service UI) ---
  let statusEl: StatusEl | null = null;
  let challengeDialog: ChallengeDialogEl | null = null;

  /** Set up the joining-service UI components inside the existing overlay card. */
  const ensureJoiningUI = () => {
    if (!statusEl) {
      statusEl = document.createElement('joining-status-sl') as StatusEl;
      challengeDialog = document.createElement('joining-challenge-dialog-sl') as ChallengeDialogEl;
    }
    // Re-append if detached (e.g. after card.innerHTML was cleared by collectClaims)
    if (!card.contains(statusEl)) {
      card.innerHTML = '';
      card.appendChild(statusEl);
      card.appendChild(challengeDialog!);
    }
    return { statusEl: statusEl!, challengeDialog: challengeDialog! };
  };

  // Joining loop — allows retrying with new credentials on failure.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      let claims = config.claims;

      let authMethods: AuthMethodEntry[] | undefined;

      if (config.joiningServiceUrl || config.autoDiscover) {
        const joiningClient = config.joiningServiceUrl
          ? JoiningClient.fromUrl(config.joiningServiceUrl)
          : await JoiningClient.discover(window.location.origin);

        const info = await joiningClient.getInfo();
        authMethods = info.auth_methods;

        if (needsInteractiveClaims(authMethods) && !hasClaims(claims)) {
          const ui = ensureJoiningUI();
          ui.statusEl.status = 'collecting-claims';
          claims = await collectClaims(card, authMethods);
        }
      }

      // Show joining status if joining UI was already created for claims
      const hasJoiningUI = !!statusEl;
      if (hasJoiningUI) {
        ensureJoiningUI().statusEl.status = 'joining';
      }

      const client = await WebConductorAppClient.connect({
        ...config,
        claims,
        skipExtensionConnect: true,
        onChallenge: async (challenge) => {
          const ui = ensureJoiningUI();
          // Hide the status spinner so only the challenge input is visible
          ui.statusEl.style.display = 'none';
          const response = await ui.challengeDialog.prompt(challenge);
          // Re-show status while the join completes
          ui.statusEl.style.display = '';
          ui.statusEl.status = 'joining';
          return response;
        },
      });

      if (hasJoiningUI) {
        ensureJoiningUI().statusEl.status = 'ready';
        await delay(800);
      }
      cleanup();
      return client;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);

      // Show error with retry in the overlay card and wait for user action.
      await new Promise<void>((resolve) => {
        card.innerHTML = '';
        // Remove joining-service elements so they get re-created on retry
        statusEl = null;
        challengeDialog = null;
        const errorEl = createErrorMessage(errMsg, resolve);
        card.appendChild(errorEl);
      });
      // User clicked retry — loop again (re-collect claims + re-attempt connect)
    }
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
  return new Promise<Record<string, string>>((resolve) => {
    const showForm = () => {
      container.innerHTML = '';
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
        showCancelledMessage();
      };

      form.addEventListener('claims-submitted', onSubmit);
      form.addEventListener('claims-cancelled', onCancel);
    };

    const showCancelledMessage = () => {
      container.innerHTML = '';
      const msg = createErrorMessage(
        'To join the network you must provide your joining credential(s).',
        showForm,
      );
      container.appendChild(msg);
    };

    showForm();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
