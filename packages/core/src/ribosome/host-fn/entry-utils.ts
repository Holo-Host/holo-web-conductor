/**
 * Entry Utilities
 *
 * Shared utilities for building Entry enum variants in the correct format.
 */

import type { Entry } from "../holochain-types";
import type { AppEntryType } from "../../storage/types";
import { toUint8Array } from "../../utils/bytes";

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

/**
 * Normalize entry bytes from storage/network to proper Uint8Array format.
 *
 * Entries from storage or Cascade may have their `entry` field as a plain
 * object (Chrome message passing) or number array instead of Uint8Array.
 * This ensures the entry data is always a proper Uint8Array for WASM
 * serialization.
 */
export function normalizeEntryBytes(entry: unknown): unknown {
  if (!entry || typeof entry !== "object") return entry;
  const e = entry as Record<string, unknown>;
  const entryType = e.entry_type;
  const entryData = e.entry;
  if (!entryType) return entry;
  const normalizedData =
    Array.isArray(entryData) ||
    (typeof entryData === "object" &&
      entryData !== null &&
      !(entryData instanceof Uint8Array))
      ? toUint8Array(entryData)
      : entryData;
  return { entry_type: entryType, entry: normalizedData };
}
