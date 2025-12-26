# Step 5: WASM Execution with Mocked Host Functions - Implementation Plan

## Overview

Implement a browser-based WASM runtime that can load and execute Holochain hApp WASM modules with mocked host functions. This step bridges the gap between hApp context storage (Step 4) and real source chain operations (Step 6).

**Strategy**: Start with minimal viable WASM execution, implement Priority 1 host functions with mock data, then progressively add real implementations.

## Architecture Decisions

### 1. WASM Runtime: Browser-Native WebAssembly API

**Decision**: Use native `WebAssembly.instantiate()` - NO external libraries (wasmer-js, etc.)

**Rationale**:
- Browser WebAssembly API is mature and performant
- Zero-arc nodes don't need wasmer's advanced features
- Smaller bundle size for extension
- Direct memory sharing via `WebAssembly.Memory`

### 2. Package Structure: New `packages/core/ribosome/` Directory

**Location**: `packages/core/src/ribosome/`

**Structure**:
```
packages/core/src/ribosome/
├── index.ts                    # Main exports
├── runtime.ts                  # WASM runtime & instance management
├── call-context.ts             # Call context & invocation state
├── serialization.ts            # MessagePack serialization utilities
├── host-fn/                    # Host function implementations
│   ├── index.ts                # Host function registry
│   ├── agent_info.ts           # Priority 1: Info functions
│   ├── dna_info.ts
│   ├── zome_info.ts
│   ├── call_info.ts
│   ├── create.ts               # Priority 1: CRUD operations
│   ├── get.ts
│   ├── update.ts
│   ├── delete.ts
│   ├── query.ts
│   ├── create_link.ts          # Priority 1: Link operations
│   ├── get_links.ts
│   ├── delete_link.ts
│   ├── count_links.ts
│   ├── sign.ts                 # Priority 1: Signing (delegates to Lair)
│   ├── sign_ephemeral.ts
│   ├── verify_signature.ts
│   ├── random_bytes.ts         # Priority 1: Utilities
│   ├── sys_time.ts
│   ├── trace.ts
│   └── hash.ts
└── test/
    └── minimal-zome.wat        # Minimal test WASM (WebAssembly Text Format)
```

### 3. Host Function Interface: ImportObject with "env" Namespace

**Pattern**: Holochain uses `__hc__*` naming convention

**Calling Convention**:
- All host functions take single `ptr: number` parameter (pointer to serialized input)
- Return `i64` where:
  - High 32 bits: pointer to result data
  - Low 32 bits: length of result data
- Data serialized as MessagePack (SerializedBytes)

### 4. Memory Management: WASM-Provided Allocator

**Decision**: Use WASM module's exported `__hc__allocate_1()` and `__hc__deallocate_1()`

**Flow**:
1. Host function receives pointer to input (already allocated by WASM)
2. Host function deserializes input from WASM memory
3. Host function processes request
4. Host function serializes result
5. Host function calls WASM's `__hc__allocate_1(len)` to get buffer
6. Host function writes serialized data to buffer
7. Host function returns pointer + length as i64

### 5. Serialization: MessagePack (via @msgpack/msgpack)

**Library**: `@msgpack/msgpack`

### 6. Module Caching: Per-Context Compilation

**Strategy**:
- Compile WASM once per hApp context (stored as `WebAssembly.Module`)
- Create instances on-demand for each zome call
- In-memory Map in `RibosomeRuntime` class

### 7. Error Handling: Result<T, E> Pattern

**Error Types**:
```typescript
export enum RibosomeErrorType {
  WasmCompilationFailed = "WasmCompilationFailed",
  WasmInstantiationFailed = "WasmInstantiationFailed",
  ZomeFunctionNotFound = "ZomeFunctionNotFound",
  HostFunctionError = "HostFunctionError",
  SerializationError = "SerializationError",
  DeserializationError = "DeserializationError",
}
```

## Implementation Phases

### Phase 1: Foundation - WASM Runtime Core

**Goal**: Load WASM modules and call basic functions (no host functions yet)

**Tasks**:
1. Create `packages/core/src/ribosome/runtime.ts`
2. Implement `RibosomeRuntime` class:
   - `compileModule(wasm: Uint8Array): WebAssembly.Module`
   - `instantiateModule(module: Module, imports: ImportObject): Instance`
   - Module caching by DNA hash
