/**
 * must_get_agent_activity host function
 *
 * Gets agent activity (chain actions) for a given agent. MUST succeed.
 *
 * Input: MustGetAgentActivityInput { author: AgentPubKey, chain_filter: ChainFilter }
 * Output: Vec<RegisterAgentActivity> (array of { action: SignedActionHashed, cached_entry: null })
 *
 * For self: reads from local source chain storage.
 * For other agents: queries the network via linker (zero-arc node pattern).
 *
 * Error handling matches Holochain's conductor:
 * - Network/cascade failures → WasmError::Host (all contexts)
 * - IncompleteChain/ChainTopNotFound in validation → UnresolvedDependencies (short-circuit)
 * - IncompleteChain/ChainTopNotFound in coordinator → WasmError::Host (hard error)
 * - EmptyRange → WasmError::Host (all contexts)
 */

import { HostFunctionImpl } from "./base";
import { deserializeTypedFromWasm, serializeResult } from "../serialization";
import { getNetworkService } from "../../network";
import { getStorageProvider } from "../../storage/storage-provider";
import { HostFnError, UnresolvedDependenciesError } from "../error";
import { toHolochainAction } from "./action-serialization";
import { bytesEqual } from "./bytes-equal";
import type { StoredAction } from "../../storage/types";
import { validateWasmMustGetAgentActivityInput } from "../wasm-io-types";
import type { ActionHash } from "../../types/holochain-types";

export const mustGetAgentActivity: HostFunctionImpl = (
  context,
  inputPtr,
  inputLen
) => {
  const { callContext, instance } = context;
  const [dnaHash, selfAgent] = callContext.cellId;

  // Deserialize input
  const input = deserializeTypedFromWasm(
    instance,
    inputPtr,
    inputLen,
    validateWasmMustGetAgentActivityInput,
    "MustGetAgentActivityInput"
  );

  const authorHash = input.author;
  const chainFilter = input.chain_filter;

  // Extract chain_top from the chain_filter
  let chainTop: ActionHash | null = null;
  if (chainFilter && typeof chainFilter === "object") {
    const cf = chainFilter as Record<string, unknown>;
    if (cf.chain_top instanceof Uint8Array) {
      chainTop = cf.chain_top as ActionHash;
    }
  }

  // Self short-circuit: own chain activity is in local storage
  if (bytesEqual(authorHash, selfAgent)) {
    const storage = getStorageProvider();
    const allActions = storage.queryActions(dnaHash, authorHash, {});

    // Apply ChainFilter: only return actions up to and including chain_top.
    // Without this, the current action being validated would be included,
    // causing false positives in duplicate-detection validation rules.
    const actions = applyChainFilter(allActions, chainTop);

    return buildLocalResult(instance, callContext, actions, authorHash);
  }

  // chain_top is a required field on ChainFilter per the Rust type.
  // If missing, the WASM guest sent malformed input.
  if (!chainTop) {
    throw new HostFnError("must_get_agent_activity: chain_filter missing required chain_top field");
  }

  // Try network (zero-arc node pattern) for other agents
  const networkService = getNetworkService();
  if (!networkService) {
    throw new HostFnError("Network service not available for must_get_agent_activity");
  }

  const response = networkService.mustGetAgentActivitySync(
    dnaHash,
    authorHash,
    chainTop,
    false, // include_cached_entries
  );

  if (!response) {
    throw new HostFnError("Network request for must_get_agent_activity failed");
  }

  // MustGetAgentActivityResponse is an enum:
  // Activity { ... } | IncompleteChain | ChainTopNotFound | EmptyRange
  if (typeof response === "object" && "Activity" in response) {
    const activity = response.Activity;
    return serializeResult(instance, activity);
  }

  // Non-success responses: match Holochain's error handling per context
  const errorType =
    typeof response === "string"
      ? response
      : Object.keys(response)[0];

  // In validation context, IncompleteChain/ChainTopNotFound → UnresolvedDependencies
  if (callContext.isValidationContext && (errorType === "IncompleteChain" || errorType === "ChainTopNotFound")) {
    throw new UnresolvedDependenciesError({
      Hashes: [authorHash],
    });
  }

  // In coordinator context (or EmptyRange in any context) → WasmError::Host
  if (errorType === "IncompleteChain") {
    throw new HostFnError(
      `must_get_agent_activity chain is incomplete for author`
    );
  } else if (errorType === "ChainTopNotFound") {
    throw new HostFnError(
      `must_get_agent_activity is missing action for author`
    );
  } else {
    throw new HostFnError(
      `must_get_agent_activity chain has produced an invalid range`
    );
  }
};

/**
 * Build RegisterAgentActivity[] result from local storage actions.
 * Used only for the self-agent path (own chain data).
 *
 * Rust serde contract (holochain_integrity_types::op::RegisterAgentActivity):
 *   { action: SignedActionHashed, cached_entry: Option<Entry> }
 *   SignedActionHashed = { hashed: { content: Action, hash: ActionHash }, signature: Bytes }
 */
function buildLocalResult(
  instance: WebAssembly.Instance,
  callContext: { isValidationContext?: boolean },
  actions: StoredAction[],
  authorHash: Uint8Array,
): bigint {
  if (!actions || actions.length === 0) {
    if (callContext.isValidationContext) {
      throw new UnresolvedDependenciesError({
        Hashes: [authorHash],
      });
    }
    return serializeResult(instance, []);
  }

  const results = actions.map((storedAction: StoredAction) => {
    const wireAction = toHolochainAction(storedAction);
    return {
      action: {
        hashed: {
          content: wireAction,
          hash: storedAction.actionHash,
        },
        signature: storedAction.signature || new Uint8Array(64),
      },
      cached_entry: null,
    };
  });

  return serializeResult(instance, results);
}

/**
 * Apply ChainFilter to a list of actions.
 *
 * Holochain's ChainFilter specifies a chain_top hash. The filter means:
 * "return all actions from the beginning of the chain up to and including
 * the action with this hash." Actions after chain_top are excluded.
 *
 * The actions are assumed to be sorted by actionSeq ascending.
 */
function applyChainFilter(
  actions: StoredAction[],
  chainTop: ActionHash | null
): StoredAction[] {
  if (!chainTop || actions.length === 0) {
    return actions;
  }

  // Find the chain_top action by hash
  const chainTopIdx = actions.findIndex((a) =>
    bytesEqual(a.actionHash, chainTop)
  );

  if (chainTopIdx === -1) {
    // chain_top not found - return all actions as fallback
    // (this matches Holochain behavior where missing chain_top
    // is handled by the caller)
    return actions;
  }

  // Return actions from genesis up to and including chain_top
  return actions.slice(0, chainTopIdx + 1);
}
