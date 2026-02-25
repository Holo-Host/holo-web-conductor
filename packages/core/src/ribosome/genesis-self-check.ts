/**
 * Genesis Self-Check Callback
 *
 * Runs the `genesis_self_check` WASM callback on each integrity zome
 * before creating genesis records. This allows the DNA to validate
 * the membrane proof and agent key before allowing the agent to join.
 *
 * Matches Holochain's genesis_workflow.rs:
 * 1. Build GenesisSelfCheckDataV2 { membrane_proof, agent_key }
 * 2. Call genesis_self_check on each integrity zome
 * 3. If any returns Invalid, abort genesis
 * 4. If no genesis_self_check export, treat as Valid
 *
 * Reference: holochain/crates/holochain/src/core/workflow/genesis_workflow.rs
 * Reference: holochain/crates/holochain_integrity_types/src/genesis.rs
 */

import { encode } from "@msgpack/msgpack";
import sodium from "libsodium-wrappers";
import { createLogger } from "@hwc/shared";

import type { CallContext } from "./call-context";
import type { DnaManifestRuntime, ZomeDefinition } from "../types/bundle-types";
import { getRibosomeRuntime } from "./runtime";
import { getHostFunctionRegistry } from "./host-fn";
import {
  serializeToWasm,
  deserializeFromWasm,
} from "./serialization";

const log = createLogger("GenesisSelfCheck");

/**
 * Result of genesis self-check
 */
export interface GenesisSelfCheckResult {
  valid: boolean;
  reason?: string;
}

/**
 * Run genesis_self_check on all integrity zomes.
 *
 * @param dnaManifest - DNA manifest with integrity zome definitions (includes properties)
 * @param cellId - [DnaHash, AgentPubKey] for the cell being created
 * @param membraneProof - Optional membrane proof bytes
 * @returns GenesisSelfCheckResult
 */
export async function runGenesisSelfCheck(
  dnaManifest: DnaManifestRuntime,
  cellId: [Uint8Array, Uint8Array],
  membraneProof?: Uint8Array,
): Promise<GenesisSelfCheckResult> {
  const [dnaHash, agentPubKey] = cellId;

  log.debug(`Running genesis_self_check for ${dnaManifest.integrity_zomes.length} integrity zomes`);

  for (const zomeDef of dnaManifest.integrity_zomes) {
    if (!zomeDef.wasm || zomeDef.wasm.length === 0) {
      log.debug(`Skipping zome ${zomeDef.name} (no WASM available)`);
      continue;
    }

    const result = await callGenesisSelfCheckExport(
      zomeDef,
      cellId,
      membraneProof,
      dnaManifest
    );

    if (!result.valid) {
      log.debug(`genesis_self_check failed in ${zomeDef.name}: ${result.reason}`);
      return result;
    }

    log.debug(`genesis_self_check passed in ${zomeDef.name}`);
  }

  log.debug("genesis_self_check passed for all integrity zomes");
  return { valid: true };
}

/**
 * Call the `genesis_self_check` WASM export on an integrity zome.
 *
 * Serializes GenesisSelfCheckDataV2 matching Holochain's serde format:
 * ```rust
 * struct GenesisSelfCheckDataV2 {
 *   membrane_proof: Option<MembraneProof>,  // MembraneProof = Arc<SerializedBytes>
 *   agent_key: AgentPubKey,
 * }
 * ```
 *
 * MembraneProof is Arc<SerializedBytes>. SerializedBytes serializes as
 * msgpack binary (serde_bytes). So membrane_proof is Option<bytes>.
 */
