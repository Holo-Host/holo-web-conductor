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
 * Sign serialized action bytes using the agent's key
 *
 * IMPORTANT: Holochain signs the msgpack-serialized Action struct,
 * NOT the ActionHash. Use serializeActionForSigning() from the hash module
 * to get the correct bytes.
 *
 * Uses the Lair client's synchronous signing (key must be preloaded).
 *
 * @param agentPubKey - 39-byte AgentPubKey (with prefix and location)
 * @param serializedAction - Msgpack-serialized Action bytes
 * @returns 64-byte Ed25519 signature
 */
export function signAction(
  agentPubKey: AgentPubKey,
  serializedAction: Uint8Array
): Signature {
  const client = getLairClient();

  // Extract raw 32-byte Ed25519 key from 39-byte AgentPubKey
  const rawPubKey = sliceCore32(agentPubKey);

  // Sign the serialized action bytes (NOT the hash)
  return client.signSync(rawPubKey, serializedAction) as Signature;
}
