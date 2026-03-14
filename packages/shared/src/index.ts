/**
 * @hwc/shared - Shared types and utilities for Holochain Web Conductor
 *
 * This package contains common types, interfaces, and utilities
 * used across the holo-web-conductor mono-repo.
 *
 * NOTE: Use @holochain/client for Holochain types (AgentPubKey, DnaHash, etc.)
 */

// Logger utility
export { createLogger, setLogFilter, getLogFilter, type Logger } from './logger';

// Basic result type for operations
export type HwcResult<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): HwcResult<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): HwcResult<never, E> {
  return { ok: false, error };
}

// Passphrase policy
export const MIN_PASSPHRASE_LENGTH = 8;
