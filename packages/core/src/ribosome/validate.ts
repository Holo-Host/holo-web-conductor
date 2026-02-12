/**
 * Validation Pipeline
 *
 * Implements inline validation for fishy:
 * - Converts pending records to Op types
 * - Resolves which integrity zome(s) to invoke for each Op
 * - Calls the `validate` WASM export on each integrity zome
 * - Aggregates results, throwing on Invalid or UnresolvedDependencies
 *
 * Reference: holochain/crates/holochain/src/core/workflow/call_zome_workflow.rs
 *   inline_validation() at lines 271-331
 * Reference: holochain/crates/holochain/src/core/workflow/app_validation_workflow.rs
 *   validate_op(), get_zomes_to_invoke() at lines 540-721
 */

import { encode } from "@msgpack/msgpack";
import { createLogger } from "@fishy/shared";

import type { CallContext, PendingRecord } from "./call-context";
import type { DnaManifestRuntime, ZomeDefinition } from "../types/bundle-types";
import type { Op } from "../dht/validation-op";
import type { ValidateCallbackResult } from "../dht/validate-types";
import {
  buildOpFromRecord,
  getOpVariant,
  type CreateLinkResolver,
} from "../dht/validation-op";
import { actionToOpTypes, ChainOpType } from "../dht/dht-op-types";
import { buildRecord } from "../dht/record-converter";
import { UnresolvedDependenciesError } from "./error";
import { getRibosomeRuntime } from "./runtime";
import { getHostFunctionRegistry } from "./host-fn";
import {
  serializeToWasm,
  deserializeFromWasm,
} from "./serialization";
import { getStorageProvider } from "../storage/storage-provider";
import { Cascade, getNetworkCache, getNetworkService } from "../network";
import { toHolochainAction } from "./host-fn/action-serialization";
import type { StoredAction } from "../storage/types";

const log = createLogger("Validate");

// ============================================================================
// Public API
// ============================================================================

/**
 * Run inline validation on pending records before committing.
 *
 * Matches Holochain's inline_validation flow:
 * 1. For each pending record
 * 2. For each op type from actionToOpTypes(action)
 * 3. Build the Op
 * 4. Determine which integrity zome(s) to invoke
 * 5. Call validate export on each zome
 * 6. If any returns Invalid, throw (caller should rollback)
 * 7. If any returns UnresolvedDependencies, throw (fishy can't retry)
 *
 * @param pendingRecords - Records created during this zome call
 * @param context - The current call context
 * @param dnaManifest - DNA manifest with integrity zome definitions
 * @throws Error if validation fails (Invalid or UnresolvedDependencies)
 */
export async function invokeInlineValidation(
  pendingRecords: PendingRecord[],
  context: CallContext,
  dnaManifest: DnaManifestRuntime
): Promise<void> {
  if (pendingRecords.length === 0) return;

  log.debug(
    `Running inline validation on ${pendingRecords.length} pending records`
  );

  const [dnaHash] = context.cellId;

  // Build a CreateLink resolver using Cascade for RegisterDeleteLink ops
  const createLinkResolver = buildCreateLinkResolver(dnaHash);

  for (const pendingRecord of pendingRecords) {
    const record = buildRecord(pendingRecord.action, pendingRecord.entry);
    const action = record.signed_action.hashed.content;
    const opTypes = actionToOpTypes(action);

    for (const opType of opTypes) {
      const op = buildOpFromRecord(record, opType, createLinkResolver);
      if (!op) {
        log.debug(
          ` Skipping op type ${opType} (could not build, e.g. missing CreateLink for DeleteLink)`
        );
        continue;
      }

      const variant = getOpVariant(op);
      log.debug(` Validating Op::${variant}`);

      // Determine which integrity zome(s) to invoke
      const zomes = getZomesToInvoke(op, dnaManifest, dnaHash);

      for (const zomeDef of zomes) {
        if (!zomeDef.wasm || zomeDef.wasm.length === 0) {
          log.debug(
            `  Skipping zome ${zomeDef.name} (no WASM available)`
          );
          continue;
        }

        const result = await callValidateExport(
          zomeDef,
          op,
          context,
          dnaHash
        );

        if (result === "Valid") {
          log.debug(`  ${zomeDef.name}: Valid`);
          continue;
        }

        if (typeof result === "object" && "Invalid" in result) {
          throw new Error(
            `Validation failed (${zomeDef.name}, Op::${variant}): ${result.Invalid}`
          );
        }

        if (
          typeof result === "object" &&
          "UnresolvedDependencies" in result
        ) {
          throw new Error(
            `Validation has unresolved dependencies (${zomeDef.name}, Op::${variant})`
          );
        }
      }
    }
  }

  log.debug("Inline validation passed for all records");
}