3. Create `packages/core/src/ribosome/call-context.ts`
4. Create minimal test WASM (`test/minimal-zome.wat`)
5. Write tests for WASM loading and basic function calls

**Files Created**:
- `packages/core/src/ribosome/runtime.ts` (~250 lines)
- `packages/core/src/ribosome/call-context.ts` (~100 lines)
- `packages/core/src/ribosome/test/minimal-zome.wat` (~50 lines)
- `packages/core/src/ribosome/runtime.test.ts` (~150 lines)

**Success Criteria**:
- Can compile WASM from bytes
- Can instantiate module
- Can call exported WASM function
- Tests pass

---

### Phase 2: Memory & Serialization

**Goal**: Implement memory management and MessagePack serialization

**Tasks**:
1. Add `@msgpack/msgpack` dependency to `packages/core/package.json`
2. Create `packages/core/src/ribosome/serialization.ts`:
   - `serializeToWasm(instance, data): { ptr: number, len: number }`
   - `deserializeFromWasm(instance, ptr, len): any`
   - Helper functions for reading/writing WASM memory
3. Create enhanced test WASM with allocator (`test/allocator-zome.wat`)
4. Write serialization tests (round-trip encoding/decoding)

**Files Created**:
- `packages/core/src/ribosome/serialization.ts` (~200 lines)
- `packages/core/src/ribosome/test/allocator-zome.wat` (~100 lines)
- `packages/core/src/ribosome/serialization.test.ts` (~100 lines)

**Success Criteria**:
- Can serialize JS objects to MessagePack bytes
- Can write bytes to WASM memory
- Can read bytes from WASM memory
- Can deserialize MessagePack back to JS objects
- Tests verify round-trip correctness

---

### Phase 3: Host Function Infrastructure

**Goal**: Create host function registry and base implementation patterns

**Tasks**:
1. Create `packages/core/src/ribosome/host-fn/index.ts`:
   - `HostFunctionRegistry` class
   - `registerHostFunction(name, impl)` method
   - `buildImportObject(): ImportObject` generator
2. Create base host function pattern (`host-fn/base.ts`):
   - `HostFunctionContext` interface
   - `HostFunctionImpl` type signature
   - Error handling wrapper
3. Create `packages/core/src/ribosome/index.ts`:
   - Main ribosome exports
   - `callZome(context, request): Promise<any>` entry point
4. Wire up to existing `handleCallZome` in background worker

**Files Created**:
- `packages/core/src/ribosome/host-fn/index.ts` (~150 lines)
- `packages/core/src/ribosome/host-fn/base.ts` (~100 lines)
- `packages/core/src/ribosome/index.ts` (~100 lines)

**Files Modified**:
- `packages/extension/src/background/index.ts`:
  - Replace mock `handleCallZome` with actual ribosome integration

**Success Criteria**:
- Can register host functions
- Can build import object
- Host functions callable from WASM
- Background handler routes to ribosome

---

### Phase 4: Priority 1 Host Functions - Info

**Goal**: Implement info host functions with mock data

**Functions**: `agent_info`, `dna_info`, `zome_info`, `call_info`

**Tasks**:
1. Implement `host-fn/agent_info.ts`:
   - Return agent pub key from hApp context
   - Mock chain head data
2. Implement `host-fn/dna_info.ts`:
   - Return DNA hash from cell ID
   - Mock DNA properties, modifiers, zomes list
3. Implement `host-fn/zome_info.ts`:
   - Return current zome name from call context
4. Implement `host-fn/call_info.ts`:
   - Return provenance from call context

**Files Created**:
- `packages/core/src/ribosome/host-fn/agent_info.ts` (~80 lines)
- `packages/core/src/ribosome/host-fn/dna_info.ts` (~80 lines)
- `packages/core/src/ribosome/host-fn/zome_info.ts` (~60 lines)
- `packages/core/src/ribosome/host-fn/call_info.ts` (~60 lines)

**Success Criteria**:
- All 4 info functions implemented
- Return correct mock data structures
- Tests verify structure and values
- Can be called from test WASM

---

### Phase 5: Priority 1 Host Functions - Utilities

**Goal**: Implement utility host functions

**Functions**: `random_bytes`, `sys_time`, `trace`, `hash`

**Tasks**:
1. Implement `host-fn/random_bytes.ts`:
   - Use `crypto.getRandomValues()`
2. Implement `host-fn/sys_time.ts`:
   - Return current time as microseconds since UNIX epoch
