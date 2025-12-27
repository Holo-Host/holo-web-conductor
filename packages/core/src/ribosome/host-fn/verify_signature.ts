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
 * Matches holochain_integrity_types::signature::VerifySignature
 */
interface VerifySignatureInput {
  /** Public key to verify against (39-byte AgentPubKey) */
  key: Uint8Array;

  /** Signature to verify (64-byte Ed25519 signature) */
  signature: Uint8Array;

  /** Data that was signed */
  data: Uint8Array;
}

/**
 * verify_signature host function implementation
 *
 * Verifies an Ed25519 signature using libsodium.
 * This is a public operation (doesn't require Lair access).
 *
 * NOTE: libsodium must be initialized before calling (done in ribosome/index.ts)
 */
export const verifySignature: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { instance } = context;

  // Deserialize input
  const input = deserializeFromWasm(
    instance,
    inputPtr,
    inputLen
  ) as VerifySignatureInput;

  const { key, data, signature } = input;

  // Extract raw 32-byte public key from 39-byte AgentPubKey
  // Format: [prefix(3)][hash(32)][location(4)]
  const rawPubKey = key.slice(3, 35);

  // Verify signature using libsodium
  let valid: boolean;
  try {
    valid = sodium.crypto_sign_verify_detached(signature, data, rawPubKey);
  } catch (error) {
    // Invalid signature format or verification failed
    valid = false;
  }

  return serializeResult(instance, valid);
};
