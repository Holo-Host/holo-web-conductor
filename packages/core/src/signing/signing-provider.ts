/**
 * Lair Client Provider
 *
 * Provides access to the Lair client for signing operations.
 * The client must be configured by the extension before WASM execution.
 */

import {
  type AgentPubKey,
  type ActionHash,
  type Signature,
  sliceCore32,
} from "@holochain/client";
import type { LairClient, Ed25519Signature } from "@fishy/lair";

/**
 * Global Lair client instance
 */
let lairClient: LairClient | null = null;

/**
 * Set the Lair client to use for signing
 */
export function setLairClient(client: LairClient): void {
  lairClient = client;
}

/**
 * Get the current Lair client
 * @throws Error if no client has been set
 */
export function getLairClient(): LairClient {
  if (!lairClient) {
    throw new Error(
      "[LairClient] No Lair client set. Call setLairClient() first."
    );
  }
  return lairClient;
}

/**
 * Check if a Lair client has been set
 */
export function hasLairClient(): boolean {
  return lairClient !== null;
}

/**
 * Clear the Lair client (for testing)
 */
export function clearLairClient(): void {
  lairClient = null;
}

/**
 * Sign an action hash using the agent's key
 *
 * Uses the Lair client's synchronous signing (key must be preloaded).
 *
 * @param agentPubKey - 39-byte AgentPubKey (with prefix and location)
 * @param actionHash - 39-byte ActionHash to sign
 * @returns 64-byte Ed25519 signature
 */
export function signAction(
  agentPubKey: AgentPubKey,
  actionHash: ActionHash
): Signature {
  const client = getLairClient();

  // Extract raw 32-byte Ed25519 key from 39-byte AgentPubKey
  const rawPubKey = sliceCore32(agentPubKey);

  // Sign using Lair's synchronous signing (key must be preloaded)
  return client.signSync(rawPubKey, actionHash) as Signature;
}
