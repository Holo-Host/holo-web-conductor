# Step 7.3: Type Safety Improvements

## Goal

Systematically improve type safety across the fishy extension codebase, eliminating `any` types and adding proper TypeScript definitions at critical API boundaries. This is a code cleanup step to prevent the class of serialization and data format errors encountered during development.

---

## Type Source Authority

**All Holochain-related types must be vetted against canonical sources:**

1. **Primary**: `@holochain/client` npm package - Use types directly when available
2. **Secondary**: `../holochain` Rust codebase - Reference when types not exported by client

**Key principles:**
- Use specific Hash types (`ActionHash`, `EntryHash`, `DnaHash`, `AgentPubKey`) instead of generic `Uint8Array`
- Use `@holochain/client` utilities for base64 conversions (`encodeHashToBase64`, `decodeHashFromBase64`)
- Use `@holochain/client` conversion utilities instead of custom implementations
- Cross-reference Rust struct definitions for serialization format accuracy

---

## Analysis Summary

### Critical Areas Identified

1. **Host Functions** (32 files in `packages/core/src/ribosome/host-fn/`)
   - Widespread use of `as any` casts in deserialization
   - Missing input/output type definitions
   - No runtime validation of WASM inputs
   - Type safety score: 2-6/10 across files

2. **API Boundaries** (4 communication layers)
   - Page API (`inject/index.ts`): `Promise<any>` returns, `callback: (signal: any)`
   - Content Script: Type casts with `as any`
   - Background Worker: `message.payload as any` pattern throughout
   - Offscreen Document: `MinimalZomeCallRequest` uses `any` for critical fields

3. **Network/Storage Layers**
   - `NetworkRecord` vs `StoredRecord` type mismatch with `as any` conversions
   - Gateway response parsing with `JSON.parse` returning untyped data
   - Heuristic-based byte array detection (false positive risk)
   - `number` vs `bigint` timestamp inconsistency

---

## Implementation Plan

### Phase 1: Foundation - Core Type Definitions (Day 1) - COMPLETE

**Goal**: Establish strong type definitions that all other code will use, leveraging `@holochain/client` types.

**Files modified**:
- `packages/core/src/types/holochain-types.ts` - Expanded with @holochain/client types
- `packages/core/src/types/index.ts` - Created central export
- `packages/core/src/storage/types.ts` - Added StoredAction alias

**Completed Tasks**:
- [x] Audited `@holochain/client` exports - documented hash types and utilities
- [x] Added `encodeHashToBase64`/`decodeHashFromBase64` utility re-exports
- [x] Imported and re-exported Action type variants from @holochain/client
- [x] Created `StoredAction` type alias in storage layer
- [x] Created `WireAction`/`WireSignedActionHashed` type aliases for wire format clarity
- [x] Added type guards: `isCreateAction()`, `isUpdateAction()`, `isDeleteAction()`, etc.
- [x] Added utility type guards: `isUint8Array()`, `isHoloHash()`, `isCellId()`
- [x] All tests pass

---

### Phase 2: Host Function Input/Output Types (Day 1-2) - COMPLETE

**Goal**: Type all host function inputs and outputs, eliminating `as any` casts.

**Architecture Decision**: Centralized validators with configurable runtime validation

Rather than scattering type definitions and validators in each host function file, we created:
1. `packages/core/src/ribosome/wasm-io-types.ts` - All WASM input types and validators
2. `deserializeTypedFromWasm<T>()` in serialization.ts - Generic typed deserializer

Runtime validation is controlled by `WASM_INPUT_VALIDATION_ENABLED` flag (default: true for development).
This catches format mismatches during development while allowing optimization in production.

**Files created/modified**:
- [x] `packages/core/src/ribosome/wasm-io-types.ts` - NEW: Central type definitions and validators
- [x] `packages/core/src/ribosome/serialization.ts` - Added `deserializeTypedFromWasm<T>()`
- [x] `packages/core/src/ribosome/host-fn/create.ts` - Uses centralized types
- [x] `packages/core/src/ribosome/host-fn/get.ts` - Uses centralized types
- [x] `packages/core/src/ribosome/host-fn/update.ts` - Uses centralized types
- [x] `packages/core/src/ribosome/host-fn/delete.ts` - Uses centralized types
- [x] `packages/core/src/ribosome/host-fn/query.ts` - Uses centralized types
- [x] `packages/core/src/ribosome/host-fn/get_links.ts` - Uses centralized types

