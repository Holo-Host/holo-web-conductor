/**
 * get_agent_activity host function
 *
 * Returns agent activity (chain actions matching a filter).
 * For zero-arc nodes, we return an empty AgentActivity with status "Empty"
 * since we don't have direct access to another agent's chain.
 *
 * Reference: holochain/crates/holochain_zome_types/src/query.rs
 *
 * AgentActivity {
 *   valid_activity: Vec<(u32, ActionHash)>,
 *   rejected_activity: Vec<(u32, ActionHash)>,
 *   status: ChainStatus,       // "Empty" | { "Valid": ChainHead } | ...
 *   highest_observed: Option<HighestObserved>,
 *   warrants: Vec<SignedWarrant>,
 * }
 */

import { HostFunctionImpl } from "./base";
import { serializeResult } from "../serialization";

export const getAgentActivity: HostFunctionImpl = (context, inputPtr, inputLen) => {
  // Zero-arc node: we don't have other agents' chain data locally.
  // Return empty AgentActivity with "Empty" status.
  return serializeResult(context.instance, {
    valid_activity: [],
    rejected_activity: [],
    status: "Empty",
    highest_observed: null,
    warrants: [],
  });
};
