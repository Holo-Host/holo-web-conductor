/**
 * send_remote_signal host function
 *
 * Sends signals to remote agents via the kitsune2 network.
 * Signals are signed and queued for delivery through the linker.
 *
 * Reference: holochain/crates/holochain/src/core/ribosome/host_fn/send_remote_signal.rs
 */

import { HostFunctionImpl } from "./base";
import { deserializeFromWasm, serializeResult } from "../serialization";
import { encode } from "@msgpack/msgpack";
import { blake2b256 } from "../../hash";
import { getLairClient } from "../../signing";
import { sliceCore32 } from "@holochain/client";

/**
 * Input from WASM (matches hdk RemoteSignal type)
 */
interface RemoteSignalInput {
  /** Target agents to send signal to */
  agents: Uint8Array[];
  /** Signal payload (ExternIO bytes) */
  signal: Uint8Array;
}

/**
 * Signed signal for transport to linker
 */
export interface SignedRemoteSignal {
  /** Target agent public key (as array for JSON transport) */
  target_agent: number[];
  /** Serialized ZomeCallParams (as array for JSON transport) */
  zome_call_params: number[];
  /** Ed25519 signature of the params hash (64 bytes, as array for JSON transport) */
  signature: number[];
}

/**
 * send_remote_signal host function implementation
 *
 * For each target agent:
 * 1. Build ZomeCallParams structure matching Holochain format
 * 2. Serialize to msgpack
 * 3. Hash with blake2b-256
 * 4. Sign hash with sender's Ed25519 key via Lair
 * 5. Queue for delivery through linker WebSocket
 *
 * Fire-and-forget semantics: returns immediately, delivery is async.
 */
export const sendRemoteSignal: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { callContext, instance } = context;

  // Deserialize RemoteSignal input from WASM
  const input = deserializeFromWasm(instance, inputPtr, inputLen) as RemoteSignalInput;

  // Get sender info from call context
  const [dnaHash, fromAgent] = callContext.cellId;
  const zomeName = callContext.zome;

  // Generate nonce (32 random bytes) - Holochain uses Nonce256Bits
  const nonce = crypto.getRandomValues(new Uint8Array(32));

  // Set expiry to 5 minutes from now (Holochain uses microseconds)
  const nowMicros = BigInt(Date.now()) * 1000n;
  const expiresAt = nowMicros + 300_000_000n; // 5 minutes in microseconds

  // Get Lair client for signing
  const lairClient = getLairClient();

  // Extract raw 32-byte Ed25519 key from 39-byte AgentPubKey
  const rawFromPubKey = sliceCore32(fromAgent);

  // Build signed signals for each target
  const remoteSignals: SignedRemoteSignal[] = [];

  for (const targetAgent of input.agents) {
    // Build ZomeCallParams structure matching holochain_zome_types::zome_io::ZomeCallParams
    // Note: Holochain uses #[serde(tag = "type")] internally but ZomeCallParams is not an enum
    const zomeCallParams = {
      provenance: fromAgent,
      cell_id: [dnaHash, targetAgent],
      zome_name: zomeName,
      fn_name: "recv_remote_signal",
      cap_secret: null,
      payload: input.signal,
      nonce: nonce,
      expires_at: Number(expiresAt), // msgpack doesn't handle BigInt well
    };

    // Serialize params to msgpack
    const serialized = encode(zomeCallParams);
    const serializedBytes = new Uint8Array(serialized);

    // Hash the serialized bytes with blake2b-256
    const hash = blake2b256(serializedBytes);

    // Sign the hash with Lair (synchronous)
    const signature = lairClient.signSync(rawFromPubKey, hash);

    remoteSignals.push({
      target_agent: Array.from(targetAgent),
      zome_call_params: Array.from(serializedBytes),
      signature: Array.from(signature),
    });
  }

  // Queue for delivery (similar to emittedSignals pattern)
  if (!callContext.remoteSignals) {
    callContext.remoteSignals = [];
  }
  callContext.remoteSignals.push(...remoteSignals);

  console.log(
    `[send_remote_signal] Queued ${remoteSignals.length} signals from ${zomeName}`
  );

  // Return null (void) - fire-and-forget semantics
  return serializeResult(instance, null);
};
