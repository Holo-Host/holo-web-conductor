/**
 * must_get_agent_activity host function
 *
 * Gets agent activity (chain actions) for a given agent. MUST succeed.
 *
 * Input: MustGetAgentActivityInput { author: AgentPubKey, chain_filter: ChainFilter }
 * Output: Vec<RegisterAgentActivity> (array of { action: SignedActionHashed, cached_entry: null })
 *
 * For fishy, this queries local storage for the agent's chain and returns
 * RegisterAgentActivity ops. If the chain is not found or incomplete,
 * throws UnresolvedDependenciesError in validation context.
 */

import { HostFunctionImpl } from "./base";
import { deserializeTypedFromWasm, serializeResult } from "../serialization";
import { getStorageProvider } from "../../storage/storage-provider";
import { UnresolvedDependenciesError } from "../error";
import { toHolochainAction } from "./action-serialization";
import type { StoredAction } from "../../storage/types";
import { validateWasmMustGetAgentActivityInput } from "../wasm-io-types";

/**
 * must_get_agent_activity host function implementation
 *
 * Queries local storage for the agent's chain actions and returns
 * RegisterAgentActivity-formatted results.
 */
export const mustGetAgentActivity: HostFunctionImpl = (
  context,
  inputPtr,
  inputLen
) => {
  const { callContext, instance } = context;
  const storage = getStorageProvider();
  const [dnaHash, agentPubKey] = callContext.cellId;

  // Deserialize input
  const input = deserializeTypedFromWasm(
    instance,
    inputPtr,
    inputLen,
    validateWasmMustGetAgentActivityInput,
    "MustGetAgentActivityInput"
  );

  const authorHash = input.author;
  console.log(
    `[HostFn] must_get_agent_activity: author=${Array.from(
      authorHash.slice(0, 4)
    )
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")}...`
  );

  // Query local storage for the agent's chain actions
  const actions = storage.queryActions(dnaHash, authorHash, {});

  if (!actions || actions.length === 0) {
    if (callContext.isValidationContext) {
      throw new UnresolvedDependenciesError({
        Hashes: [authorHash],
      });
    }
    // In normal context, return empty array
    return serializeResult(instance, []);
  }

  // Convert to RegisterAgentActivity format:
  // Array of { action: SignedActionHashed, cached_entry: null }
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
};