3. Implement `host-fn/trace.ts`:
   - Log trace message to console
   - Format: `[TRACE][zome_name] message`
4. Implement `host-fn/hash.ts`:
   - Use Web Crypto API `crypto.subtle.digest('SHA-256', data)`

**Files Created**:
- `packages/core/src/ribosome/host-fn/random_bytes.ts` (~50 lines)
- `packages/core/src/ribosome/host-fn/sys_time.ts` (~40 lines)
- `packages/core/src/ribosome/host-fn/trace.ts` (~60 lines)
- `packages/core/src/ribosome/host-fn/hash.ts` (~50 lines)

**Success Criteria**:
- `random_bytes` returns cryptographically secure random data
- `sys_time` returns current time in microseconds
- `trace` logs to console with correct format
- `hash` produces correct SHA-256 hashes

---

### Phase 6: Priority 1 Host Functions - Signing

**Goal**: Integrate Lair for signing operations

**Functions**: `sign`, `sign_ephemeral`, `verify_signature`

**Tasks**:
1. Implement `host-fn/sign.ts`:
   - Get Lair client (must be unlocked)
   - Call `lairClient.signByPubKey(agentPubKey, data)`
   - Return 64-byte Ed25519 signature
2. Implement `host-fn/sign_ephemeral.ts`:
   - Generate ephemeral keypair (not stored)
   - Sign data with ephemeral key
3. Implement `host-fn/verify_signature.ts`:
   - Use libsodium `crypto_sign_verify_detached()`
   - Return boolean result

**Files Created**:
- `packages/core/src/ribosome/host-fn/sign.ts` (~80 lines)
- `packages/core/src/ribosome/host-fn/sign_ephemeral.ts` (~100 lines)
- `packages/core/src/ribosome/host-fn/verify_signature.ts` (~60 lines)

**Dependencies**:
- Add `@fishy/lair` to `@fishy/core` dependencies
- Add `libsodium-wrappers` to `@fishy/core` dependencies

**Success Criteria**:
- `sign` delegates to Lair correctly
- Signatures verify with libsodium
- Ephemeral signing works without Lair
- Error handling for locked Lair

---

### Phase 7: Priority 1 Host Functions - CRUD (Mock)

**Goal**: Implement CRUD operations with mock data

**Functions**: `create`, `get`, `update`, `delete`, `query`

**Mock Strategy**: Return canned data, don't persist anything (Step 6 adds persistence)

**Tasks**:
1. Implement `host-fn/create.ts`:
   - Generate mock action hash (random 32 bytes)
   - Return `ActionHash`
2. Implement `host-fn/get.ts`:
   - Return mock record with dummy entry + action
   - Return `None` if mock data says "not found"
3. Implement `host-fn/update.ts`:
   - Return new action hash
4. Implement `host-fn/delete.ts`:
   - Return delete action hash
5. Implement `host-fn/query.ts`:
   - Return empty array or mock records based on filter

**Files Created**:
- `packages/core/src/ribosome/host-fn/create.ts` (~100 lines)
- `packages/core/src/ribosome/host-fn/get.ts` (~100 lines)
- `packages/core/src/ribosome/host-fn/update.ts` (~80 lines)
- `packages/core/src/ribosome/host-fn/delete.ts` (~60 lines)
- `packages/core/src/ribosome/host-fn/query.ts` (~120 lines)

**Success Criteria**:
- CRUD operations return correct data structures
- Mock data is plausible
- Serialization/deserialization works
- Ready to swap for real implementation in Step 6

---

### Phase 8: Priority 1 Host Functions - Links (Mock)

**Goal**: Implement link operations with mock data

**Functions**: `create_link`, `get_links`, `delete_link`, `count_links`

**Tasks**:
1. Implement `host-fn/create_link.ts`:
   - Return mock action hash
2. Implement `host-fn/get_links.ts`:
   - Return empty array or mock link records
3. Implement `host-fn/delete_link.ts`:
   - Return delete action hash
4. Implement `host-fn/count_links.ts`:
   - Return 0 or small mock count

**Files Created**:
- `packages/core/src/ribosome/host-fn/create_link.ts` (~80 lines)
- `packages/core/src/ribosome/host-fn/get_links.ts` (~100 lines)
- `packages/core/src/ribosome/host-fn/delete_link.ts` (~60 lines)
- `packages/core/src/ribosome/host-fn/count_links.ts` (~50 lines)

