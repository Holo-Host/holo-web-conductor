/**
 * agent_info host function
 *
 * Returns information about the current agent.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";
import { getStorageProvider } from "../../storage/storage-provider";

/**
 * Agent info response structure
 *
 * Matches holochain_zome_types::info::AgentInfo
 */
export interface AgentInfo {
  /** Agent's initial public key (Ed25519) */
  agent_initial_pubkey: Uint8Array;

  /**
   * Chain head information as tuple: (ActionHash, u32, Timestamp)
   * [0]: Action hash (39 bytes - HoloHash format)
   * [1]: Sequence number (u32)
   * [2]: Timestamp - newtype serializes as bare i64
   */
  chain_head: [Uint8Array, number, number];
}

/**
 * agent_info host function implementation
 *
 * Returns agent's public key and real chain head information.
 */
export const agentInfo: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;
  const storage = getStorageProvider();

  // Get raw agent pub key from cell ID (32 bytes)
  const [dnaHash, rawAgentPubKey] = callContext.cellId;

  // Construct AgentPubKey (39 bytes): [prefix(3)][hash(32)][location(4)]
  const agentPubKey = new Uint8Array(39);
  agentPubKey.set([132, 32, 36], 0); // AGENT_PREFIX
  agentPubKey.set(rawAgentPubKey, 3); // 32-byte public key
  agentPubKey.set([0, 0, 0, 0], 35); // location (all zeros)

  // Get real chain head from storage (always synchronous)
  const storedChainHead = storage.getChainHead(dnaHash, rawAgentPubKey);

  let actionHash: Uint8Array;
  let actionSeq: number;
  let timestamp: number;

  if (storedChainHead) {
    // Return real chain head
    actionHash = storedChainHead.actionHash;
    actionSeq = storedChainHead.actionSeq;
    timestamp = Number(storedChainHead.timestamp);
  } else {
    // No chain head yet (genesis state)
    actionHash = new Uint8Array(39);
    actionHash.set([132, 41, 36], 0); // ACTION_PREFIX
    actionHash.set([0, 0, 0, 0], 35); // location (all zeros)
    actionSeq = 0;
    timestamp = Date.now() * 1000;
  }

  // Chain head data as tuple: (ActionHash, u32, Timestamp)
  // Note: Timestamp(i64) is a newtype that serializes as just the i64, not wrapped
  const chainHead: [Uint8Array, number, number] = [
    actionHash, // ActionHash: 39-byte format
    actionSeq, // u32: current sequence
    timestamp, // Timestamp(i64): serializes as bare i64
  ];

  console.log("[agent_info] Returning agent info", {
    chainSeq: actionSeq,
    hasChainHead: !!storedChainHead,
  });

  // AgentInfo is a struct: { agent_initial_pubkey, chain_head }
  const agentInfoObject = {
    agent_initial_pubkey: agentPubKey,
    chain_head: chainHead,
  };

  return serializeResult(instance, agentInfoObject);
};
