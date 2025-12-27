/**
 * sign host function
 *
 * Signs data with the agent's key.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";

/**
 * Sign input structure
 */
interface SignInput {
  /** Data to sign */
  data: Uint8Array;
}

/**
 * sign host function implementation
 *
 * NOTE: This is a MOCK implementation for Step 5.
 * Production implementation should delegate to Lair keystore.
 *
 * For now, this creates a deterministic signature based on the agent pub key
 * and data. This allows signatures to be verified but doesn't use Lair.
 */
export const sign: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;

  // Deserialize input
  const input = deserializeFromWasm(instance, inputPtr, inputLen) as SignInput;
  const data = input instanceof Uint8Array ? input : input.data;

  // Get agent pub key from cell ID
  const [_dnaHash, agentPubKey] = callContext.cellId;

  // TODO(Step 6+): Integrate with Lair for real signing
  // For now, create a mock signature
  // In production, this would be: await lairClient.signByPubKey(agentPubKey, data)

  // Create a deterministic mock signature (64 bytes for Ed25519)
  const signature = new Uint8Array(64);

  // Simple deterministic signature: hash(agentPubKey + data)
  let hash = 0;
  for (let i = 0; i < agentPubKey.length; i++) {
    hash = ((hash << 5) - hash + agentPubKey[i]) | 0;
  }
  for (let i = 0; i < data.length; i++) {
    hash = ((hash << 5) - hash + data[i]) | 0;
  }

  // Spread hash across signature
  const view = new DataView(signature.buffer);
  for (let i = 0; i < 16; i++) {
    view.setUint32(i * 4, hash ^ i, false);
  }

  console.warn(
    "[sign] Using MOCK signature - production should use Lair keystore"
  );

  return serializeResult(instance, signature);
};
