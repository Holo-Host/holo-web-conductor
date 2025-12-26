/**
 * sys_time host function
 *
 * Returns the current system time.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";

/**
 * Timestamp structure (microseconds since UNIX epoch)
 */
interface Timestamp {
  /** Seconds component */
  secs: number;
  /** Nanoseconds component */
  nanos: number;
}

/**
 * sys_time host function implementation
 *
 * Returns current time as microseconds since UNIX epoch.
 * Holochain uses a Timestamp struct with secs and nanos fields.
 */
export const sysTime: HostFunctionImpl = (context, inputPtr) => {
  const { instance } = context;

  // Get current time in milliseconds
  const nowMs = Date.now();

  // Convert to seconds and nanoseconds
  const secs = Math.floor(nowMs / 1000);
  const nanos = (nowMs % 1000) * 1_000_000; // Convert remaining ms to ns

  const timestamp: Timestamp = {
    secs,
    nanos,
  };

  return serializeResult(instance, timestamp);
};
