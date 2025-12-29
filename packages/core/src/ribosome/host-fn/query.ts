/**
 * query host function
 *
 * Queries the source chain for records matching a filter.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";
import { SourceChainStorage } from "../../storage/source-chain-storage";
import { toHolochainAction } from "./action-serialization";
import { buildEntry } from "./entry-utils";
import type { Record, RecordEntry } from "../holochain-types";

/**
 * Query input structure (matches Holochain's ChainQueryFilter)
 */
interface QueryInput {
  /** Sequence range to query */
  sequence_range?: {
    Unbounded?: null;
    ActionSeqRange?: [number, number];
  };

  /** Entry type filter */
  entry_type?: {
    App?: {
      zome_index: number;
      entry_index: number;
    };
  };

  /** Action type filter */
  action_type?: string;

  /** Include entries in results */
  include_entries?: boolean;
}

/**
 * query host function implementation
 *
 * Queries the source chain and returns matching records.
 */
export const query: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;
  const storage = SourceChainStorage.getInstance();

  // Deserialize input
  const input = deserializeFromWasm(instance, inputPtr, inputLen) as QueryInput;

  console.log("[query] Querying source chain", {
    sequenceRange: input.sequence_range,
    actionType: input.action_type,
    includeEntries: input.include_entries,
  });

  const [dnaHash, agentPubKey] = callContext.cellId;

  // Query actions from session cache (synchronous)
  const actions = storage.queryActionsFromCache(dnaHash, agentPubKey, {
    actionType: input.action_type,
  });

  // Check if actions are in cache
  if (actions === null) {
    console.warn("[query] Actions not in session cache - returning empty array (Step 7+ will support async queries)");
    return serializeResult(instance, []);
  }
  const records = [];
  for (const action of actions) {
    let entry = undefined;

    // Fetch entry if needed and if action has one
    if (input.include_entries !== false && "entryHash" in action && action.entryHash) {
      console.log("[query] Looking up entry for action:", {
        actionType: action.actionType,
        entryHash: Array.from(action.entryHash.slice(0, 8)),
      });

      const entryResult = storage.getEntry(action.entryHash);

      console.log("[query] Entry result:", {
        isPromise: entryResult instanceof Promise,
        isNull: entryResult === null,
        hasValue: !!entryResult && !(entryResult instanceof Promise),
      });

      if (entryResult instanceof Promise) {
        // Entry not in cache, skip it for now
        console.warn("[query] Entry not in session cache, skipping");
        continue;
      }

      entry = entryResult;
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

    console.log(`[query] Record ${records.length}:`, {
      actionType: actionContent.type,
      entryType: typeof recordEntry === 'string' ? recordEntry : 'Present',
    });

    records.push(record);
  }

  console.log("[query] Found records:", records.length);

  return serializeResult(instance, records);
};
