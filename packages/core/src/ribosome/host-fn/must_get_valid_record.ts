/**
 * must_get_valid_record host function
 *
 * Gets a validated record from the DHT. This is a network operation that MUST succeed.
 * Uses Cascade pattern: local storage → network cache → network.
 *
 * Input: MustGetValidRecordInput (newtype wrapper around ActionHash - transparent in serde)
 * Output: Record = { signed_action: SignedActionHashed, entry: RecordEntry }
 *
 * For fishy (zero-arc), locally-authored data is treated as valid.
 * Data from network is trusted (the linker's peers validated it).
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
import { normalizeEntryBytes } from "./entry-utils";
import { validateWasmHashInput } from "../wasm-io-types";

/**
 * must_get_valid_record host function implementation
 *
 * Retrieves a full record by ActionHash using Cascade (local → cache → network).
 * Returns Record = { signed_action: SignedActionHashed, entry: RecordEntry }.
 */
export const mustGetValidRecord: HostFunctionImpl = (
  context,
  inputPtr,
  inputLen
) => {
  const { callContext, instance } = context;
  const storage = getStorageProvider();
  const [dnaHash] = callContext.cellId;

  // Deserialize input - MustGetValidRecordInput is a serde-transparent newtype
  const actionHash = deserializeTypedFromWasm(
    instance,
    inputPtr,
    inputLen,
    validateWasmHashInput,
    "MustGetValidRecordInput (ActionHash)"
  );

  console.log(
    `[HostFn] must_get_valid_record: hash=${Array.from(actionHash.slice(0, 4))
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
    throw new Error("must_get_valid_record: Record not found");
  }

  // Convert action to Holochain wire format if from local storage
  const action = record.signed_action.hashed.content;
  const localActionType = (action as unknown as StoredAction).actionType;
  const wireAction =
    typeof localActionType === "string"
      ? toHolochainAction(action as unknown as StoredAction)
      : action;

  // Normalize entry bytes (linker returns arrays instead of Uint8Array)
  // Rust RecordEntry::NA is a unit variant → serializes as string "NA" in msgpack
  let entry: unknown = "NA";
  const recordEntry = record.entry;
  if (
    recordEntry &&
    typeof recordEntry === "object" &&
    "Present" in recordEntry
  ) {
    const presentEntry = (recordEntry as { Present: unknown }).Present;
    if (presentEntry) {
      entry = { Present: normalizeEntryBytes(presentEntry) };
    }
  }

  // Return Record = { signed_action, entry }
  const result = {
    signed_action: {
      hashed: {
        content: wireAction,
        hash: record.signed_action.hashed.hash,
      },
      signature: record.signed_action.signature,
    },
    entry,
  };

  return serializeResult(instance, result);
};
