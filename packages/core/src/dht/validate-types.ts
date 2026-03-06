/**
 * Validation Callback Types
 *
 * Types for the validate callback result and unresolved dependencies,
 * matching Holochain's holochain_integrity_types/src/validate.rs
 */

import type { AgentPubKey } from "@holochain/client";

/**
 * Result of a validate callback invocation.
 *
 * Externally tagged enum matching Rust's ValidateCallbackResult.
 */
export type ValidateCallbackResult =
  | "Valid"
  | { Invalid: string }
  | { UnresolvedDependencies: UnresolvedDependencies };

/**
 * Unresolved dependencies that are either a set of hashes
 * or an agent activity query.
 *
 * Externally tagged enum matching Rust's UnresolvedDependencies.
 */
export type UnresolvedDependencies =
  | { Hashes: Uint8Array[] }
  | { AgentActivity: [AgentPubKey, ChainFilter] };

/**
 * Chain filter for agent activity queries.
 *
 * Simplified for HWC - full implementation would match
 * holochain_integrity_types/src/chain.rs
 */
export interface ChainFilter {
  chain_top: Uint8Array;
  filters: ChainFilters;
}

/**
 * Filter variants for chain queries.
 */
export type ChainFilters =
  | { Until: Uint8Array[] }
  | { Take: number };
