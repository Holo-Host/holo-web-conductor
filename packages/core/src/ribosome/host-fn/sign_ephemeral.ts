/**
 * sign_ephemeral host function
 *
 * Signs data with an ephemeral (temporary) keypair.
 */

import sodium from "libsodium-wrappers";
import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";

/**
 * Sign ephemeral input structure
 */
interface SignEphemeralInput {
  /** Data to sign */
  data: Uint8Array;
}

/**
 * Sign ephemeral result structure
 */
interface SignEphemeralResult {
  /** Public key of the ephemeral keypair */
  pub_key: Uint8Array;

  /** Signature */
  signature: Uint8Array;
}

/**
 * sign_ephemeral host function implementation
 *
 * Generates a new ephemeral Ed25519 keypair and signs the data.
 * The keypair is not stored anywhere (truly ephemeral).
 */
export const signEphemeral: HostFunctionImpl = (context, inputPtr) => {
  const { instance } = context;

  // Ensure libsodium is ready (will be initialized on first call)
  if (!sodium.ready) {
    throw new Error("libsodium not ready");
  }

  // Deserialize input
  const input = deserializeFromWasm(instance, inputPtr, 0) as SignEphemeralInput;
  const data = input instanceof Uint8Array ? input : input.data;

  // Generate ephemeral keypair
  const keypair = sodium.crypto_sign_keypair();

  // Sign the data
  const signature = sodium.crypto_sign_detached(data, keypair.privateKey);

  const result: SignEphemeralResult = {
    pub_key: keypair.publicKey,
    signature,
  };

  return serializeResult(instance, result);
};

// Initialize libsodium on module load
await sodium.ready;