// ============================================================================
// Zome Resolution
// ============================================================================

/**
 * Determine which integrity zome(s) to invoke for validation of an Op.
 *
 * Follows Holochain's get_zomes_to_invoke logic from app_validation_workflow.rs:
 *
 * | Op variant               | Zome resolution                                    |
 * |--------------------------|----------------------------------------------------|
 * | RegisterAgentActivity    | All integrity zomes                                |
 * | StoreRecord (App entry)  | integrity_zomes[action.entry_type.App.zome_index]  |
 * | StoreRecord (non-App)    | All integrity zomes                                |
 * | StoreEntry (App entry)   | integrity_zomes[action.entry_type.App.zome_index]  |
 * | StoreEntry (non-App)     | All integrity zomes                                |
 * | RegisterUpdate (App)     | integrity_zomes[update.entry_type.App.zome_index]  |
 * | RegisterUpdate (non-App) | All integrity zomes                                |
 * | RegisterDelete           | Look up deleted action's entry type zome index     |
 * | RegisterCreateLink       | integrity_zomes[create_link.zome_index]            |
 * | RegisterDeleteLink       | integrity_zomes[create_link.zome_index]            |
 */
function getZomesToInvoke(
  op: Op,
  dnaManifest: DnaManifestRuntime,
  dnaHash: Uint8Array
): ZomeDefinition[] {
  const allIntegrity = dnaManifest.integrity_zomes;

  if ("RegisterAgentActivity" in op) {
    return allIntegrity;
  }

  if ("StoreRecord" in op) {
    const action = op.StoreRecord.record.signed_action.hashed.content;
    const zomeIndex = extractZomeIndexFromAction(action, dnaHash);
    if (zomeIndex !== null) {
      const zome = allIntegrity[zomeIndex];
      return zome ? [zome] : allIntegrity;
    }
    return allIntegrity;
  }

  if ("StoreEntry" in op) {
    const entryCreationAction = op.StoreEntry.action.hashed.content;
    const zomeIndex = extractZomeIndexFromEntryCreationAction(entryCreationAction);
    if (zomeIndex !== null) {
      const zome = allIntegrity[zomeIndex];
      return zome ? [zome] : allIntegrity;
    }
    return allIntegrity;
  }

  if ("RegisterUpdate" in op) {
    const update = op.RegisterUpdate.update.hashed.content;
    const entryType = (update as any).entry_type;
    const zomeIndex = extractZomeIndexFromEntryType(entryType);
    if (zomeIndex !== null) {
      const zome = allIntegrity[zomeIndex];
      return zome ? [zome] : allIntegrity;
    }
    return allIntegrity;
  }

  if ("RegisterDelete" in op) {
    // Need to look up deleted action's entry type
    // For inline validation, the deleted action should be in local storage
    const deleteContent = op.RegisterDelete.delete.hashed.content;
    const deletesAddress = (deleteContent as any).deletes_address;
    if (deletesAddress) {
      const storage = getStorageProvider();
      const deletedAction = storage.getAction(deletesAddress);
      if (deletedAction) {
        const zomeIndex = extractZomeIndexFromStoredAction(deletedAction);
        if (zomeIndex !== null) {
          const zome = allIntegrity[zomeIndex];
          return zome ? [zome] : allIntegrity;
        }
      }
    }
    return allIntegrity;
  }

  if ("RegisterCreateLink" in op) {
    const createLink = op.RegisterCreateLink.create_link.hashed.content;
    const zomeIndex = (createLink as any).zome_index;
    if (typeof zomeIndex === "number") {
      const zome = allIntegrity[zomeIndex];
      return zome ? [zome] : allIntegrity;
    }
    return allIntegrity;
  }

  if ("RegisterDeleteLink" in op) {
    const createLink = op.RegisterDeleteLink.create_link;
    const zomeIndex = (createLink as any).zome_index;
    if (typeof zomeIndex === "number") {
      const zome = allIntegrity[zomeIndex];
      return zome ? [zome] : allIntegrity;
    }
    return allIntegrity;
  }

  return allIntegrity;
}

