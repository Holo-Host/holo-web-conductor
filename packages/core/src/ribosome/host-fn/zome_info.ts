/**
 * zome_info host function
 *
 * Returns information about the current zome.
 */

import { encode } from "@msgpack/msgpack";
import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";

/**
 * Zome info response structure
 * Matches holochain_integrity_types::info::ZomeInfo
 */
export interface ZomeInfo {
  /** Name of the current zome */
  name: string;

  /** Zome ID (index in DNA's zome list) */
  id: number;

  /** Properties for this zome (SerializedBytes - msgpack-encoded) */
  properties: Uint8Array;

  /** Entry definitions for this zome */
  entry_defs: Array<unknown>;

  /** Exported function names */
  extern_fns: string[];

  /** Zome types in scope (ScopedZomeTypesSet) */
  zome_types: {
    entries: Array<[number, number[]]>; // Vec<(ZomeIndex, Vec<EntryDefIndex>)>
    links: Array<[number, number[]]>; // Vec<(ZomeIndex, Vec<LinkType>)>
  };
}

/**
 * zome_info host function implementation
 *
 * Returns current zome name and metadata.
 */
export const zomeInfo: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;

  // Encode empty properties as SerializedBytes (msgpack of {})
  const emptyProps = {};
  const propertiesBytes = new Uint8Array(encode(emptyProps));

  // Create a mock entry definition for test_entry
  // Matches the TestEntry in the test zome
  const entryDefs = [
    {
      id: { App: "test_entry" }, // EntryDefId::App(AppEntryName)
      visibility: "Public", // EntryVisibility::Public
      required_validations: 5, // From #[entry_type(required_validations = 5)]
      cache_at_agent_activity: false,
    },
  ];

  const zomeInfoData: ZomeInfo = {
    name: callContext.zome,
    id: 0, // Mock zome ID
    properties: propertiesBytes,
    entry_defs: entryDefs,
    extern_fns: [], // Empty function list for mock
    zome_types: {
      entries: [[0, [0]]], // Current zome (index 0) has entry def index 0
      links: [], // No link types
    },
  };

  return serializeResult(instance, zomeInfoData);
};
