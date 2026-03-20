/**
 * must_get_agent_activity host function
 *
 * Gets agent activity (chain actions) for a given agent. MUST succeed.
 *
 * Input: MustGetAgentActivityInput { author: AgentPubKey, chain_filter: ChainFilter }
 * Output: Vec<RegisterAgentActivity> (array of { action: SignedActionHashed, cached_entry: null })
 *
 * Queries the network via linker since HWC is a zero-arc node.
 * Falls back to local storage if network is unavailable.
 * In validation context, throws UnresolvedDependenciesError if data not found.
 */

import { HostFunctionImpl } from "./base";
import { deserializeTypedFromWasm, serializeResult } from "../serialization";
import { getNetworkService } from "../../network";
import { getStorageProvider } from "../../storage/storage-provider";
import { UnresolvedDependenciesError } from "../error";
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

  console.log(
    `[HostFn] must_get_agent_activity: author=${Array.from(
      authorHash.slice(0, 4)
    )
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")}...`
  );

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
    console.log("[HostFn] must_get_agent_activity: author is self, querying local storage");
    const storage = getStorageProvider();
    const allActions = storage.queryActions(dnaHash, authorHash, {});

    // Apply ChainFilter: only return actions up to and including chain_top.
    // Without this, the current action being validated would be included,
    // causing false positives in duplicate-detection validation rules.
    const actions = applyChainFilter(allActions, chainTop);

    return buildLocalResult(instance, callContext, actions, authorHash);
  }

  // Try network first (zero-arc node pattern) for other agents
  const networkService = getNetworkService();
  if (networkService && chainTop) {
    const response = networkService.mustGetAgentActivitySync(
      dnaHash,
      authorHash,
      chainTop,
      false, // include_cached_entries
    );

    if (response) {
      // MustGetAgentActivityResponse is an enum:
      // Activity { ... } | IncompleteChain | ChainTopNotFound | EmptyRange
      if (typeof response === "object" && "Activity" in response) {
        const activity = response.Activity;
        // Activity contains array of RegisterAgentActivity
        return serializeResult(instance, activity);
      }

      // Non-success responses - in validation context, throw
      if (callContext.isValidationContext) {
        const errorType =
          typeof response === "string"
            ? response
            : Object.keys(response)[0];
        console.log(
          `[HostFn] must_get_agent_activity: network returned ${errorType}, throwing`
        );
        throw new UnresolvedDependenciesError({
          Hashes: [authorHash],
        });
      }

      // In normal context, return empty
      return serializeResult(instance, []);
    }
  }

  // Fallback: query local storage (for non-self agents when network unavailable)
  const storage = getStorageProvider();
  const allActions = storage.queryActions(dnaHash, authorHash, {});
  const actions = applyChainFilter(allActions, chainTop);

  return buildLocalResult(instance, callContext, actions, authorHash);
};

/**
 * Build RegisterAgentActivity[] result from local storage actions.
 * Shared by both self short-circuit and network-unavailable fallback paths.
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
