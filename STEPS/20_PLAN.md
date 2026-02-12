# Step 20: Validation Host Functions and Validate Callback

## Context

Fishy currently executes WASM zome functions and commits data to the source chain without running the app's `validate` callback. This means:
- Invalid data can be committed locally
- The `must_get_*` host functions are stubs returning null, so any zome code calling them fails
- No self-check before commit, breaking Holochain's data integrity model

This step implements the validation pipeline: the `Op` type system, working `must_get_*` host functions, the validate callback invocation, and integration into the commit flow as an inline self-check.

**Reference implementation**: `../holochain/crates/holochain/src/core/workflow/call_zome_workflow.rs` lines 271-331 (`inline_validation`)

---

## Phase 1: Type Definitions

### 1a. Create `packages/core/src/dht/validation-op.ts` (NEW)

Define the `Op` type for app validation (distinct from the existing `ChainOp` used for DHT publishing in `dht-op-types.ts`).

The Op enum serializes as **externally tagged** in serde/msgpack (no `#[serde(tag)]` on Rust Op enum):
```
{ "StoreRecord": { "record": Record } }
{ "StoreEntry": { "action": SignedHashed<EntryCreationAction>, "entry": Entry } }
{ "RegisterAgentActivity": { "action": SignedActionHashed, "cached_entry": null } }
{ "RegisterUpdate": { "update": SignedHashed<Update>, "new_entry": Entry|null } }
{ "RegisterDelete": { "delete": SignedHashed<Delete> } }
{ "RegisterCreateLink": { "create_link": SignedHashed<CreateLink> } }
{ "RegisterDeleteLink": { "delete_link": SignedHashed<DeleteLink>, "create_link": CreateLink } }
```

Types to define:
- `Op` discriminated union (7 variants)
- `StoreRecord`, `StoreEntry`, `RegisterAgentActivity`, `RegisterUpdate`, `RegisterDelete`, `RegisterCreateLink`, `RegisterDeleteLink` structs
- `EntryCreationAction` enum: `{ "Create": Create }` | `{ "Update": Update }`

