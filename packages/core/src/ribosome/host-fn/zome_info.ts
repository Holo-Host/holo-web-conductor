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
 * For coordinator zomes, entry_defs come from dependent integrity zomes.
 */
export const zomeInfo: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;

  // Get manifest from call context
  const manifest = callContext.dnaManifest;

  // Find current zome in manifest
  const integrityZomes = manifest?.integrity_zomes || [];
  const coordinatorZomes = manifest?.coordinator_zomes || [];
  const allZomes = [...integrityZomes, ...coordinatorZomes];

  const currentZome = allZomes.find((z) => z.name === callContext.zome);
  const zomeIndex = currentZome?.index ?? 0;

  // Check if current zome is a coordinator zome
  const isCoordinator = coordinatorZomes.some((z) => z.name === callContext.zome);

  // Encode properties
  const propertiesBytes = new Uint8Array(encode(manifest?.properties || {}));

  // Build zome_types from entry_defs
  // For coordinator zomes, we need to look up entry_defs from dependent integrity zomes
  const zomeTypes = {
    entries: [] as Array<[number, number[]]>,
    links: [] as Array<[number, number[]]>,
  };

  // Collect all entry_defs that are in scope for this zome
  let allEntryDefs: EntryDef[] = [];

  if (isCoordinator && currentZome) {
    // Coordinator zome: get entry_defs and link_types from dependent integrity zomes
    const dependencies = currentZome.dependencies || [];
    console.log(`[zome_info] Coordinator zome '${callContext.zome}' dependencies:`, dependencies);

    for (const depName of dependencies) {
      const integrityZome = integrityZomes.find((z) => z.name === depName);
      if (integrityZome) {
        // Add entry_defs
        if (integrityZome.entryDefs && integrityZome.entryDefs.length > 0) {
          const entryDefIndices = integrityZome.entryDefs.map((_, index) => index);
          zomeTypes.entries.push([integrityZome.index, entryDefIndices]);
          allEntryDefs = allEntryDefs.concat(integrityZome.entryDefs);
        }

        // Add link_types - use the actual count from link_types callback
        const linkTypeCount = integrityZome.linkTypeCount ?? 0;
        if (linkTypeCount > 0) {
          const linkTypeIndices = Array.from({ length: linkTypeCount }, (_, i) => i);
          zomeTypes.links.push([integrityZome.index, linkTypeIndices]);
        }

        console.log(`[zome_info] Added from integrity zome '${depName}':`, {
          zomeIndex: integrityZome.index,
          entryDefsCount: integrityZome.entryDefs?.length || 0,
          linkTypeCount,
        });
      }
    }
  } else if (currentZome) {
    // Integrity zome: use own entry_defs and link_types
    if (currentZome.entryDefs) {
      allEntryDefs = currentZome.entryDefs;
      const entryDefIndices = allEntryDefs.map((_, index) => index);
      zomeTypes.entries.push([zomeIndex, entryDefIndices]);
    }

    const linkTypeCount = currentZome.linkTypeCount ?? 0;
    if (linkTypeCount > 0) {
      const linkTypeIndices = Array.from({ length: linkTypeCount }, (_, i) => i);
      zomeTypes.links.push([zomeIndex, linkTypeIndices]);
    }
  }

  console.log('[zome_info] entry_defs:', {
    hasCurrentZome: !!currentZome,
    isCoordinator,
    entryDefsLength: allEntryDefs.length,
    zomeTypesEntries: zomeTypes.entries,
  });

  const zomeInfoData: ZomeInfo = {
    name: callContext.zome,
    id: zomeIndex,
    properties: propertiesBytes,
    entry_defs: allEntryDefs,
    extern_fns: [], // TODO: Extract from manifest
    zome_types: zomeTypes,
  };

  console.log(`[zome_info] Returning info for zome: ${callContext.zome}`, {
    index: zomeIndex,
    hasManifest: !!manifest,
    integrityZomes: integrityZomes.length,
    coordinatorZomes: coordinatorZomes.length,
    entryDefs: allEntryDefs.length,
  });

  return serializeResult(instance, zomeInfoData);
};