**Success Criteria**:
- Link operations return correct structures
- Ready for real implementation in Step 6

---

### Phase 9: Integration & Testing

**Goal**: End-to-end testing with real Holochain WASM

**Tasks**:
1. Acquire minimal Holochain test WASM:
   - Option A: Compile simple zome with HDK
   - Option B: Use existing test WASM from Holochain repo
2. Create comprehensive test suite
3. Create test webpage (`packages/extension/test/wasm-test.html`)
4. Manual browser testing
5. Fix discovered issues
6. Update documentation

**Files Created**:
- `packages/extension/test/wasm-test.html` (~300 lines)
- `packages/extension/test/test-zome.wasm` (compiled from HDK)

**Files Modified**:
- `claude.md` - mark Step 5 complete
- `SESSION.md` - update with implementation notes

**Success Criteria**:
- Real Holochain WASM loads successfully
- Zome functions execute without errors
- Host functions return expected data
- Results propagate back to web page
- Manual testing passes all scenarios

---

## Critical Files (Implementation Order)

### Phase 1-3 (Foundation):
1. `packages/core/src/ribosome/runtime.ts` - Core WASM loading and instance management
2. `packages/core/src/ribosome/serialization.ts` - MessagePack encode/decode + WASM memory helpers
3. `packages/core/src/ribosome/host-fn/index.ts` - Host function registry and import object builder

### Phase 4-8 (Host Functions):
4. `packages/core/src/ribosome/host-fn/agent_info.ts` - First info function, pattern for others
5. `packages/core/src/ribosome/host-fn/sign.ts` - Lair integration for signing
6. `packages/core/src/ribosome/host-fn/create.ts` - First CRUD operation, pattern for others

### Integration:
7. `packages/core/src/ribosome/index.ts` - Main ribosome exports and `callZome()` entry point
8. `packages/extension/src/background/index.ts` - Integration with message handler

### Testing:
9. `packages/extension/test/wasm-test.html` - Manual testing interface

---

## Testing Strategy

### Unit Tests (~22+ tests)

**Storage Tests** (runtime, serialization):
- Compile WASM from bytes
- Instantiate module
- Call exported functions
- Serialize/deserialize round-trip
- Memory read/write operations

**Host Function Tests** (~18 tests, one per function):
- Each function returns correct structure
- Mock data is valid
- Error handling works

### Integration Tests (WASM Execution)
- Load and instantiate WASM module
- Call zome function that invokes host function
- Verify result returned to caller
- Verify result propagated to web page

### Manual Testing Checklist
```
□ Extension loads without errors
□ Test page can install hApp
□ agent_info returns correct data
□ dna_info returns DNA hash
□ sign produces valid signature
□ random_bytes returns unique data
□ sys_time returns reasonable timestamp
□ create returns action hash
□ get returns mock record
□ get_links returns empty array
□ trace logs to console
□ Error handling works (locked Lair, missing DNA, etc.)
```

---

## Mock Data Specifications

### Info Functions

**agent_info**:
```typescript
{
  agent_initial_pubkey: Uint8Array(32), // From hApp context
  agent_latest_pubkey: Uint8Array(32),  // Same as initial for now
  chain_head: {
    action: Uint8Array(32),             // All zeros (genesis)
    sequence: 0,                        // Genesis sequence
    timestamp: Date.now() * 1000        // Current time in μs
  }
}
```

**dna_info**:
```typescript
{
  hash: Uint8Array(32),                 // From cell ID
  name: "mock_dna",
  properties: {},
  zome_names: ["mock_zome"],            // From call context
  modifiers: {
    network_seed: "",
    properties: {},
    origin_time: Date.now() * 1000
  }
}
```

### CRUD Operations

**create** returns:
```typescript
Uint8Array(32) // Random action hash
```

**get** returns:
```typescript
{
  signed_action: {
    hashed: {
      content: {
        type: "Create",
        author: Uint8Array(32),         // Agent pub key
        timestamp: Date.now() * 1000,
        action_seq: 0,
        prev_action: null,
        entry_type: { App: { id: 0, zome_id: 0, visibility: "Public" } },
        entry_hash: Uint8Array(32)
      },
      hash: Uint8Array(32)
    },
    signature: Uint8Array(64)
  },
  entry: {
    Present: {
      entry_type: "App",
      entry: Uint8Array([])             // Empty entry
    }
  }
}
```

