/**
 * agent_info host function
 *
 * Returns information about the current agent.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";

/**
 * Agent info response structure
 */
export interface AgentInfo {
  /** Agent's initial public key (Ed25519) */
  agent_initial_pubkey: Uint8Array;

  /** Agent's latest public key (same as initial for now) */
  agent_latest_pubkey: Uint8Array;

  /** Chain head information */
  chain_head: {
    /** Action hash of chain head */
    action: Uint8Array;

    /** Sequence number of chain head */
    sequence: number;

    /** Timestamp of chain head (microseconds since UNIX epoch) */
    timestamp: number;
  };
}

/**
 * agent_info host function implementation
 *
 * Returns agent's public key and chain head information.
 * For now, returns mock chain head data (genesis state).
 */
export const agentInfo: HostFunctionImpl = (context, inputPtr) => {
  const { callContext, instance } = context;

  // Get agent pub key from cell ID
  const [_dnaHash, agentPubKey] = callContext.cellId;

  // Mock chain head data (genesis state)
  const chainHead = {
    action: new Uint8Array(32), // All zeros = genesis
    sequence: 0, // Genesis sequence
    timestamp: Date.now() * 1000, // Current time in microseconds
  };

  const agentInfoData: AgentInfo = {
    agent_initial_pubkey: agentPubKey,
    agent_latest_pubkey: agentPubKey, // Same as initial for now
    chain_head: chainHead,
  };

  return serializeResult(instance, agentInfoData);
};
