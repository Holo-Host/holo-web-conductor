/**
 * sys_time host function
 *
 * Returns the current system time.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";

/**
 * sys_time host function implementation
 *
 * Returns current time as microseconds since UNIX epoch.
 * Timestamp is a newtype i64 wrapper that serializes as bare i64.
 */
export const sysTime: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { instance } = context;

  // Timestamp(i64) is microseconds since UNIX epoch
  const timestampMicros = Date.now() * 1000;

  return serializeResult(instance, timestampMicros);
};
