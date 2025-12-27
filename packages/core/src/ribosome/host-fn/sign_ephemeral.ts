/**
 * sign_ephemeral host function
 *
 * Signs data with an ephemeral (temporary) keypair.
 */

import sodium from "libsodium-wrappers";
import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";

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
  const keypair = sodium.crypto_sign_keypair();

  // Sign each data item
  const signatures = datas.map(data =>
    sodium.crypto_sign_detached(data, keypair.privateKey)
  );

  // Construct 39-byte AgentPubKey: [prefix(3)][hash(32)][location(4)]
  const agentPubKey = new Uint8Array(39);
  agentPubKey.set([132, 32, 36], 0); // AGENT_PREFIX
  agentPubKey.set(keypair.publicKey, 3); // 32-byte public key
  agentPubKey.set([0, 0, 0, 0], 35); // location (all zeros)

  const result: EphemeralSignatures = {
    key: agentPubKey,
    signatures,
  };

  return serializeResult(instance, result);
};
