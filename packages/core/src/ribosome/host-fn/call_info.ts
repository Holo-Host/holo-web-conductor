/**
 * call_info host function
 *
 * Returns information about the current zome call.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";

/**
 * Call info response structure
 */
export interface CallInfo {
  /** Provenance of the call (agent making the call) */
  provenance: Uint8Array;

  /** Capability grant used (null for public functions) */
  cap_grant: null | {
    /** Tag identifying the capability grant */
    tag: string;
    /** Access type */
    access: string;
  };
}

/**
 * call_info host function implementation
 *
 * Returns provenance (caller's agent pub key) and capability grant info.
 */
export const callInfo: HostFunctionImpl = (context, inputPtr) => {
  const { callContext, instance } = context;

  const callInfoData: CallInfo = {
    provenance: callContext.provenance,
    cap_grant: null, // Public call (no capability grant required)
  };

  return serializeResult(instance, callInfoData);
};