**Pattern applied**:
```typescript
// Before
const input = deserializeFromWasm(instance, inputPtr, inputLen) as any;

// After - validator passed to deserializer, validation controlled by global flag
import { validateWasmCreateInput, type WasmCreateInput } from "../wasm-io-types";

const input = deserializeTypedFromWasm(
  instance, inputPtr, inputLen,
  validateWasmCreateInput, 'WasmCreateInput'
);
// input is now typed as WasmCreateInput
```

**Types defined in wasm-io-types.ts**:
- `WasmCreateInput` - entry_location, entry_visibility, entry, chain_top_ordering
- `WasmGetInput` - any_dht_hash, get_options
- `WasmUpdateInput` - original_action_address, entry, chain_top_ordering
- `WasmDeleteInput` - deletes_action_hash, chain_top_ordering
- `WasmQueryInput` - sequence_range, entry_type, entry_hashes, action_type, include_entries, order_descending
- `WasmGetLinksInput` - base_address, link_type, tag_prefix, get_options
- `WasmCreateLinkInput` - base_address, target_address, zome_index, link_type, tag, chain_top_ordering
- `WasmDeleteLinkInput` - link_add_address, chain_top_ordering

---

### Phase 3: API Boundary Message Types (Day 2)

**Goal**: Type all Chrome message passing with discriminated unions.

**Files to modify**:
1. `packages/extension/src/lib/messaging.ts` - Core message types
2. `packages/extension/src/inject/index.ts` - Page API types
3. `packages/extension/src/content/index.ts` - Bridge types
4. `packages/extension/src/background/index.ts` - Handler types
5. `packages/extension/src/offscreen/index.ts` - Offscreen types

**Tasks**:
1. [ ] Define `MessagePayload` discriminated union by message type
2. [ ] Type `sendToContentScript()` with specific payload types per message
3. [ ] Replace `message.payload as any` with type-narrowed handlers
4. [ ] Type signal payloads with `AppSignal` interface
5. [ ] Create `MinimalZomeCallRequest` with proper tuple types (not `[any, any]`)
6. [ ] Add `ResponsePayload` type union for success responses
7. [ ] Run extension build: `npm run build`
8. [ ] Manual smoke test: load extension, run basic zome call

---

### Phase 4: Network/Storage Layer Types (Day 2-3)

**Goal**: Align network and storage types, use `@holochain/client` utilities for conversions.

**Files to modify**:
1. `packages/core/src/network/types.ts` - Network layer types
2. `packages/core/src/storage/types.ts` - Storage layer types
3. `packages/core/src/network/sync-xhr-service.ts` - Gateway response parsing
4. `packages/core/src/network/cascade.ts` - Type conversions

**Tasks**:
1. [ ] Align `NetworkRecord` and `StoredRecord` field types with `@holochain/client` Record type
2. [ ] Replace custom `toBase64Url()` with `encodeHashToBase64` from `@holochain/client`
3. [ ] Replace custom `base64ToUint8Array()` with `decodeHashFromBase64` from `@holochain/client`
4. [ ] Replace `normalizeByteArrays(data: any)` with typed variant using hash type knowledge
5. [ ] Add explicit `GatewayRecordResponse` interface for gateway JSON (vet against Rust types)
6. [ ] Type `parseRecordResponse()` to validate against interface
7. [ ] Standardize timestamp as `bigint` internally, convert at boundaries
8. [ ] Remove heuristic byte detection - use explicit field knowledge from types
9. [ ] Type `storedToNetworkRecord()` without `as any` casts
10. [ ] Run network tests: `npm test`

---

### Phase 5: Validation Helpers and Guards (Day 3)

**Goal**: Add runtime validation for data crossing WASM/network boundaries.

