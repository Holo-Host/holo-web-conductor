# Step 5.5: HDK Test Zome for Integration Testing

## Overview

Create a real Holochain HDK-compiled test zome to properly validate the WASM ribosome implementation from Step 5.

## Rationale

Step 5 implemented 20 host functions and the ribosome infrastructure, but the manual test page only installs a mock hApp with minimal WASM that doesn't actually call any host functions. To properly validate Step 5 before moving to Step 6, we need:

1. **Real HDK-compiled WASM** - Ensures compatibility with actual Holochain zomes
2. **Host function calls** - Verifies host functions work when called from WASM
3. **Serialization testing** - Tests MessagePack round-trip with real HDK types
4. **Integration validation** - Confirms the full flow: web page → extension → ribosome → WASM → host functions → results back to page

## Goals

1. Create minimal Rust HDK test zome
2. Compile to `wasm32-unknown-unknown` target
3. Test at least 5 host function categories:
   - Info functions (`agent_info`)
   - Utility functions (`random_bytes`, `sys_time`, `trace`)
   - Signing functions (`sign_ephemeral`, `verify_signature`)
   - CRUD functions (`create`, `get`) - will return mock data
4. Update manual test page to call zome functions
5. Verify results in browser

## Implementation Plan

### Phase 1: HDK Test Zome Setup

**Create package structure**:
```
packages/test-zome/
├── Cargo.toml
├── .cargo/
│   └── config.toml
├── src/
│   └── lib.rs
├── build.sh
└── README.md
```

**Dependencies** (`Cargo.toml`):
- `hdk = "0.4"` (or latest stable)
- `serde = "1"`

**Cargo config** (`.cargo/config.toml`):
```toml
[build]
target = "wasm32-unknown-unknown"
```

**Build script** (`build.sh`):
- Runs `cargo build --release --target wasm32-unknown-unknown`
- Copies WASM from `target/wasm32-unknown-unknown/release/test_zome.wasm`
- Copies to `../extension/test/test-zome.wasm` for use in test page

### Phase 2: Test Zome Implementation

**Zome functions to implement**:

1. **`get_agent_info() -> AgentInfo`**
   - Calls `agent_info()` host function
   - Returns agent pub key and chain head
   - Tests: Info host functions, serialization of complex types

2. **`get_random_bytes() -> Vec<u8>`**
   - Calls `random_bytes(32)`
   - Returns 32 random bytes
   - Tests: Utility host functions, binary data serialization

3. **`get_timestamp() -> Timestamp`**
   - Calls `sys_time()`
   - Returns current timestamp
   - Tests: Utility host functions, timestamp serialization

4. **`trace_message(msg: String) -> ()`**
   - Calls `trace(msg)`
   - Logs message to console
   - Tests: Utility host functions, string handling

5. **`test_signing() -> bool`**
   - Generates test data
   - Calls `sign_ephemeral(data)`
   - Calls `verify_signature(pub_key, data, signature)`
   - Returns verification result
   - Tests: Signing host functions, cryptographic operations

6. **`create_test_entry() -> ActionHash`**
   - Creates a simple entry with `create()`
   - Returns action hash
   - Tests: CRUD host functions (mock implementation)

7. **`get_test_entry(hash: ActionHash) -> Option<Record>`**
   - Calls `get(hash)`
   - Returns record if found
   - Tests: CRUD host functions (mock implementation)

**Entry types**:
```rust
#[hdk_entry_helper]
struct TestEntry {
    content: String,
    timestamp: Timestamp,
}
```

### Phase 3: Browser Test Page Updates

**Update `wasm-test.html`**:

1. Load compiled `test-zome.wasm` instead of minimal WASM
2. After hApp installation, add section "5. Zome Function Tests"
3. Add buttons for each test function:
   - "Get Agent Info" → calls `get_agent_info()`
   - "Get Random Bytes" → calls `get_random_bytes()`
   - "Get Timestamp" → calls `get_timestamp()`
   - "Trace Message" → calls `trace_message("Hello from zome!")`
   - "Test Signing" → calls `test_signing()`
   - "Create Entry" → calls `create_test_entry()`
   - "Get Entry" → calls `get_test_entry(hash)` with hash from create
4. Display results for each call
5. Update manual testing checklist

**Expected results**:
- Agent info returns valid pub key (from context)
- Random bytes are 32 bytes and unique each call
- Timestamp is reasonable (close to current time)
- Trace message appears in background console
- Signing returns `true` (signature verifies)
- Create returns 32-byte action hash
- Get returns mock record with entry

### Phase 4: Testing & Validation

**Manual testing checklist**:
```
□ Extension loads without errors
□ Test page connects successfully
□ hApp installs with test zome WASM
□ "Get Agent Info" returns agent pub key matching context
□ "Get Random Bytes" returns 32 unique bytes
□ "Get Timestamp" returns current time (within 1 second)
□ "Trace Message" logs to background console as: [TRACE][test_zome] Hello from zome!
□ "Test Signing" returns true (signature verifies)
□ "Create Entry" returns 32-byte action hash
□ "Get Entry" returns mock record (Step 5 mock implementation)
□ Background console shows host function calls
□ No errors in console
```

## Files to Create

1. **`packages/test-zome/Cargo.toml`** (~20 lines)
2. **`packages/test-zome/.cargo/config.toml`** (~3 lines)
3. **`packages/test-zome/src/lib.rs`** (~200 lines)
4. **`packages/test-zome/build.sh`** (~10 lines)
5. **`packages/test-zome/README.md`** (~30 lines)

## Files to Modify

1. **`packages/extension/test/wasm-test.html`** - Add zome function test section
2. **`SESSION.md`** - Add Step 5.5 completion notes
3. **`claude.md`** - Add Step 5.5 with ✓

## Dependencies

- Rust toolchain with `wasm32-unknown-unknown` target
- HDK crate (latest stable version)
- `wasm-opt` (optional, for optimization)

**Install if needed**:
```bash
rustup target add wasm32-unknown-unknown
```

## Success Criteria

- [ ] Test zome compiles without errors
- [ ] WASM size is reasonable (<100 KB for minimal zome)
- [ ] All 7 zome functions work in browser
- [ ] Host functions are called and return expected data
- [ ] Results serialize/deserialize correctly
- [ ] Background console shows host function activity
- [ ] No errors in browser console

## Known Limitations

**Step 5 mock implementations**:
- CRUD operations (`create`, `get`) return mock data
- Links are not tested (also mock in Step 5)
- `sign()` uses mock signatures (not Lair)
- `hash()` uses placeholder algorithm

These will be addressed in Step 6 when real persistence is added.

## Future Enhancements (Post-Step 5.5)

- Add link tests when Step 6 implements real link storage
- Add query tests with real chain data
- Add multi-zome tests
- Add validation tests
- Add signal tests

## Integration with Existing Work

**Builds on**:
- Step 5 ribosome implementation (20 host functions)
- Step 4 hApp context (agent keys, DNA storage)
- Step 2 Lair (signing operations)

**Prepares for**:
- Step 6 real source chain storage
- Step 7+ network operations
- Step 9 full hApp integration testing

## Estimated Duration

**2-3 hours**:
- 30 min: Rust project setup
- 60 min: Test zome implementation
- 30 min: Browser test page updates
- 30 min: Testing and debugging
- 30 min: Documentation

## Notes

- Keep test zome minimal - only test essential host functions
- Focus on validation, not comprehensive testing
- Use simple entry types (String-based)
- Don't over-engineer - this is a stepping stone to Step 6
