/**
 * trace host function
 *
 * Logs trace messages from WASM to the console.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";

/**
 * Trace levels
 */
enum TraceLevel {
  Error = "error",
  Warn = "warn",
  Info = "info",
  Debug = "debug",
  Trace = "trace",
}

/**
 * Trace input structure
 */
interface TraceInput {
  /** Log level */
  level?: TraceLevel;
  /** Message to log */
  msg: string;
}

/**
 * trace host function implementation
 *
 * Logs trace messages to the browser console with formatted output.
 * Format: [TRACE][zome_name] message
 */
export const trace: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;

  console.log(
    `[trace] ptr=${inputPtr}, len=${inputLen}, memSize=${(instance.exports.memory as WebAssembly.Memory).buffer.byteLength}`
  );

  // Deserialize trace input
  const input = deserializeFromWasm(instance, inputPtr, inputLen) as TraceInput;

  // Handle both string input and structured input
  const message = typeof input === "string" ? input : input.msg;
  const level = typeof input === "string" ? TraceLevel.Info : (input.level || TraceLevel.Info);

  // Format log message with zome name
  const formattedMsg = `[TRACE][${callContext.zome}] ${message}`;

  // Log to appropriate console level
  switch (level) {
    case TraceLevel.Error:
      console.error(formattedMsg);
      break;
    case TraceLevel.Warn:
      console.warn(formattedMsg);
      break;
    case TraceLevel.Info:
      console.info(formattedMsg);
      break;
    case TraceLevel.Debug:
      console.debug(formattedMsg);
      break;
    case TraceLevel.Trace:
      console.log(formattedMsg);
      break;
    default:
      console.log(formattedMsg);
  }

  // Return unit/null
  return serializeResult(instance, null);
};
