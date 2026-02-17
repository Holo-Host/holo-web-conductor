/**
 * @hwc/shared - Shared types and utilities for Fishy
 *
 * This package contains common types, interfaces, and utilities
 * used across the Fishy mono-repo.
 *
 * NOTE: Use @holochain/client for Holochain types (AgentPubKey, DnaHash, etc.)
 */

// Logger utility
export { createLogger, setLogFilter, getLogFilter, type Logger } from './logger';

// Basic result type for operations
export type FishyResult<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export function ok<T>(value: T): FishyResult<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): FishyResult<never, E> {
  return { ok: false, error };
}
