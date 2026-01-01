# Fishy Testing Guide

This document covers testing procedures for the Fishy browser extension, including unit tests, integration tests, and end-to-end tests that require manual setup.

## Quick Reference

| Test Type | Command | Requirements |
|-----------|---------|--------------|
| Unit tests | `npm test` | None |
| Build validation | `npm run build` | None |
| E2E with gateway | See below | nix, Holochain conductor, gateway |

---

## Unit Tests

Run all unit tests:

```bash
npm test
```

This runs Vitest tests across all packages:
- `packages/core` - Ribosome, storage, network layer tests
- `packages/lair` - Key management tests
- `packages/extension` - Messaging, permissions tests

---

## Integration Tests

### Automated Integration Tests

The automated integration tests simulate the web-page → extension → WASM flow without requiring a browser:

```bash
npm run test:integration
```

See `packages/core/src/integration/` for test files.

---

## End-to-End Tests with Gateway

These tests verify the full flow: browser extension → hc-http-gw → Holochain conductor.

### Prerequisites

The `holochain` and `hc` binaries must be available. Use the nix shell from hc-http-gw-fork:

```bash
cd ../hc-http-gw-fork
nix develop  # This provides holochain 0.6 and hc tools
```

### Setup Steps

1. **Build extension and fixture hApp** (in nix shell):
   ```bash
   # In fishy directory
   npm run build

   # In hc-http-gw-fork/fixture directory
   cd ../hc-http-gw-fork/fixture
   RUSTFLAGS='--cfg getrandom_backend="custom"' cargo build --release --target wasm32-unknown-unknown
   ./package.sh
   ```

2. **Start conductor with fixture hApp** (in nix shell):
   ```bash
   # Create a temp directory for sandbox
   mkdir -p /tmp/fishy-e2e && cd /tmp/fishy-e2e

   # Generate and run sandbox with fixture
   hc sandbox generate \
     --in-process-lair \
     --run 0 \
     --app-id fixture1 \
     ~/code/metacurrency/holochain/hc-http-gw-fork/fixture/package/happ1/fixture1.happ

   # Note the admin port from the output (look for "Admin port set to: XXXX")
   ```

3. **Start gateway** (in another terminal, also in nix shell):
   ```bash
   cd ~/code/metacurrency/holochain/hc-http-gw-fork
   nix develop

   # Replace ADMIN_PORT with the port from step 2
   HC_GW_ADMIN_WS_URL="ws://localhost:ADMIN_PORT" \
   HC_GW_PORT=8090 \
   HC_GW_ALLOWED_APP_IDS="fixture1" \
   HC_GW_ALLOWED_FNS_fixture1="*" \
   cargo run --release
   ```

4. **Load extension in Chrome**:
   - Open `chrome://extensions`
   - Enable Developer mode
   - Click "Load unpacked"
   - Select `packages/extension/dist`

5. **Open test page**:
   ```
   file:///path/to/fishy/packages/extension/test/e2e-gateway-test.html
   ```

6. **Run tests**:
   - Click "Configure Extension" with gateway URL (default: http://localhost:8090)
   - Click "Connect to Extension"
   - If hApp not installed, select fixture1.happ and click "Install hApp"
   - Test operations:
     - **Create Entry** - Creates an entry via coordinator1::create_1
     - **Get Links** - Fetches links showing action hashes (copy these for Get Record)
     - **Get Record** - Fetches a record by hash via dht_util::dht_get_record
     - **Get All** - Fetches all entries via coordinator1::get_all_1

### Test Page Features

- **Auto-detect**: Automatically detects existing hApp installation after connect
- **Timing**: Shows millisecond timing for all operations
- **Hash encoding**: Displays hashes as base64 strings (uhCkk...) for readability
- **Copy-paste**: Get Links results include `_targetHash_copyForGetRecord` for easy testing

### Troubleshooting

**"holochain not found"**: Make sure you're in the nix shell (`nix develop` in hc-http-gw-fork)

**"Admin port set to: 0"**: The actual port is assigned dynamically. Look for "Admin Interfaces: XXXX" in the output.

**"cellId[0].slice is not a function"**: This was fixed - hashes are now properly converted from Chrome's serialized format.

**Deserialization errors**: Make sure payloads with hashes pass decoded bytes, not base64 strings.

---

## Running Gateway Integration Tests

The hc-http-gw-fork has its own integration tests for the DHT endpoints:

```bash
cd ../hc-http-gw-fork

# Build fixture WASMs first
cd fixture
RUSTFLAGS='--cfg getrandom_backend="custom"' cargo build --release --target wasm32-unknown-unknown
./package.sh
cd ..

# Run tests (must be serial due to init() conflicts)
cargo test --test dht -- --test-threads=1
```

These tests verify:
- `dht_get_record_found` - Creates entry and fetches it
- `dht_get_record_not_found` - Verifies null for non-existent hash
- `dht_get_links_empty` - Verifies empty array response
- `dht_count_links_zero` - Verifies zero count
