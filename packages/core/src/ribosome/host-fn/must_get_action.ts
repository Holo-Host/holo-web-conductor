/**
 * must_get_action host function
 *
 * Gets an action from the DHT. This is a network operation that MUST succeed.
 * Uses Cascade pattern: local storage → network cache → network.
 *
 * Input: MustGetActionInput (newtype wrapper around ActionHash - transparent in serde)
 * Output: SignedActionHashed = { hashed: { content: Action, hash: ActionHash }, signature: Signature }
 *
 * In validation context, throws UnresolvedDependenciesError if not found.
 * In normal context, throws a host function error.
 */

import { HostFunctionImpl } from "./base";
import { deserializeTypedFromWasm, serializeResult } from "../serialization";
import { getStorageProvider } from "../../storage/storage-provider";
import { Cascade, getNetworkCache, getNetworkService } from "../../network";
import { UnresolvedDependenciesError } from "../error";
import { toHolochainAction } from "./action-serialization";
import type { StoredAction } from "../../storage/types";
import { validateWasmHashInput } from "../wasm-io-types";

/**
 * must_get_action host function implementation
 *
 * Retrieves a signed action by ActionHash using Cascade (local → cache → network).
 * Returns SignedActionHashed.
 */
export const mustGetAction: HostFunctionImpl = (
  context,
  inputPtr,
  inputLen
) => {
  const { callContext, instance } = context;
  const storage = getStorageProvider();
  const [dnaHash] = callContext.cellId;

  // Deserialize input - MustGetActionInput is a serde-transparent newtype
  const actionHash = deserializeTypedFromWasm(
    instance,
    inputPtr,
    inputLen,
    validateWasmHashInput,
    "MustGetActionInput (ActionHash)"
  );

  console.log(
    `[HostFn] must_get_action: hash=${Array.from(actionHash.slice(0, 4))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")}...`
  );

  // Cascade lookup: local → cache → network
  const cascade = new Cascade(
    storage,
    getNetworkCache(),
    getNetworkService()
  );
  const record = cascade.fetchRecord(dnaHash, actionHash);

  if (!record) {
    if (callContext.isValidationContext) {
      throw new UnresolvedDependenciesError({ Hashes: [actionHash] });
    }
    throw new Error("must_get_action: Action not found");
  }

  // Convert action to Holochain wire format if from local storage
  const action = record.signed_action.hashed.content;
  const localActionType = (action as unknown as StoredAction).actionType;
  const wireAction =
    typeof localActionType === "string"
      ? toHolochainAction(action as unknown as StoredAction)
      : action;

  // Return SignedActionHashed = { hashed: { content, hash }, signature }
  const signedActionHashed = {
    hashed: {
      content: wireAction,
      hash: record.signed_action.hashed.hash,
    },
    signature: record.signed_action.signature,
  };

  return serializeResult(instance, signedActionHashed);
};
