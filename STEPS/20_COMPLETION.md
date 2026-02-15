# Step 20 Completion: Validation Host Functions & Validate Callback

**Completed**: 2026-02-12
**Branch**: `step-20-validation`

## Summary

Implemented the full validation pipeline: Op type construction, working `must_get_*` host functions (replacing stubs), validate callback invocation with zome resolution, and pre-commit inline validation integrated into callZome.

## What Was Done

### Phase 1: Type Definitions
- `packages/core/src/dht/validate-types.ts` - ValidateCallbackResult, UnresolvedDependencies, ChainFilter
- `packages/core/src/dht/validation-op.ts` - Op type (7 variants), EntryCreationAction, SignedHashed, buildOpFromRecord, recordToOps, pendingRecordToOps
- `packages/core/src/ribosome/error.ts` - UnresolvedDependenciesError class
- `packages/core/src/ribosome/call-context.ts` - isValidationContext flag

### Phase 2: must_get_* Host Functions
Replaced stubs with real Cascade-based implementations:
- `must_get_entry.ts` - Returns EntryHashed via Cascade lookup
- `must_get_action.ts` - Returns SignedActionHashed via Cascade lookup
- `must_get_valid_record.ts` - Returns Record via Cascade lookup
- `must_get_agent_activity.ts` (new) - Queries local storage for agent chain

All throw UnresolvedDependenciesError in validation context when data not found.

### Phase 3: Validate Callback Invocation
- `packages/core/src/ribosome/validate.ts` - invokeInlineValidation(), getZomesToInvoke(), callValidateExport()
- Matches Holochain's zome resolution: entry_type.App.zome_index for entry ops, zome_index for link ops, all integrity zomes for RegisterAgentActivity

### Phase 4: Integration into callZome
- `packages/core/src/ribosome/index.ts` - Inline validation between result unwrapping and commitTransaction
- Rolls back transaction on validation failure

### Phase 5: Tests
- `validation-op.test.ts` - 29 tests (Op construction, structure verification)
- `must_get.test.ts` - 12 tests (all 4 host functions, normal + validation context)
- `validate.test.ts` - 8 tests (pipeline flow with mocked WASM)

## Test Results

49 new tests, all passing. No regressions in existing tests. TypeScript compiles cleanly.

## Key Design Decisions

- **Op is externally tagged** (serde default) while Action is internally tagged (`type` field). Inner structs in Op variants have the `type` field stripped.
- **EntryCreationAction** wraps Create/Update as `{ Create: {...} }` / `{ Update: {...} }` (externally tagged).
- **ChainOpType to Op mapping**: RegisterUpdatedContent + RegisterUpdatedRecord both map to RegisterUpdate; RegisterDeletedBy + RegisterDeletedEntryAction both map to RegisterDelete.
- **RegisterDeleteLink** requires a CreateLinkResolver callback to fetch the original CreateLink from Cascade.
- **Zero-arc constraint**: UnresolvedDependencies is reported as an error (no background retry).
