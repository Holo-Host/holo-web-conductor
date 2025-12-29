/**
 * Entry Utilities
 *
 * Shared utilities for building Entry enum variants in the correct format.
 */

import type { Entry } from "../holochain-types";
import type { AppEntryType } from "../../storage/types";

/**
 * Build Entry enum variant based on entry type
 *
 * Entry uses serde's internally tagged enum format (#[serde(tag = "entry_type", content = "entry")])
 * which serializes as: { "entry_type": "App", "entry": <content> }
 *
 * Source: holochain/crates/holochain_integrity_types/src/entry.rs
 */
export function buildEntry(
  entryType: AppEntryType | "Agent" | "CapClaim" | "CapGrant",
  entryContent: Uint8Array
): Entry {
  if (entryType === "Agent") {
    return { entry_type: "Agent", entry: entryContent };
  } else if (entryType === "CapClaim") {
    return { entry_type: "CapClaim", entry: entryContent };
  } else if (entryType === "CapGrant") {
    return { entry_type: "CapGrant", entry: entryContent };
  } else {
    // App entry - just use the raw bytes (AppEntryBytes is a newtype wrapper)
    return { entry_type: "App", entry: entryContent };
  }
}
