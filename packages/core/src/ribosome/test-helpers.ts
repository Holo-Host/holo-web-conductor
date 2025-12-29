/**
 * Test helpers for integration tests
 *
 * These helpers mock the behavior of the extension's zome call handling,
 * which wraps/unwraps payloads in ExternIO format via MessagePack serialization.
 */

import { encode, decode } from "@msgpack/msgpack";
import { callZome, ZomeCallResult } from "./index";
import type { ZomeCallRequest } from "./call-context";

/**
 * Call a zome function with extension-like payload wrapping
 *
 * This mimics what the extension does in background/index.ts:
 * 1. Serialize payload to MessagePack bytes (ExternIO input wrapper)
 * 2. Call ribosome's callZome
 * 3. Unwrap Result<T, E> and decode ExternIO output wrapper
 *
 * @param request - Zome call request with raw payload
 * @returns Decoded result (not wrapped in Ok/Err)
 * @throws Error if zome call returns Err
 */
export async function callZomeAsExtension(
  request: Omit<ZomeCallRequest, "payload"> & { payload: unknown }
): Promise<{ result: unknown; signals: any[] }> {
  // STEP 1: Wrap payload in ExternIO format (like extension does)
  // Extension serializes payload to MessagePack, creating Uint8Array
  // When ribosome encodes this Uint8Array, it creates bin8 format = ExternIO
  const payloadBytes = new Uint8Array(encode(request.payload));

  // STEP 2: Call ribosome with wrapped payload
  const zomeCallResult: ZomeCallResult = await callZome({
    ...request,
    payload: payloadBytes,
  });

  const { result: zomeResult, signals } = zomeCallResult;

  // STEP 3: Unwrap Result<T, E>
  // Check for Err and throw (like extension does)
  if (zomeResult && typeof zomeResult === "object" && "Err" in zomeResult) {
    const errorMsg =
      typeof (zomeResult as any).Err === "string"
        ? (zomeResult as any).Err
        : JSON.stringify((zomeResult as any).Err);
    throw new Error(`Zome call failed: ${errorMsg}`);
  }

  // Extract Ok value if present
  const unwrappedResult =
    zomeResult && typeof zomeResult === "object" && "Ok" in zomeResult
      ? (zomeResult as { Ok: unknown }).Ok
      : zomeResult;

  // STEP 4: Decode ExternIO output wrapper
  // If result is Uint8Array, it's MessagePack-encoded data that needs decoding
  const decodedResult =
    unwrappedResult instanceof Uint8Array
      ? decode(unwrappedResult)
      : unwrappedResult;

  console.log('[callZomeAsExtension] Final result type:',
    decodedResult instanceof Uint8Array ? `Uint8Array(${decodedResult.length})` :
    Array.isArray(decodedResult) ? `Array(${decodedResult.length})` :
    typeof decodedResult);

  return {
    result: decodedResult,
    signals,
  };
}
