/**
 * @fishy/shared - Shared types and utilities for Fishy
 *
 * This package contains common types, interfaces, and utilities
 * used across the Fishy mono-repo.
 */

// Holochain-compatible type definitions
export type AgentPubKey = Uint8Array;
export type DnaHash = Uint8Array;
export type ActionHash = Uint8Array;
export type EntryHash = Uint8Array;
export type AnyDhtHash = Uint8Array;

// 32-byte hashes used throughout Holochain
export const HASH_LENGTH = 32;

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
