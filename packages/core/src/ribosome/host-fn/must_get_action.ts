/**
 * must_get_action host function
 *
 * Gets an action from the DHT. This is a network operation that MUST succeed.
 *
 * **STUB IMPLEMENTATION**: This is a Priority 2 function deferred to Step 8.
 * Returns mock data for Step 5.5 testing purposes.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";

/**
 * Must get action input structure
 */
interface MustGetActionInput {
  /** Action hash to retrieve */
  action_hash: Uint8Array;
}

/**
 * must_get_action host function implementation
 *
 * **STUB**: Returns null (action not found) for all requests.
 * Real implementation in Step 8 will perform DHT network operations.
 */
export const mustGetAction: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { instance } = context;

  console.warn(
    "[HostFn] must_get_action called (STUB - returns null, implement in Step 8)"
  );

  // Deserialize input
  const input = deserializeFromWasm(
    instance,
    inputPtr,
    0
  ) as MustGetActionInput;

  console.log(
    `[HostFn] must_get_action: action_hash=${Buffer.from(input.action_hash).toString("hex").slice(0, 16)}...`
  );

  // STUB: Return null (action not found)
  // Real implementation will perform DHT get operation
  const result = null;

  return serializeResult(instance, result);
};
