/**
 * must_get_entry host function
 *
 * Gets an entry from the DHT. This is a network operation that MUST succeed.
 *
 * **STUB IMPLEMENTATION**: This is a Priority 2 function deferred to Step 8.
 * Returns mock data for Step 5.5 testing purposes.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";

/**
 * Must get entry input structure
 */
interface MustGetEntryInput {
  /** Entry hash to retrieve */
  entry_hash: Uint8Array;
}

/**
 * must_get_entry host function implementation
 *
 * **STUB**: Returns null (entry not found) for all requests.
 * Real implementation in Step 8 will perform DHT network operations.
 */
export const mustGetEntry: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { instance } = context;

  console.warn(
    "[HostFn] must_get_entry called (STUB - returns null, implement in Step 8)"
  );

  // Deserialize input
  const input = deserializeFromWasm(
    instance,
    inputPtr,
    0
  ) as MustGetEntryInput;

  console.log(
    `[HostFn] must_get_entry: entry_hash=${Buffer.from(input.entry_hash).toString("hex").slice(0, 16)}...`
  );

  // STUB: Return null (entry not found)
  // Real implementation will perform DHT get operation
  const result = null;

  return serializeResult(instance, result);
};