**Files to create/modify**:
1. `packages/core/src/types/guards.ts` - New file for type guards
2. `packages/core/src/types/validators.ts` - New file for validators

**Tasks**:
1. [ ] Create `isUint8Array()` type guard
2. [ ] Create `validateHash(data, expectedPrefix)` helper
3. [ ] Create `validateEntry(data): Entry` validator with exhaustive type check
4. [ ] Create `validateAction(data): Action` validator
5. [ ] Add validation at WASM deserialization boundary
6. [ ] Add validation at gateway response parsing
7. [ ] Run full test suite: `npm test`
8. [ ] E2E test with gateway

---

### Phase 6: Consolidate Duplicate Code and Use @holochain/client Utilities (Day 3)

**Goal**: Remove duplicated utility functions, replace custom implementations with `@holochain/client` utilities where applicable.

**Pattern identified**: `toUint8Array()` and `normalizeUint8Arrays()` duplicated in:
- `packages/extension/src/inject/index.ts`
- `packages/extension/src/background/index.ts`
- `packages/extension/src/offscreen/index.ts`
- `packages/core/src/ribosome/host-fn/get.ts`
- `packages/core/src/network/sync-xhr-service.ts`

**Custom implementations to replace with @holochain/client**:
- `toBase64Url()` → `encodeHashToBase64`
- `base64ToUint8Array()` → `decodeHashFromBase64`
- Any hash serialization/deserialization helpers

**Tasks**:
1. [ ] Audit all custom utility functions for @holochain/client equivalents
2. [ ] Create `packages/core/src/utils/bytes.ts` with typed versions (only for utilities not in @holochain/client)
3. [ ] Create `packages/core/src/utils/holochain.ts` to re-export @holochain/client utilities for consistency
4. [ ] Replace all custom base64/hash conversions with @holochain/client utilities
5. [ ] Replace all duplicated byte utilities with imports from shared module
6. [ ] Export utilities from `packages/core/src/index.ts`
7. [ ] Run tests: `npm test`
8. [ ] Build extension: `npm run build`

---

## Testing Strategy

Each phase must pass before proceeding:

1. **Unit tests**: `npm test` must pass (currently 79+ tests)
2. **Build check**: `npm run build` must complete without errors
3. **Type check**: `npx tsc --noEmit` should report fewer errors after each phase
4. **E2E verification**: After Phase 4, verify network fetch still works

**New tests to add**:
- Type guard tests in `packages/core/src/types/guards.test.ts`
- Validator tests in `packages/core/src/types/validators.test.ts`

---

## Files Summary

### High Priority (modify first)
- `packages/core/src/types/holochain-types.ts` - DONE
- `packages/core/src/ribosome/host-fn/get.ts` - DONE
- `packages/core/src/ribosome/host-fn/create.ts` - DONE
- `packages/core/src/ribosome/host-fn/update.ts` - DONE
- `packages/core/src/ribosome/host-fn/delete.ts` - DONE
- `packages/extension/src/lib/messaging.ts`
- `packages/core/src/network/sync-xhr-service.ts`

### Medium Priority
- `packages/core/src/ribosome/host-fn/query.ts`
- `packages/core/src/ribosome/host-fn/get_links.ts`
- `packages/core/src/network/cascade.ts`
- `packages/extension/src/background/index.ts`

### Lower Priority (consolidation)
- `packages/extension/src/inject/index.ts`
- `packages/extension/src/content/index.ts`
- `packages/extension/src/offscreen/index.ts`

---

## Success Criteria

1. No `as any` casts in host function files
2. All message payloads typed (no `payload: any`)
3. Network response parsing uses validated types
4. All existing tests pass
5. TypeScript strict mode reports fewer errors
6. E2E network fetch continues to work

---

## Estimated Effort

- Phase 1: 2-3 hours (foundational types) - COMPLETE
- Phase 2: 3-4 hours (host functions - most work) - IN PROGRESS
- Phase 3: 2-3 hours (API boundaries)
- Phase 4: 2-3 hours (network/storage)
- Phase 5: 1-2 hours (validators)
- Phase 6: 1 hour (consolidation)

**Total**: ~12-16 hours of focused work (2-3 days)