Serialization structures (must match Holochain's serde format):
- `SignedHashed<T>` = `{ hashed: { content: T, hash: Hash }, signature: Signature }`
- `HoloHashed<T>` = `{ content: T, hash: Hash }`
- `EntryHashed` = `{ content: Entry, hash: EntryHash }`

Reuse `@holochain/client` types for `Record`, `Action`, `Entry`, `Signature`, `SignedActionHashed`.

### 1b. Create `packages/core/src/dht/validate-types.ts` (NEW)

```typescript
export type ValidateCallbackResult =
  | "Valid"
  | { Invalid: string }
  | { UnresolvedDependencies: UnresolvedDependencies };

export type UnresolvedDependencies =
  | { Hashes: Uint8Array[] }
  | { AgentActivity: [Uint8Array, ChainFilter] };
```

### 1c. Add `pendingRecordToOps()` to `validation-op.ts`

Convert a `PendingRecord` into an array of `Op` objects. Uses same mapping as existing `actionToOpTypes()` from `dht-op-types.ts`:

| Action Type | Ops Produced |
|---|---|
| Create | StoreRecord, StoreEntry, RegisterAgentActivity |
| Update | StoreRecord, StoreEntry, RegisterUpdate, RegisterAgentActivity |
| Delete | StoreRecord, RegisterDelete, RegisterAgentActivity |
| CreateLink | StoreRecord, RegisterCreateLink, RegisterAgentActivity |
| DeleteLink | StoreRecord, RegisterDeleteLink, RegisterAgentActivity |

**Reuse**: `actionToOpTypes()` from `dht-op-types.ts`, `toHolochainAction()` from `action-serialization.ts`, `buildRecords()` from `record-converter.ts`.

---

## Phase 2: Implement `must_get_*` Host Functions

### 2a. Add `UnresolvedDependenciesError` to `packages/core/src/ribosome/error.ts`

```typescript
export class UnresolvedDependenciesError extends Error {
  constructor(public dependencies: UnresolvedDependencies) {
    super('Unresolved dependencies during validation');
    this.name = 'UnresolvedDependenciesError';
  }
}
```

### 2b. Add `isValidationContext` to `CallContext`

In `packages/core/src/ribosome/call-context.ts`:
```typescript
export interface CallContext {
  // ... existing fields ...
  isValidationContext?: boolean;
}
```

### 2c. Update `wrapHostFunction` in `packages/core/src/ribosome/host-fn/base.ts`

Pass `UnresolvedDependenciesError` through unwrapped:
```typescript
if (error instanceof Error && error.name === "UnresolvedDependenciesError") {
  throw error;
}
```

### 2d. Replace stub: `must_get_entry.ts`

1. Deserialize `MustGetEntryInput` (an `EntryHash`)
2. Use `Cascade` to look up entry (same pattern as `get.ts`)
3. If found: return `EntryHashed` = `{ content: Entry, hash: EntryHash }`
4. If NOT found and `isValidationContext`: throw `UnresolvedDependenciesError`
5. If NOT found otherwise: throw host function error

### 2e. Replace stub: `must_get_action.ts`

1. Deserialize `MustGetActionInput` (an `ActionHash`)
2. Use `Cascade` to fetch record by action hash
3. If found: return `SignedActionHashed` = `{ hashed: { content: Action, hash: ActionHash }, signature }`
4. If NOT found: same error logic

### 2f. Replace stub: `must_get_valid_record.ts`

1. Deserialize `MustGetValidRecordInput` (an `ActionHash`)
2. Use `Cascade` to fetch record
3. If found: return full `Record` (same format as `get.ts`)
4. If NOT found: same error logic
5. For fishy (zero-arc): treat all data as valid (we trust gateway peers validated it)

### 2g. New file: `must_get_agent_activity.ts`

1. Deserialize `MustGetAgentActivityInput { author, chain_filter }`
2. Query local storage for agent's chain via `storage.queryActions()`
3. Return `Vec<RegisterAgentActivity>` (array of `{ action: SignedActionHashed, cached_entry: null }`)
4. If not found: throw `UnresolvedDependenciesError`
5. Register in `host-fn/index.ts` replacing the stubs import

---

## Phase 3: Validate Callback Invocation

### 3a. Create `packages/core/src/ribosome/validate.ts` (NEW)

Main function:
```typescript
export async function invokeInlineValidation(
  pendingRecords: PendingRecord[],
  context: CallContext,
  dnaManifest: DnaManifestRuntime,
): Promise<void>
```

Flow (matching Holochain's `inline_validation`):
```
for each pendingRecord:
  for each opType in actionToOpTypes(record.action):
    op = buildOp(pendingRecord, opType)
    zomes = getZomesToInvoke(op, dnaManifest)
    for each integrityZome in zomes:
      result = callValidateExport(integrityZome, op, context)
      if Invalid -> throw ValidationError (rollback)
      if UnresolvedDependencies -> throw (fishy can't retry)
```

### 3b. `getZomesToInvoke(op, dnaManifest)`

Following `app_validation_workflow.rs:629-721`:

| Op variant | Zome resolution |
|---|---|
| RegisterAgentActivity | All integrity zomes |
| StoreRecord/StoreEntry with App entry | `integrity_zomes[entry_type.App.zome_index]` |
| StoreRecord/StoreEntry with non-App entry | All integrity zomes |
| RegisterUpdate with App entry | `integrity_zomes[update.entry_type.App.zome_index]` |
| RegisterDelete | Look up deleted action's entry type zome index |
| RegisterCreateLink | `integrity_zomes[create_link.zome_index]` |
| RegisterDeleteLink | `integrity_zomes[create_link.zome_index]` |

### 3c. `callValidateExport(zomeDef, op, context)`

1. Get/compile integrity zome WASM via `getRibosomeRuntime().getOrCompileModule()`
2. Create validation `CallContext` with `isValidationContext: true`
3. Build import object via `registry.buildImportObject()`
4. Instantiate WASM module
5. Check if `validate` export exists; if not -> return Valid
6. Serialize Op via `serializeToWasm(instance, op)`
7. Call `validate(ptr, len)` -> get result i64
8. Deserialize result, unwrap `{ Ok: ValidateCallbackResult }`
9. If WASM throws `UnresolvedDependenciesError` -> catch and convert

---

## Phase 4: Integration into callZome Flow

### 4a. Modify `packages/core/src/ribosome/index.ts`

Insert validation between result unwrapping (~line 313) and `commitTransaction()` (~line 318):

```typescript
// Run inline validation on pending records (NOT genesis records)
const zomeCallPendingRecords = context.pendingRecords || [];
if (zomeCallPendingRecords.length > 0 && dnaManifest) {
  try {
    await invokeInlineValidation(zomeCallPendingRecords, context, dnaManifest);
    log.debug(' Inline validation passed');
  } catch (validationError) {
    if (storage.isTransactionActive()) {
      storage.rollbackTransaction();
    }
    throw new Error(`Validation failed: ${validationError.message}`);
  }
}
```

Genesis records are NOT validated (system records, matching Holochain behavior).

---

## Phase 5: Tests

### 5a. `packages/core/src/dht/validation-op.test.ts`

- pendingRecordToOps creates correct ops for Create, Update, Delete, CreateLink, DeleteLink
- Op serialization format matches expected msgpack structure

### 5b. `packages/core/src/ribosome/host-fn/must_get.test.ts`

- must_get_entry returns EntryHashed when entry exists
- must_get_entry throws UnresolvedDependenciesError in validation context when not found
- must_get_entry throws host error in normal context when not found
- must_get_action returns SignedActionHashed when action exists
- must_get_valid_record returns Record when record exists

### 5c. `packages/core/src/ribosome/validate.test.ts`

- Validation passes when validate export returns Valid
- Validation fails and rolls back when validate returns Invalid
- Correct integrity zome selected for each Op type
- Validation skipped when validate export doesn't exist
- Full callZome flow succeeds with validation

Run: `nix develop -c npm run test`

---

## Files Summary

| Action | File |
|---|---|
| NEW | `packages/core/src/dht/validation-op.ts` |
| NEW | `packages/core/src/dht/validate-types.ts` |
| NEW | `packages/core/src/ribosome/validate.ts` |
| NEW | `packages/core/src/ribosome/host-fn/must_get_agent_activity.ts` |
| NEW | `packages/core/src/dht/validation-op.test.ts` |
| NEW | `packages/core/src/ribosome/host-fn/must_get.test.ts` |
| NEW | `packages/core/src/ribosome/validate.test.ts` |
| MODIFY | `packages/core/src/ribosome/error.ts` - add UnresolvedDependenciesError |
| MODIFY | `packages/core/src/ribosome/call-context.ts` - add isValidationContext |
| MODIFY | `packages/core/src/ribosome/host-fn/base.ts` - error passthrough |
| MODIFY | `packages/core/src/ribosome/host-fn/must_get_entry.ts` - replace stub |
| MODIFY | `packages/core/src/ribosome/host-fn/must_get_action.ts` - replace stub |
| MODIFY | `packages/core/src/ribosome/host-fn/must_get_valid_record.ts` - replace stub |
| MODIFY | `packages/core/src/ribosome/host-fn/stubs.ts` - remove mustGetAgentActivity |
| MODIFY | `packages/core/src/ribosome/host-fn/index.ts` - register must_get_agent_activity |
| MODIFY | `packages/core/src/ribosome/index.ts` - insert validation before commit |
| MODIFY | `packages/core/src/dht/index.ts` - export new modules |

## Key Reuse Points

- `Cascade` from `network/cascade.ts` - local->cache->network lookup
- `actionToOpTypes()` from `dht/dht-op-types.ts` - action to op type mapping
- `toHolochainAction()` from `host-fn/action-serialization.ts` - stored to wire format
- `getRibosomeRuntime().getOrCompileModule()` from `ribosome/runtime.ts` - WASM caching
- `getHostFunctionRegistry().buildImportObject()` from `host-fn/index.ts`
- `serializeToWasm()`, `deserializeFromWasm()`, `serializeResult()` from `ribosome/serialization.ts`
- `buildRecords()` from `dht/record-converter.ts`

## Risks

1. **Op serialization mismatch** - Op must serialize exactly as WASM expects. Mitigation: byte-level tests against real integrity zomes.
2. **WASM instantiation overhead** - Module compilation cached by runtime; reuse instances for same zome.
3. **Fishy can't retry UnresolvedDependencies** - Zero-arc has no background retry. Report error to caller, app can retry.