### Link Operations

**get_links** returns:
```typescript
[]  // Empty array (no links yet)
```

---

## Integration with Existing Systems

### With Authorization (Step 3):
- Permission check happens before zome call
- Context required: zome call fails if not authorized

### With Lair Keystore (Step 2):
- Sign operations delegate to Lair
- Error if Lair is locked
- Verify operations use libsodium (public, no Lair unlock required)

### With hApp Context (Step 4):
- Get DNA WASM from context storage
- Get agent pub key for signing
- Track last used timestamp

---

## Success Criteria (Definition of Done)

### Technical Requirements

- [ ] Can compile WASM from Uint8Array
- [ ] Can instantiate WASM with host function imports
- [ ] Can call WASM functions and receive results
- [ ] MessagePack serialization works bidirectionally
- [ ] All 18 Priority 1 host functions implemented:
  - [ ] 4 info functions (agent_info, dna_info, zome_info, call_info)
  - [ ] 4 utility functions (random_bytes, sys_time, trace, hash)
  - [ ] 3 signing functions (sign, sign_ephemeral, verify_signature)
  - [ ] 5 CRUD functions (create, get, update, delete, query)
  - [ ] 4 link functions (create_link, get_links, delete_link, count_links)
- [ ] Signing integrates with Lair
- [ ] Background handler routes CALL_ZOME to ribosome
- [ ] Errors propagate correctly to web page
- [ ] Module caching reduces compilation overhead

### Testing Requirements

- [ ] Unit tests pass for all host functions
- [ ] Integration tests pass for WASM execution
- [ ] Manual testing completes successfully
- [ ] Test coverage >80% for host functions
- [ ] Test coverage >90% for runtime core

### Documentation Requirements

- [ ] All host functions have JSDoc comments
- [ ] README explains ribosome architecture
- [ ] Examples show how to call zome functions
- [ ] SESSION.md updated with implementation notes
- [ ] claude.md marked Step 5 complete

### User Experience Requirements

- [ ] Zome calls return results within 1 second
- [ ] Error messages are clear and actionable
- [ ] Console logging aids debugging
- [ ] Test page demonstrates all features

---

## Future Enhancements (Post-Step 5)

### Step 6 Integration Points

**What Step 5 Defers**:
- Real source chain storage (CRUD currently returns mock data)
- Real link storage (link ops currently return mocks)
- Action hashing (currently random)
- Entry hashing (currently random)
- Chain head tracking

**Migration Path**:
1. Replace mock CRUD implementations with chain storage calls
2. Replace mock link implementations with link storage
3. Implement real hashing (Blake2b)
4. Add chain validation
5. Persist records to IndexedDB

**No Breaking Changes**: API contracts remain the same, just swap implementations

### Priority 2 Host Functions (Future Steps)

**Crypto Functions** (Step 6 or 7):
- `create_x25519_keypair`
- `x25519_encrypt`
- `x25519_decrypt`

**DHT Must-Get** (Step 8 - requires network):
- `must_get_action`
- `must_get_entry`
- `must_get_valid_record`
- `get_agent_activity`

**Advanced Features** (Step 8+):
- `call` - cross-zome/cross-cell calls
- `emit_signal` - send signals to UI
- `send_remote_signal` - network signals
- Clone cell operations
- Capability grants

---

## Dependencies & Package Updates

### New Dependencies

**@fishy/core**:
```json
{
  "dependencies": {
    "@msgpack/msgpack": "^3.0.0",
    "@fishy/lair": "*",
    "libsodium-wrappers": "^0.7.13"
  },
  "devDependencies": {
    "@types/libsodium-wrappers": "^0.7.14"
  }
}
```

---

## Implementation Timeline

**Estimated Duration**: 10-12 working days

**Breakdown**:
- Phase 1 (Foundation): 1-2 days
- Phase 2 (Serialization): 1 day
- Phase 3 (Infrastructure): 1 day
- Phase 4 (Info Functions): 1 day
- Phase 5 (Utilities): 1 day
- Phase 6 (Signing): 1 day
- Phase 7 (CRUD): 2-3 days
- Phase 8 (Links): 1 day
- Phase 9 (Testing): 2-3 days

**Milestones**:
- Day 3: WASM loading works
- Day 5: First host function callable
- Day 7: All info + utility functions work
- Day 9: CRUD operations return mock data
- Day 12: End-to-end testing complete
