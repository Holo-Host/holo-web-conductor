/**
 * random_bytes host function
 *
 * Generates cryptographically secure random bytes.
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";

/**
 * Random bytes input structure
 */
interface RandomBytesInput {
  /** Number of random bytes to generate */
  length: number;
}

/**
 * random_bytes host function implementation
 *
 * Uses the Web Crypto API to generate cryptographically secure random bytes.
 */
export const randomBytes: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { instance } = context;

  // Deserialize input to get desired length
  const input = deserializeFromWasm(instance, inputPtr, inputLen) as RandomBytesInput;
  const length = typeof input === "number" ? input : input.length;

  // Generate random bytes using Web Crypto API
  const randomData = new Uint8Array(length);
  crypto.getRandomValues(randomData);

  return serializeResult(instance, randomData);
};
