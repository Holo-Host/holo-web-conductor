/**
 * @fishy/lair - Browser-based Lair keystore implementation
 *
 * This package provides key management functionality mirroring
 * the Lair keystore for use in browser environments.
 *
 * Key features to implement:
 * - Key generation (Ed25519 for signing)
 * - Key storage (IndexedDB)
 * - Signing operations
 * - Key derivation
 */

import type { AgentPubKey } from "@fishy/shared";

// Placeholder interface - to be expanded based on Lair analysis
export interface LairClient {
  // Generate a new signing keypair
  generateSigningKeypair(): Promise<AgentPubKey>;

  // Sign data with a specific key
  sign(pubKey: AgentPubKey, data: Uint8Array): Promise<Uint8Array>;

  // List all keys
  listKeys(): Promise<AgentPubKey[]>;
}

// Placeholder export
export const VERSION = "0.0.1";
