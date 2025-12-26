/**
 * query host function
 *
 * Queries the source chain for records matching a filter.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";

/**
 * Query filter structure
 */
interface QueryFilter {
  /** Filter type */
  filter_type?: string;

  /** Entry type to filter by */
  entry_type?: string | { App: { id: number; zome_id: number } };

  /** Action type to filter by */
  action_type?: string;

  /** Include entries in results */
  include_entries?: boolean;
}

/**
 * Query input structure
 */
interface QueryInput {
  /** Filter to apply */
  filter: QueryFilter;
}

/**
 * query host function implementation
 *
 * NOTE: This is a MOCK implementation for Step 5.
 * Always returns an empty array.
 * Step 6 will add real chain queries.
 */
export const query: HostFunctionImpl = (context, inputPtr) => {
  const { instance } = context;

  // Deserialize input
  const _input = deserializeFromWasm(instance, inputPtr, 0) as QueryInput;

  // Return empty array (no records found)
  const results: any[] = [];

  console.warn(
    "[query] Returning empty results - Step 6 will add real chain queries"
  );

  return serializeResult(instance, results);
};
