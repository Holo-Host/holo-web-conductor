/**
 * must_get_entry host function
 *
 * Gets an entry from the DHT. This is a network operation that MUST succeed.
 * Uses Cascade pattern: local storage → network cache → network.
 *
 * Input: MustGetEntryInput (newtype wrapper around EntryHash - transparent in serde)
 * Output: EntryHashed = { content: Entry, hash: EntryHash }
 *
 * In validation context, throws UnresolvedDependenciesError if not found.
 * In normal context, throws a host function error.
 */

import { HostFunctionImpl } from "./base";
import { deserializeTypedFromWasm, serializeResult } from "../serialization";
import { getStorageProvider } from "../../storage/storage-provider";
import { Cascade, getNetworkCache, getNetworkService } from "../../network";
import { UnresolvedDependenciesError } from "../error";
import { normalizeEntryBytes } from "./entry-utils";
import { validateWasmHashInput } from "../wasm-io-types";

/**
 * must_get_entry host function implementation
 *
 * Retrieves an entry by EntryHash using Cascade (local → cache → network).
 * Returns EntryHashed = { content: Entry, hash: EntryHash }.
 */
export const mustGetEntry: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;
  const storage = getStorageProvider();
  const [dnaHash] = callContext.cellId;

  // Deserialize input - MustGetEntryInput is a serde-transparent newtype
  const entryHash = deserializeTypedFromWasm(
    instance,
    inputPtr,
    inputLen,
    validateWasmHashInput,
    "MustGetEntryInput (EntryHash)"
  );

  // Cascade lookup: local → cache → network
  const cascade = new Cascade(
    storage,
    getNetworkCache(),
    getNetworkService()
  );
  const record = cascade.fetchRecord(dnaHash, entryHash);

  if (!record) {
    if (callContext.isValidationContext) {
      throw new UnresolvedDependenciesError({ Hashes: [entryHash] });
    }
    throw new Error("must_get_entry: Entry not found");
  }

  // Extract entry from record
  const recordEntry = record.entry;
  if (
    !recordEntry ||
    typeof recordEntry === "string" ||
    !("Present" in recordEntry) ||
    !recordEntry.Present
  ) {
    if (callContext.isValidationContext) {
      throw new UnresolvedDependenciesError({ Hashes: [entryHash] });
    }
    throw new Error("must_get_entry: Record has no entry");
  }

  const entry = normalizeEntryBytes(recordEntry.Present);

  // Return EntryHashed = { content: Entry, hash: EntryHash }
  const entryHashed = { content: entry, hash: entryHash };
  return serializeResult(instance, entryHashed);
};
