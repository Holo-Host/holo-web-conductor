/**
 * get_agent_activity host function
 *
 * Returns agent activity (chain status and action hashes) for an agent.
 * Queries the network via gateway since fishy is a zero-arc node.
 *
 * Input: GetAgentActivityInput { agent_pubkey, chain_query_filter, activity_request, get_options }
 * Output: AgentActivity { valid_activity, rejected_activity, status, highest_observed, warrants }
 */

import { HostFunctionImpl } from "./base";
import { deserializeTypedFromWasm, serializeResult } from "../serialization";
import { getNetworkService } from "../../network";
import { validateWasmGetAgentActivityInput } from "../wasm-io-types";
import type { ChainItems } from "../../network/types";
import type { ActionHash } from "../../types/holochain-types";

export const getAgentActivity: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;
  const [dnaHash] = callContext.cellId;

  // Deserialize input
  const input = deserializeTypedFromWasm(
    instance,
    inputPtr,
    inputLen,
    validateWasmGetAgentActivityInput,
    "GetAgentActivityInput"
  );

  const agentPubKey = input.agent_pubkey;
  const activityRequest: 'status' | 'full' =
    input.activity_request === 'Status' ? 'status' : 'full';

  console.log(
    `[HostFn] get_agent_activity: agent=${Array.from(agentPubKey.slice(0, 4))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")}..., request=${activityRequest}`
  );

  // Query network via gateway
  const networkService = getNetworkService();
  if (!networkService) {
    console.log("[HostFn] get_agent_activity: no network service, returning empty");
    return serializeResult(instance, {
      valid_activity: [],
      rejected_activity: [],
      status: "Empty",
      highest_observed: null,
      warrants: [],
    });
  }

  const response = networkService.getAgentActivitySync(
    dnaHash,
    agentPubKey,
    activityRequest,
  );

  if (!response) {
    console.log("[HostFn] get_agent_activity: network returned null, returning empty");
    return serializeResult(instance, {
      valid_activity: [],
      rejected_activity: [],
      status: "Empty",
      highest_observed: null,
      warrants: [],
    });
  }

  // Convert AgentActivityResponse (wire format with ChainItems) to
  // AgentActivity (zome format with Vec<(u32, ActionHash)>)
  const validActivity = chainItemsToHashes(response.valid_activity);
  const rejectedActivity = chainItemsToHashes(response.rejected_activity);

  return serializeResult(instance, {
    valid_activity: validActivity,
    rejected_activity: rejectedActivity,
    status: response.status,
    highest_observed: response.highest_observed,
    warrants: response.warrants || [],
  });
};

/**
 * Convert ChainItems (wire format) to array of [seq, hash] pairs (zome format).
 */
function chainItemsToHashes(items: ChainItems): Array<[number, ActionHash]> {
  if (items === 'NotRequested') return [];
  if (typeof items === 'object' && 'Hashes' in items) return items.Hashes;
  if (typeof items === 'object' && 'Full' in items) {
    // Full records - extract seq and hash from each record's signed action
    return items.Full.map((record: any) => {
      const action = record?.signed_action?.hashed?.content;
      const hash = record?.signed_action?.hashed?.hash;
      const seq = action?.action_seq ?? 0;
      return [seq, hash] as [number, ActionHash];
    }).filter((pair: [number, ActionHash]) => pair[1] != null);
  }
  return [];
}
