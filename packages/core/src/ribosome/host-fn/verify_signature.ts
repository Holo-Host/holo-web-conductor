/**
 * verify_signature host function
 *
 * Verifies an Ed25519 signature.
 */

import sodium from "libsodium-wrappers";
import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";

/**
 * Verify signature input structure
 */
interface VerifySignatureInput {
  /** Public key to verify against */
  pub_key: Uint8Array;

  /** Data that was signed */
  data: Uint8Array;

  /** Signature to verify */
  signature: Uint8Array;
}

/**
 * verify_signature host function implementation
 *
 * Verifies an Ed25519 signature using libsodium.
 * This is a public operation (doesn't require Lair access).
 */
export const verifySignature: HostFunctionImpl = (context, inputPtr) => {
  const { instance } = context;

  // Ensure libsodium is ready
  if (!sodium.ready) {
    throw new Error("libsodium not ready");
  }

  // Deserialize input
  const input = deserializeFromWasm(
    instance,
    inputPtr,
    0
  ) as VerifySignatureInput;

  const { pub_key, data, signature } = input;

  // Verify signature using libsodium
  let valid: boolean;
  try {
    valid = sodium.crypto_sign_verify_detached(signature, data, pub_key);
  } catch (error) {
    // Invalid signature format or verification failed
    valid = false;
  }

  return serializeResult(instance, valid);
};

// Initialize libsodium on module load
await sodium.ready;
