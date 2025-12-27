# Test Zome

Minimal HDK test zome for validating Step 5 ribosome implementation.

## Purpose

This zome tests the Fishy ribosome by calling real host functions from WASM:
- `agent_info` - Get agent public key and chain head
- `random_bytes` - Generate cryptographically secure random data
- `sys_time` - Get current system timestamp
- `trace` - Log messages to console
- `sign_ephemeral` / `verify_signature` - Cryptographic signing
- `create` / `get` - CRUD operations (Step 5 mocks, Step 6 adds persistence)

## Building

```bash
# Ensure wasm32 target is installed
rustup target add wasm32-unknown-unknown

# Build the zome
./build.sh
```

This compiles to WASM and copies to `../extension/test/test-zome.wasm`.

## Testing

Open `../extension/test/wasm-test.html` in a browser with the Fishy extension loaded.

## Functions

### `get_agent_info() -> AgentInfo`
Tests the `agent_info` host function. Returns agent public key and chain head.

### `get_random_bytes() -> Vec<u8>`
Tests the `random_bytes` host function. Returns 32 random bytes.

### `get_timestamp() -> Timestamp`
Tests the `sys_time` host function. Returns current timestamp in microseconds.

### `trace_message(msg: String) -> ()`
Tests the `trace` host function. Logs message to background console.

### `test_signing() -> bool`
Tests `sign_ephemeral` and `verify_signature` host functions. Returns true if signature verifies.

### `create_test_entry(content: String) -> ActionHash`
Tests the `create` host function. Creates a test entry and returns action hash.

### `get_test_entry(hash: ActionHash) -> Option<Record>`
Tests the `get` host function. Retrieves a record by hash.

## Notes

- Uses HDK 0.6
- CRUD operations return mock data in Step 5
- Step 6 will add real source chain persistence
