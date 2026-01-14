/**
 * call_info host function
 *
 * Returns information about the current zome call.
 *
 * Reference: holochain/crates/holochain_zome_types/src/info.rs
 */

import { HostFunctionImpl } from "./base";
import { serializeResult } from "../serialization";
import { getStorageProvider } from "../../storage";
import type { AgentPubKey, ActionHash } from "@holochain/client";

/**
 * CapGrant enum - capability grant for a zome call
 *
 * Reference: holochain/crates/holochain_integrity_types/src/capability/grant.rs
 */
export type CapGrant =
  | { ChainAuthor: AgentPubKey }
  | { RemoteAgent: ZomeCallCapGrant };

/**
 * ZomeCallCapGrant for remote agent capability grants
 */
export interface ZomeCallCapGrant {
  tag: string;
  access: CapAccess;
  functions: GrantedFunctions;
}

export type CapAccess =
  | { Unrestricted: null }
  | { Transferable: { secret: Uint8Array } }
  | { Assigned: { secret: Uint8Array; assignees: AgentPubKey[] } };

export type GrantedFunctions =
  | { All: null }
  | { Listed: Array<[string, string]> }; // [zome_name, fn_name]

/**
 * Call info response structure
 *
 * Reference: holochain/crates/holochain_zome_types/src/info.rs
 */
export interface CallInfo {
  /** Provenance of the call (agent making the call) */
  provenance: AgentPubKey;

  /** Function name that was the entrypoint into the wasm */
  function_name: string;

  /** Chain head as at the call start: (ActionHash, seq, timestamp_microseconds) */
  as_at: [ActionHash, number, number];

  /** Capability grant used to authorize the call */
  cap_grant: CapGrant;
}

/**
 * call_info host function implementation
 *
 * Returns provenance, function name, chain head, and capability grant info.
 */
export const callInfo: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;
  const [dnaHash, agentPubKey] = callContext.cellId;

  // Get chain head from storage
  const storage = getStorageProvider();
  const chainHead = storage.getChainHead(dnaHash, agentPubKey);

  // Build as_at tuple: (ActionHash, seq, Timestamp)
  // Timestamp is microseconds since epoch - convert BigInt to number for msgpack
  // If no chain head, use zeros (shouldn't happen after genesis)
  let timestamp: number;
  if (chainHead?.timestamp !== undefined) {
    // Convert BigInt to number if needed
    timestamp = typeof chainHead.timestamp === 'bigint'
      ? Number(chainHead.timestamp)
      : chainHead.timestamp;
  } else {
    timestamp = Date.now() * 1000; // Current time in microseconds
  }

  const asAt: [ActionHash, number, number] = chainHead
    ? [chainHead.actionHash as ActionHash, chainHead.actionSeq, timestamp]
    : [new Uint8Array(39) as ActionHash, 0, timestamp];

  // For local calls, cap_grant is ChainAuthor with the agent's pubkey
  const capGrant: CapGrant = { ChainAuthor: agentPubKey };

  const callInfoData: CallInfo = {
    provenance: callContext.provenance as AgentPubKey,
    function_name: callContext.fn,
    as_at: asAt,
    cap_grant: capGrant,
  };

  return serializeResult(instance, callInfoData);
};
