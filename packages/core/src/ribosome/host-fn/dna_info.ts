/**
 * dna_info host function (v1 and v2)
 *
 * Returns information about the current DNA.
 *
 * v1: DnaInfoV1 { name, hash, properties, zome_names }
 * v2: DnaInfoV2 { name, hash, modifiers: { network_seed, properties }, zome_names }
 *
 * HDI 0.7+ calls __hc__dna_info_2 which expects DnaInfoV2.
 * Reference: holochain/crates/holochain_integrity_types/src/info.rs
 */

import { encode } from "@msgpack/msgpack";
import { HostFunctionImpl } from "./base";
import { serializeResult } from "../serialization";

/**
 * Get all zome names from the DNA manifest.
 */
function getAllZomeNames(context: { callContext: { dnaManifest?: { integrity_zomes?: { name: string }[]; coordinator_zomes?: { name: string }[] } } }): string[] {
  const manifest = context.callContext.dnaManifest;
  if (!manifest) return [];
  const names: string[] = [];
  for (const z of manifest.integrity_zomes || []) names.push(z.name);
  for (const z of manifest.coordinator_zomes || []) names.push(z.name);
  return names;
}

/**
 * dna_info v1 host function (__hc__dna_info_1)
 *
 * DnaInfoV1 { name, hash, properties, zome_names }
 * properties is SerializedBytes (Uint8Array of msgpack-encoded data)
 */
export const dnaInfo: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;
  const [dnaHash] = callContext.cellId;
  const manifest = callContext.dnaManifest;

  const propertiesBytes = new Uint8Array(encode(manifest?.properties || null));

  return serializeResult(instance, {
    name: manifest?.name || "unknown",
    hash: dnaHash,
    properties: propertiesBytes,
    zome_names: getAllZomeNames(context),
  });
};

/**
 * dna_info v2 host function (__hc__dna_info_2)
 *
 * DnaInfoV2 { name, hash, modifiers: DnaModifiers, zome_names }
 * DnaModifiers { network_seed: String, properties: SerializedBytes }
 *
 * SerializedBytes is serialized as msgpack binary (Uint8Array).
 */
export const dnaInfoV2: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;
  const [dnaHash] = callContext.cellId;
  const manifest = callContext.dnaManifest;

  // SerializedBytes of properties: msgpack-encode the properties value
  // Default is () encoded as msgpack nil = [0xc0]
  const propertiesBytes = new Uint8Array(encode(manifest?.properties || null));

  return serializeResult(instance, {
    name: manifest?.name || "unknown",
    hash: dnaHash,
    modifiers: {
      network_seed: manifest?.network_seed || "",
      properties: propertiesBytes,
    },
    zome_names: getAllZomeNames(context),
  });
};
