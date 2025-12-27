/**
 * dna_info host function
 *
 * Returns information about the current DNA.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";

/**
 * DNA info response structure
 */
export interface DnaInfo {
  /** DNA hash */
  hash: Uint8Array;

  /** DNA name */
  name: string;

  /** DNA properties (arbitrary data) */
  properties: Record<string, unknown>;

  /** List of zome names in this DNA */
  zome_names: string[];

  /** DNA modifiers */
  modifiers: {
    /** Network seed for DHT isolation */
    network_seed: string;

    /** Properties used during DNA creation */
    properties: Record<string, unknown>;

    /** Origin time (microseconds since UNIX epoch) */
    origin_time: number;
  };
}

/**
 * dna_info host function implementation
 *
 * Returns DNA hash and metadata.
 * For now, returns mock data with basic structure.
 */
export const dnaInfo: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;

  // Get DNA hash from cell ID
  const [dnaHash, _agentPubKey] = callContext.cellId;

  // Mock DNA info data
  const dnaInfoData: DnaInfo = {
    hash: dnaHash,
    name: "mock_dna",
    properties: {},
    zome_names: [callContext.zome], // Current zome at minimum
    modifiers: {
      network_seed: "",
      properties: {},
      origin_time: Date.now() * 1000, // Current time in microseconds
    },
  };

  return serializeResult(instance, dnaInfoData);
};
