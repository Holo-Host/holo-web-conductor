/**
 * Vitest setup file
 * Runs before all tests
 */

import { webcrypto } from 'crypto';
import 'fake-indexeddb/auto';

// Polyfill crypto for libsodium-wrappers 0.8.0 in node environment
if (!globalThis.crypto) {
  globalThis.crypto = webcrypto as unknown as Crypto;
}

// Global setup can go here
console.log('[Vitest] IndexedDB polyfill loaded');
