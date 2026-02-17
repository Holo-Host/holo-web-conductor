/**
 * Op Serialization for Linker
 *
 * This module handles converting TypeScript ChainOps to the format expected
 * by the Rust linker (holochain_serialized_bytes).
 *
 * CRITICAL: Different ChainOp variants expect different action formats:
 * - Variants taking Action enum (with "type" field): StoreRecord, StoreEntry,
 *   RegisterAgentActivity, RegisterUpdatedContent, RegisterUpdatedRecord
 * - Variants taking raw struct (no "type" field): RegisterDeletedBy,
 *   RegisterDeletedEntryAction, RegisterAddLink, RegisterRemoveLink
 */

import { encode } from "@msgpack/msgpack";
import type { ChainOp } from "./dht-op-types";

/**
 * Convert a TypeScript ChainOp to Rust's serde tuple-variant format.
 *
 * TypeScript format: { type: "StoreRecord", signature, action, entry }
 * Rust format: { StoreRecord: [signature, action, entry] }
 *
 * IMPORTANT: Different ChainOp variants expect different action formats:
 *
 * 1. Takes Action enum (INTERNALLY tagged): StoreRecord, RegisterAgentActivity,
 *    RegisterUpdatedContent, RegisterUpdatedRecord
 *    Format: { "type": "Create", author, timestamp, ... }
 *
 * 2. Takes NewEntryAction enum (EXTERNALLY tagged): StoreEntry
 *    Format: { "Create": { author, timestamp, ... } }
 *
 * 3. Takes raw struct (no type, no wrapper): RegisterDeletedBy, RegisterDeletedEntryAction,
 *    RegisterAddLink, RegisterRemoveLink
 *    Format: { author, timestamp, ... }
 */
export function convertOpToRustFormat(op: ChainOp): Record<string, unknown[]> {
  switch (op.type) {
    // These variants take Action enum (INTERNALLY tagged with "type" field)
    case "StoreRecord":
      return { StoreRecord: [op.signature, op.action, op.entry] };

    // StoreEntry takes NewEntryAction enum (EXTERNALLY tagged)
    // Convert from { type: "Create", author, ... } to { "Create": { author, ... } }
    case "StoreEntry":
      return { StoreEntry: [op.signature, convertToExternallyTagged(op.action), op.entry] };

    case "RegisterAgentActivity":
      return { RegisterAgentActivity: [op.signature, op.action] };

    case "RegisterUpdatedContent":
      return { RegisterUpdatedContent: [op.signature, op.action, op.entry] };

    case "RegisterUpdatedRecord":
      return { RegisterUpdatedRecord: [op.signature, op.action, op.entry] };

    // These variants take raw structs (no "type" field)
    case "RegisterDeletedBy":
      return { RegisterDeletedBy: [op.signature, stripTypeField(op.action)] };

    case "RegisterDeletedEntryAction":
      return { RegisterDeletedEntryAction: [op.signature, stripTypeField(op.action)] };

    case "RegisterAddLink":
      return { RegisterAddLink: [op.signature, stripTypeField(op.action)] };

    case "RegisterRemoveLink":
      return { RegisterRemoveLink: [op.signature, stripTypeField(op.action)] };

    default:
      throw new Error(`Unknown ChainOp type: ${(op as ChainOp).type}`);
  }
}

/**
 * Strip the "type" field from an action for ChainOp variants that expect raw structs.
 * Rust's serde uses internally tagged enums for Action, but some ChainOp variants
 * take the inner struct directly (CreateLink, Delete, DeleteLink) not the Action enum.
 */
export function stripTypeField<T extends { type: string }>(action: T): Omit<T, 'type'> {
  const { type: _type, ...rest } = action;
  return rest as Omit<T, 'type'>;
}

/**
 * Convert an internally-tagged action to externally-tagged format.
 *
 * Rust's Action enum uses internal tagging: { "type": "Create", author, ... }
 * Rust's NewEntryAction enum uses external tagging: { "Create": { author, ... } }
 *
 * This function converts from internal to external format for StoreEntry ops.
 */
export function convertToExternallyTagged<T extends { type: string }>(action: T): Record<string, Omit<T, 'type'>> {
  const { type, ...rest } = action;
  // Wrap the fields in a map keyed by the type name
  return { [type]: rest as Omit<T, 'type'> };
}

/**
 * Serialize a ChainOp to msgpack bytes in DhtOp format for linker transmission.
 *
 * The output format is: { ChainOp: { VariantName: [signature, action, ...] } }
 */
export function serializeOpForLinker(op: ChainOp): Uint8Array {
  const rustChainOp = convertOpToRustFormat(op);
  const dhtOp = { ChainOp: rustChainOp };
  return new Uint8Array(encode(dhtOp));
}
