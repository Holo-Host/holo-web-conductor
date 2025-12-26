/**
 * zome_info host function
 *
 * Returns information about the current zome.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";

/**
 * Zome info response structure
 */
export interface ZomeInfo {
  /** Name of the current zome */
  name: string;

  /** Zome ID (index in DNA's zome list) */
  id: number;

  /** Properties for this zome */
  properties: Record<string, unknown>;
}

/**
 * zome_info host function implementation
 *
 * Returns current zome name and metadata.
 */
export const zomeInfo: HostFunctionImpl = (context, inputPtr) => {
  const { callContext, instance } = context;

  const zomeInfoData: ZomeInfo = {
    name: callContext.zome,
    id: 0, // Mock zome ID
    properties: {},
  };

  return serializeResult(instance, zomeInfoData);
};
