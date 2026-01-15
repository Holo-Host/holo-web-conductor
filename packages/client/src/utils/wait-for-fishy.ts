/**
 * Utility for detecting the Fishy browser extension.
 */

import type { FishyHolochainAPI } from '../types';

declare global {
  interface Window {
    holochain?: FishyHolochainAPI;
  }
}

/**
 * Wait for the Fishy extension to be ready.
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
 * await waitForFishy();
 * const client = await FishyAppClient.connect({ gatewayUrl: 'http://localhost:8090' });
 * ```
 */
export function waitForFishy(timeoutMs: number = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    // Check if already ready
    if (window.holochain?.isFishy) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      reject(
        new Error('Fishy extension not detected. Please install the Fishy browser extension.')
      );
    }, timeoutMs);

    // Listen for the ready event from the extension
    window.addEventListener(
      'fishy:ready',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
  });
}

/**
 * Check if the Fishy extension is available.
 *
 * @returns true if Fishy extension is detected
 */
export function isFishyAvailable(): boolean {
  return window.holochain?.isFishy === true;
}
