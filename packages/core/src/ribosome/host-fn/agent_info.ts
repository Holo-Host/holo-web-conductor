/**
 * agent_info host function
 *
 * Returns information about the current agent.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";
import { getStorageProvider } from "../../storage/storage-provider";
import { hashFrom32AndType, HoloHashType, dhtLocationFrom32 } from "@holochain/client";

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

  // Get agent pub key from cell ID (may be 32 or 39 bytes)
  const [dnaHash, cellAgentPubKey] = callContext.cellId;

  // Construct proper AgentPubKey (39 bytes) using @holochain/client utility
  // If already 39 bytes with prefix, use as-is; otherwise wrap the 32-byte key
  const agentPubKey = cellAgentPubKey.length === 39
    ? cellAgentPubKey
    : hashFrom32AndType(cellAgentPubKey.slice(0, 32), HoloHashType.Agent);

  // Get real chain head from storage (always synchronous)
  const storedChainHead = storage.getChainHead(dnaHash, cellAgentPubKey);

  let actionHash: Uint8Array;
  let actionSeq: number;
  let timestamp: number;

  if (storedChainHead) {
    // Return real chain head
    actionHash = storedChainHead.actionHash;
    actionSeq = storedChainHead.actionSeq;
    timestamp = Number(storedChainHead.timestamp);
  } else {
    // No chain head yet (genesis state) - create zero-filled action hash
    actionHash = hashFrom32AndType(new Uint8Array(32), HoloHashType.Action);
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

  // Validate DHT location before returning
  const core32 = agentPubKey.slice(3, 35);
  const actualDhtLoc = agentPubKey.slice(35, 39);
  const expectedDhtLoc = dhtLocationFrom32(core32);
  const dhtLocValid = actualDhtLoc.every((b: number, i: number) => b === expectedDhtLoc[i]);

  console.log("[agent_info] Returning agent info", {
    chainSeq: actionSeq,
    hasChainHead: !!storedChainHead,
    agentPubKeyLength: agentPubKey.length,
    agentPubKeyPrefix: Array.from(agentPubKey.slice(0, 3)),
    actualDhtLoc: Array.from(actualDhtLoc),
    expectedDhtLoc: Array.from(expectedDhtLoc),
    dhtLocValid,
  });

  // AgentInfo is a struct: { agent_initial_pubkey, chain_head }
  const agentInfoObject = {
    agent_initial_pubkey: agentPubKey,
    chain_head: chainHead,
  };

  return serializeResult(instance, agentInfoObject);
};