/**
 * Extract zome_index from an Action (internally tagged format).
 * Returns the zome_index from entry_type.App or CreateLink.zome_index.
 */
function extractZomeIndexFromAction(
  action: unknown,
  dnaHash: Uint8Array
): number | null {
  if (!action || typeof action !== "object") return null;
  const a = action as Record<string, unknown>;

  // CreateLink has zome_index directly
  if (a.type === "CreateLink" && typeof a.zome_index === "number") {
    return a.zome_index;
  }

  // Delete/DeleteLink - need to look up the original
  if (a.type === "Delete" || a.type === "DeleteLink") {
    const address =
      a.type === "Delete"
        ? (a as any).deletes_address
        : (a as any).link_add_address;
    if (address) {
      const storage = getStorageProvider();
      const original = storage.getAction(address);
      if (original) {
        return extractZomeIndexFromStoredAction(original);
      }
    }
    return null;
  }

  // Create/Update have entry_type
  return extractZomeIndexFromEntryType(a.entry_type);
}

/**
 * Extract zome_index from an EntryCreationAction (externally tagged).
 */
function extractZomeIndexFromEntryCreationAction(
  eca: unknown
): number | null {
  if (!eca || typeof eca !== "object") return null;
  const obj = eca as Record<string, unknown>;

  let inner: Record<string, unknown> | null = null;
  if ("Create" in obj) inner = obj.Create as Record<string, unknown>;
  else if ("Update" in obj) inner = obj.Update as Record<string, unknown>;

  if (!inner) return null;
  return extractZomeIndexFromEntryType(inner.entry_type);
}

/**
 * Extract zome_index from an entry_type value.
 * entry_type can be: { App: { zome_index, entry_index, visibility } } | "AgentPubKey" | ...
 */
function extractZomeIndexFromEntryType(
  entryType: unknown
): number | null {
  if (!entryType || typeof entryType !== "object") return null;
  const et = entryType as Record<string, unknown>;
  if ("App" in et) {
    const app = et.App as Record<string, unknown>;
    if (typeof app.zome_index === "number") return app.zome_index;
  }
  return null;
}

/**
 * Extract zome_index from a StoredAction.
 */
function extractZomeIndexFromStoredAction(
  stored: unknown
): number | null {
  if (!stored || typeof stored !== "object") return null;
  const s = stored as Record<string, unknown>;

  // StoredAction has entryType as { entry_index, zome_id } for app entries
  if (s.actionType === "CreateLink" && typeof s.zomeIndex === "number") {
    return s.zomeIndex as number;
  }

  const entryType = s.entryType as Record<string, unknown> | undefined;
  if (entryType && typeof entryType.zome_id === "number") {
    return entryType.zome_id;
  }

  return null;
}

// ============================================================================
// WASM Validate Callback
// ============================================================================

/**
 * Call the `validate` WASM export on an integrity zome.
 *
 * Flow:
 * 1. Compile/cache the integrity zome's WASM module
 * 2. Create a validation-specific CallContext with isValidationContext = true
 * 3. Build import object with host functions
 * 4. Instantiate WASM module
 * 5. Check if `validate` export exists (if not, return "Valid")
 * 6. Serialize the Op with msgpack, pass to validate
 * 7. Deserialize and return the ValidateCallbackResult
 *
 * If the WASM throws (including UnresolvedDependenciesError from must_get_*),
 * it's caught and converted to UnresolvedDependencies or Invalid.
 */
