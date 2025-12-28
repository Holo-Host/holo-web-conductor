/**
 * emit_signal host function
 *
 * Collects signals emitted by zome code for delivery to UI.
 * Signals are stored in call context and returned after zome execution completes.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";

/**
 * emit_signal host function implementation
 *
 * Input: AppSignal (Uint8Array - msgpack-encoded signal payload)
 * Output: null (void)
 *
 * Signals are accumulated in the call context and delivered separately
 * after the zome call completes.
 */
export const emit_signal: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;

  // Deserialize the signal payload (AppSignal is ExternIO/Uint8Array)
  const signalBytes = deserializeFromWasm(instance, inputPtr, inputLen) as Uint8Array;

  // Initialize signals array if not present
  if (!callContext.emittedSignals) {
    callContext.emittedSignals = [];
  }

  // Store signal with metadata
  callContext.emittedSignals.push({
    cell_id: callContext.cellId,
    zome_name: callContext.zome,
    signal: signalBytes,
    timestamp: Date.now(),
  });

  console.log(
    `[emit_signal] Signal emitted from ${callContext.zome}, ` +
    `${signalBytes.length} bytes, total signals: ${callContext.emittedSignals.length}`
  );

  // Return null (void) - signals are delivered separately
  return serializeResult(instance, null);
};
