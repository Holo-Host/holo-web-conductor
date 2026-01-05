/**
 * sign host function
 *
 * Signs arbitrary data with the agent's key.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";
import { getLairClient } from "../../signing";
import { sliceCore32 } from "@holochain/client";

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
 * Signs arbitrary data with the agent's private key using the signing provider.
 * Falls back to mock signature if no signing provider is set.
 */
export const sign: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;

  // Deserialize input
  const input = deserializeFromWasm(instance, inputPtr, inputLen) as SignInput;
  const data = input instanceof Uint8Array ? input : input.data;

  // Get agent pub key from cell ID
  const [_dnaHash, agentPubKey] = callContext.cellId;

  // Extract raw 32-byte Ed25519 key from 39-byte AgentPubKey using @holochain/client utility
  const rawPubKey = sliceCore32(agentPubKey);

  // Sign using Lair's synchronous signing (key must be preloaded)
  const signature = getLairClient().signSync(rawPubKey, data);

  return serializeResult(instance, signature);
};
