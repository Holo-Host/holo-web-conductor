/**
 * sign_ephemeral host function
 *
 * Signs data with an ephemeral (temporary) keypair.
 */

import sodium from "libsodium-wrappers";
import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";
import { hashFrom32AndType, HoloHashType } from "@holochain/client";

/** libsodium returns Uint8Array by default; the type defs don't narrow the union. */
function asBytes(value: string | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new Error("Expected Uint8Array from libsodium, got string");
}

/**
 * Sign ephemeral result structure
 * Matches holochain_integrity_types::signature::EphemeralSignatures
 */
interface EphemeralSignatures {
  /** Public key of the ephemeral keypair (39-byte AgentPubKey) */
  key: Uint8Array;

  /** Signatures for each input data (pairwise ordered) */
  signatures: Uint8Array[];
}

/**
 * sign_ephemeral host function implementation
 *
 * Generates a new ephemeral Ed25519 keypair and signs multiple data items.
 * The keypair is not stored anywhere (truly ephemeral).
 *
 * Input: SignEphemeral(Vec<Bytes>) - array of byte arrays to sign
 * Output: EphemeralSignatures { key, signatures }
 *
 * NOTE: libsodium must be initialized before calling (done in ribosome/index.ts)
 */
export const signEphemeral: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { instance } = context;

  // Deserialize input: Vec<Bytes> serializes as array of Uint8Arrays
  const datas = deserializeFromWasm(instance, inputPtr, inputLen) as Uint8Array[];

  // Generate ephemeral keypair
  const rawKeypair = sodium.crypto_sign_keypair();
  const publicKey = asBytes(rawKeypair.publicKey);
  const privateKey = asBytes(rawKeypair.privateKey);

  // Sign each data item
  const signatures = datas.map(data =>
    asBytes(sodium.crypto_sign_detached(data, privateKey))
  );

  // Construct 39-byte AgentPubKey using @holochain/client utility
  const agentPubKey = hashFrom32AndType(publicKey, HoloHashType.Agent);

  const result: EphemeralSignatures = {
    key: agentPubKey,
    signatures,
  };

  return serializeResult(instance, result);
};
