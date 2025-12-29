/**
 * zome_info host function
 *
 * Returns information about the current zome.
 */

import { encode } from "@msgpack/msgpack";
import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";
import type { EntryDef } from "../../types/holochain-types";

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
  entry_defs: EntryDef[];

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

  // Get manifest from call context
  const manifest = callContext.dnaManifest;

  // Find current zome in manifest
  const allZomes = [
    ...(manifest?.integrity_zomes || []),
    ...(manifest?.coordinator_zomes || []),
  ];

  const currentZome = allZomes.find((z) => z.name === callContext.zome);
  const zomeIndex = currentZome?.index ?? 0;

  // Encode properties
  const propertiesBytes = new Uint8Array(encode(manifest?.properties || {}));

  // Build entry_defs from cached WASM entry_defs callback result
  const entryDefs: unknown[] = currentZome?.entryDefs || [];

  console.log('[zome_info] entry_defs:', {
    hasCurrentZome: !!currentZome,
    hasEntryDefs: !!currentZome?.entryDefs,
    entryDefsLength: entryDefs.length,
  });

  // Build zome_types
  const zomeTypes = {
    entries: [] as Array<[number, number[]]>,
    links: [] as Array<[number, number[]]>,
  };

  // If we have manifest, include current zome in zome_types
  if (currentZome) {
    // For now, assume zome has entry def index 0 (proper extraction in Step 6)
    zomeTypes.entries.push([zomeIndex, [0]]);

    // For links, assume zome has link type 0 (proper extraction in Step 6)
    zomeTypes.links.push([zomeIndex, [0]]);
  }

  const zomeInfoData: ZomeInfo = {
    name: callContext.zome,
    id: zomeIndex,
    properties: propertiesBytes,
    entry_defs: entryDefs,
    extern_fns: [], // TODO: Extract from manifest in Step 6
    zome_types: zomeTypes,
  };

  console.log(`[zome_info] Returning info for zome: ${callContext.zome}`, {
    index: zomeIndex,
    hasManifest: !!manifest,
    integrityZomes: manifest?.integrity_zomes.length || 0,
    coordinatorZomes: manifest?.coordinator_zomes.length || 0,
  });

  return serializeResult(instance, zomeInfoData);
};
