/**
 * query host function
 *
 * Queries the source chain for records matching a filter.
 */

import { HostFunctionImpl } from "./base";
import { deserializeTypedFromWasm, serializeResult } from "../serialization";
import { getStorageProvider } from "../../storage/storage-provider";
import { toHolochainAction } from "./action-serialization";
import { buildEntry } from "./entry-utils";
import type { Record, RecordEntry } from "../holochain-types";
import { validateWasmQueryInput, type WasmQueryInput } from "../wasm-io-types";

/**
 * query host function implementation
 *
 * Queries the source chain and returns matching records.
 */
export const query: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;
  const storage = getStorageProvider();

  // Deserialize and validate input
  const input = deserializeTypedFromWasm(
    instance, inputPtr, inputLen,
    validateWasmQueryInput, 'WasmQueryInput'
  );

  // WasmQueryInput.action_type is string[] but storage expects single string
  const actionTypeFilter = input.action_type?.[0];

  const [dnaHash, agentPubKey] = callContext.cellId;

  // Query actions from storage (always synchronous with StorageProvider)
  const actions = storage.queryActions(dnaHash, agentPubKey, {
    actionType: actionTypeFilter,
  });
  const records = [];
  for (const action of actions) {
    let entry = undefined;

    // Fetch entry if needed and if action has one
    if (input.include_entries !== false && "entryHash" in action && action.entryHash) {
      entry = storage.getEntry(action.entryHash);
    }

    // Build record structure with Holochain-formatted action
    // RecordEntry enum: Present(Entry) | Hidden | NA | NotStored
    let recordEntry: RecordEntry;
    if (entry) {
      // Build Entry enum variant using shared helper (internally tagged format)
      const entryVariant = buildEntry(entry.entryType, entry.entryContent);
      recordEntry = { Present: entryVariant };
    } else {
      // No entry for this action (Dna, AgentValidationPkg, InitZomesComplete, etc.)
      recordEntry = "NA";
    }

    const actionContent = toHolochainAction(action);

    const record = {
      signed_action: {
        hashed: {
          content: actionContent,
          hash: action.actionHash,
        },
        signature: action.signature,
      },
      entry: recordEntry,
    };

    records.push(record);
  }

  return serializeResult(instance, records);
};
