/**
 * Runtime context detection for Holochain hApp UIs.
 *
 * A single hApp UI build can run in multiple runtime contexts (HWC browser
 * extension, Kangaroo/Launcher, Moss, bare dev mode). Rather than probing
 * for each runtime at startup, the **wrapping context** declares which
 * runtime is in play via a small config script that sets a global variable.
 *
 * Resolution order:
 *   1. `window.__HOLOCHAIN_RUNTIME__` (set by runtime-config.js or equivalent)
 *   2. `?runtime=` query parameter
 *   3. Probed from well-known environment globals (Launcher, Moss)
 *   4. `"dev"` (default fallback)
 *
 * @example Declaring the runtime (in runtime-config.js served alongside the app):
 * ```js
 * window.__HOLOCHAIN_RUNTIME__ = "hwc";
 * ```
 *
 * @example Reading the runtime in a hApp UI:
 * ```typescript
 * import { getRuntime, Runtime } from '@holo-host/web-conductor-client/runtime';
 *
 * const runtime = getRuntime();
 * if (runtime === Runtime.HWC) {
 *   // show extension flow
 * }
 * ```
 *
 * @packageDocumentation
 */

/**
 * Known Holochain runtime contexts.
 */
export enum Runtime {
  /** Holo Web Conductor browser extension */
  HWC = 'hwc',
  /** Holochain Launcher / Kangaroo (native app shell) */
  Launcher = 'launcher',
  /** Moss container */
  Moss = 'moss',
  /** Bare development mode (direct admin/app websocket) */
  Dev = 'dev',
}

declare global {
  interface Window {
    __HOLOCHAIN_RUNTIME__?: string;
    __HC_LAUNCHER_ENV__?: unknown;
    __MOSS_ENV__?: unknown;
  }
}

/** Cached result so detection only runs once. */
let cached: Runtime | null = null;

/**
 * Detect the current Holochain runtime context.
 *
 * The result is cached after the first call. To force re-detection
 * (e.g. after changing the value from the console), call {@link resetRuntime}.
 */
export function getRuntime(): Runtime {
  if (cached !== null) return cached;
  cached = detect();
  return cached;
}

/**
 * Clear the cached runtime so the next {@link getRuntime} call re-detects.
 * Useful for development/debugging from the browser console.
 */
export function resetRuntime(): void {
  cached = null;
}

function detect(): Runtime {
  // 1. Explicit global (set by runtime-config.js or from the console)
  if (typeof window !== 'undefined' && window.__HOLOCHAIN_RUNTIME__) {
    const value = window.__HOLOCHAIN_RUNTIME__.toLowerCase();
    if (isValidRuntime(value)) return value;
  }

  // 2. Query parameter
  if (typeof window !== 'undefined' && window.location?.search) {
    const params = new URLSearchParams(window.location.search);
    const qp = params.get('runtime')?.toLowerCase();
    if (qp && isValidRuntime(qp)) return qp;
  }

  // 3. Probe well-known environment globals
  if (typeof window !== 'undefined') {
    if (window.__HC_LAUNCHER_ENV__ !== undefined) return Runtime.Launcher;
    if (window.__MOSS_ENV__ !== undefined) return Runtime.Moss;
  }

  // 4. Default
  return Runtime.Dev;
}

function isValidRuntime(value: string): value is Runtime {
  return Object.values(Runtime).includes(value as Runtime);
}
