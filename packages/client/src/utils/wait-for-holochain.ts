/**
 * Utility for detecting the Holochain browser extension.
 */

import type { HolochainAPI } from '../types';

declare global {
  interface Window {
    holochain?: HolochainAPI;
  }
}

/**
 * Wait for the Holochain extension to be ready.
 *
 * The extension injects window.holochain when loaded. This function waits
 * for that injection to complete.
 *
 * @param timeoutMs - Maximum time to wait (default 5000ms)
 * @returns Promise that resolves when extension is ready
 * @throws Error if extension not detected within timeout
 *
 * @example
 * ```typescript
 * await waitForHolochain();
 * const client = await WebConductorAppClient.connect({ linkerUrl: 'http://localhost:8090' });
 * ```
 */
export function waitForHolochain(timeoutMs: number = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    // Check if already ready
    if (window.holochain?.isWebConductor) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      reject(
        new Error('Holochain extension not detected. Please install the Holochain browser extension.')
      );
    }, timeoutMs);

    // Listen for the ready event from the extension
    window.addEventListener(
      'holochain:ready',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
  });
}

/**
 * Check if the Holochain extension is available.
 *
 * @returns true if Holochain extension is detected
 */
export function isWebConductorAvailable(): boolean {
  return window.holochain?.isWebConductor === true;
}
