/**
 * get_agent_activity host function
 *
 * Returns agent activity (chain status and action hashes) for an agent.
 * If the agent is self, reads from local source chain storage.
 * Otherwise queries the network via linker since HWC is a zero-arc node.
 *
 * Input: GetAgentActivityInput { agent_pubkey, chain_query_filter, activity_request, get_options }
 * Output: AgentActivity { valid_activity, rejected_activity, status, highest_observed, warrants }
 *
 * For HWC (zero-arc), queries the network via linker for other agents' data.
 */

import { HostFunctionImpl } from "./base";
import { deserializeTypedFromWasm, serializeResult } from "../serialization";
import { getNetworkService } from "../../network";
import { getStorageProvider } from "../../storage/storage-provider";
import { validateWasmGetAgentActivityInput } from "../wasm-io-types";
import { bytesEqual } from "./bytes-equal";
import type { ChainItems } from "../../network/types";
import type { ActionHash } from "../../types/holochain-types";

export const getAgentActivity: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;
  const [dnaHash, selfAgent] = callContext.cellId;

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

  // Self short-circuit: own chain activity is in local storage
  if (bytesEqual(agentPubKey, selfAgent)) {
    console.log("[HostFn] get_agent_activity: agent is self, querying local storage");
    return getAgentActivityFromLocal(instance, dnaHash, selfAgent);
  }

  // Query network via linker for other agents (zero-arc node pattern)
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
 * Build AgentActivity response from local source chain storage.
 */
function getAgentActivityFromLocal(
  instance: WebAssembly.Instance,
  dnaHash: Uint8Array,
  agentPubKey: Uint8Array,
): bigint {
  const storage = getStorageProvider();
  const actions = storage.queryActions(dnaHash, agentPubKey, {});

  if (!actions || actions.length === 0) {
    return serializeResult(instance, {
      valid_activity: [],
      rejected_activity: [],
      status: "Empty",
      highest_observed: null,
      warrants: [],
    });
  }

  // Build valid_activity as [seq, actionHash] pairs, sorted by seq
  const validActivity: Array<[number, ActionHash]> = actions
    .map((a) => [a.actionSeq, a.actionHash] as [number, ActionHash])
    .sort((a, b) => a[0] - b[0]);

  const highest = validActivity[validActivity.length - 1];

  // ChainStatus::Valid wraps ChainHead { action_seq, hash }
  const status = highest
    ? { Valid: { action_seq: highest[0], hash: highest[1] } }
    : "Empty";

  // HighestObserved { action_seq, hash: Vec<ActionHash> } — hash is an array
  const highestObserved = highest
    ? { action_seq: highest[0], hash: [highest[1]] }
    : null;

  return serializeResult(instance, {
    valid_activity: validActivity,
    rejected_activity: [],
    status,
    highest_observed: highestObserved,
    warrants: [],
  });
}

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
