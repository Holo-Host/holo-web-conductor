/**
 * Result Decoder - Decodes msgpack-wrapped results to JavaScript objects
 *
 * This decoder only handles msgpack decoding, NOT display formatting.
 * UI-specific formatting (like base64 encoding) should be done in the UI layer.
 */

import { decode } from "@msgpack/msgpack";

/**
 * Decode msgpack-wrapped result to JavaScript objects
 * Returns native JavaScript types (Uint8Array for binary data)
 */
export function decodeResult(resultBytes: Uint8Array): unknown {
  // Simply decode the msgpack bytes to JavaScript objects
  return decode(resultBytes);
}