async function callValidateExport(
  zomeDef: ZomeDefinition,
  op: Op,
  parentContext: CallContext,
  dnaHash: Uint8Array
): Promise<ValidateCallbackResult> {
  const runtime = getRibosomeRuntime();
  const registry = getHostFunctionRegistry();

  // Compile/cache the integrity zome WASM
  const wasmHash = new Uint8Array([
    ...dnaHash,
    ...new TextEncoder().encode(zomeDef.name),
  ]);
  const module = await runtime.getOrCompileModule(wasmHash, zomeDef.wasm!);

  // Create validation-specific context
  const validationContext: CallContext = {
    cellId: parentContext.cellId,
    zome: zomeDef.name,
    fn: "validate",
    payload: null,
    provenance: parentContext.provenance,
    dnaManifest: parentContext.dnaManifest,
    isValidationContext: true,
  };

  // Build import object with host functions
  const instanceRef = { current: null as WebAssembly.Instance | null };
  const imports = registry.buildImportObject(instanceRef, validationContext);

  // Instantiate WASM
  const instance = await runtime.instantiateModule(module, imports);
  instanceRef.current = instance;

  // Check if validate export exists
  const validateFn = instance.exports.validate as
    | ((ptr: number, len: number) => bigint)
    | undefined;

  if (!validateFn) {
    log.debug(`  ${zomeDef.name}: No validate export, returning Valid`);
    return "Valid";
  }

  try {
    // Serialize Op to WASM memory
    // The HDK's validate function receives ExternIO bytes containing the Op
    // ExternIO = msgpack-encoded bytes wrapped in another msgpack layer
    const opBytes = new Uint8Array(encode(op));
    const { ptr: inputPtr, len: inputLen } = serializeToWasm(
      instance,
      opBytes
    );

    // Call validate
    const resultI64 = validateFn(inputPtr, inputLen);

    // Extract ptr and len from result
    const resultPtr = Number(resultI64 >> 32n);
    const resultLen = Number(resultI64 & 0xffffffffn);

    // Deserialize result
    const result = deserializeFromWasm(instance, resultPtr, resultLen);

    // Result is ExternResult<ValidateCallbackResult>
    // = { Ok: ValidateCallbackResult } | { Err: WasmError }
    if (result && typeof result === "object") {
      if ("Ok" in result) {
        let okValue = (result as any).Ok;
        // If Ok value is ExternIO (Uint8Array), decode it
        if (okValue instanceof Uint8Array) {
          const { decode } = await import("@msgpack/msgpack");
          okValue = decode(okValue);
        }
        return okValue as ValidateCallbackResult;
      }
      if ("Err" in result) {
        const errPayload = (result as any).Err;
        const errorMsg =
          errPayload?.Guest || errPayload?.message || JSON.stringify(errPayload);
        return { Invalid: `Validate callback error: ${errorMsg}` };
      }
    }

    // Unexpected result format
    log.debug(`  ${zomeDef.name}: Unexpected validate result:`, result);
    return "Valid";
  } catch (error) {
    // UnresolvedDependenciesError from must_get_* host functions
    if (
      error instanceof Error &&
      error.name === "UnresolvedDependenciesError"
    ) {
      const udError = error as UnresolvedDependenciesError;
      return { UnresolvedDependencies: udError.dependencies };
    }

    // Other WASM errors
    log.debug(
      `  ${zomeDef.name}: Validate callback threw:`,
      error
    );
    return {
      Invalid: `Validate callback threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build a CreateLink resolver that uses Cascade to fetch original CreateLink
 * actions for RegisterDeleteLink ops.
 */
function buildCreateLinkResolver(
  dnaHash: Uint8Array
): CreateLinkResolver {
  return (linkAddAddress) => {
    const storage = getStorageProvider();
    const cascade = new Cascade(
      storage,
      getNetworkCache(),
      getNetworkService()
    );
    const record = cascade.fetchRecord(dnaHash, linkAddAddress);
    if (!record) return null;

    const action = record.signed_action.hashed.content;
    // Convert to wire format if needed
    const localActionType = (action as unknown as StoredAction).actionType;
    let wireAction: any;
    if (typeof localActionType === "string") {
      wireAction = toHolochainAction(action as unknown as StoredAction);
    } else {
      wireAction = action;
    }

    // Verify it's a CreateLink and strip the type field
    if (wireAction.type !== "CreateLink") return null;
    const { type: _type, ...rest } = wireAction;
    return rest;
  };
}