async function callGenesisSelfCheckExport(
  zomeDef: ZomeDefinition,
  cellId: [Uint8Array, Uint8Array],
  membraneProof: Uint8Array | undefined,
  dnaManifest: DnaManifestRuntime
): Promise<GenesisSelfCheckResult> {
  const runtime = getRibosomeRuntime();
  const registry = getHostFunctionRegistry();
  const [dnaHash, agentPubKey] = cellId;

  // Compile/cache the integrity zome WASM
  const wasmHash = new Uint8Array([
    ...dnaHash,
    ...new TextEncoder().encode(zomeDef.name),
  ]);
  const module = await runtime.getOrCompileModule(wasmHash, zomeDef.wasm!);

  // Create a context for host function calls (dna_info, verify_signature, etc.)
  const context: CallContext = {
    cellId,
    zome: zomeDef.name,
    fn: "genesis_self_check",
    payload: null,
    provenance: agentPubKey,
    dnaManifest,
    isValidationContext: true,
  };

  // Ensure libsodium is initialized before building imports — verify_signature host
  // function calls sodium.crypto_sign_verify_detached synchronously, which hangs if
  // sodium.ready hasn't been awaited yet (no prior CALL_ZOME on a fresh worker).
  await sodium.ready;

  // Build import object with host functions
  const instanceRef = { current: null as WebAssembly.Instance | null };
  const imports = registry.buildImportObject(instanceRef, context);

  // Instantiate WASM
  const instance = await runtime.instantiateModule(module, imports);
  instanceRef.current = instance;

  // Check if genesis_self_check export exists
  // HDI macro rewrites callback names with version suffix: genesis_self_check -> genesis_self_check_2
  const selfCheckFn = (instance.exports.genesis_self_check_2 ??
    instance.exports.genesis_self_check) as
    | ((ptr: number, len: number) => bigint)
    | undefined;

  if (!selfCheckFn) {
    log.debug(`${zomeDef.name}: No genesis_self_check export, returning Valid`);
    return { valid: true };
  }

  try {
    // Build GenesisSelfCheckDataV2
    // membrane_proof is Option<Arc<SerializedBytes>>. Following Holochain/volla convention,
    // SerializedBytes inner bytes are always msgpack-encoded. The Rust zome does
    // rmp_serde::from_slice on those bytes to recover Vec<u8> (the raw sig bytes).
    // Pre-encode the raw proof bytes as msgpack(Vec<u8>) so Rust can decode them correctly.
    // membrane_proof is Option<Arc<SerializedBytes>>. The Rust zome uses
    // UnsafeBytes::from(proof).into::<Vec<u8>>() to read the raw inner bytes directly.
    // So the membrane proof IS the raw signature bytes — no msgpack pre-encoding needed.
    // When encode(selfCheckData) runs, the Uint8Array is encoded as msgpack bin, and
    // Rust's SerializedBytes stores those raw bytes which UnsafeBytes then extracts.
    const selfCheckData = {
      membrane_proof: membraneProof ?? null,
      agent_key: agentPubKey,
    };

    // Serialize to WASM via ExternIO format (double-encode)
    const dataBytes = new Uint8Array(encode(selfCheckData));
    const { ptr: inputPtr, len: inputLen } = serializeToWasm(instance, dataBytes);

    // Call genesis_self_check
    const resultI64 = selfCheckFn(inputPtr, inputLen);

    // Extract ptr and len from result
    const resultPtr = Number(resultI64 >> 32n);
    const resultLen = Number(resultI64 & 0xffffffffn);

    // Deserialize result
    const result = deserializeFromWasm(instance, resultPtr, resultLen);

    // Result is ExternResult<ValidateCallbackResult>
    // = { Ok: ValidateCallbackResult } | { Err: WasmError }
    if (result && typeof result === "object") {
      if ("Ok" in result) {
        let okValue = (result as Record<string, unknown>).Ok;
        // If Ok value is ExternIO (Uint8Array), decode it
        if (okValue instanceof Uint8Array) {
          const { decode } = await import("@msgpack/msgpack");
          okValue = decode(okValue);
        }
        // ValidateCallbackResult: "Valid" | { Invalid: string } | { UnresolvedDependencies: ... }
        if (okValue === "Valid") {
          return { valid: true };
        }
        if (typeof okValue === "object" && okValue !== null && "Invalid" in okValue) {
          return {
            valid: false,
            reason: (okValue as { Invalid: string }).Invalid,
          };
        }
        // UnresolvedDependencies treated as failure for genesis
        if (typeof okValue === "object" && okValue !== null && "UnresolvedDependencies" in okValue) {
          return {
            valid: false,
            reason: "genesis_self_check returned UnresolvedDependencies",
          };
        }
        // Unknown Ok variant - treat as valid
        return { valid: true };
      }
      if ("Err" in result) {
        const errPayload = (result as Record<string, unknown>).Err;
        const errObj = errPayload as Record<string, unknown> | undefined;
        const errorMsg =
          errObj?.Guest || errObj?.message || JSON.stringify(errPayload);
        return {
          valid: false,
          reason: `genesis_self_check error: ${errorMsg}`,
        };
      }
    }

    // Unexpected result format - treat as valid (lenient)
    log.debug(`${zomeDef.name}: Unexpected genesis_self_check result:`, result);
    return { valid: true };
  } catch (error) {
    log.debug(`${zomeDef.name}: genesis_self_check threw:`, error);
    return {
      valid: false,
      reason: `genesis_self_check threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
