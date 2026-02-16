# Fishy Testing Guide

This document covers testing procedures for the Fishy browser extension, including unit tests, integration tests, automated end-to-end tests, and manual test pages.

## Quick Reference

| Test Type | Command | Requirements |
|-----------|---------|--------------|
| Unit tests (vitest) | `npm test` | None |
| Build validation | `npm run build` | None |
| Type checking | `npm run build --workspace=@fishy/core` | None (uses tsc) |
| Integration tests | `npm run test:integration` | None |
| E2E (Playwright) | See "E2E with Gateway" section | nix shell, conductor, gateway |
| Manual browser tests | See "Manual Test Pages" section | Extension loaded in Chrome |

---

## Unit Tests

Run all unit tests:

```bash
npm test
```

This runs Vitest tests across all packages:
- `packages/core` - 18 test files (~209 tests): Ribosome, storage, network layer
- `packages/extension` - 9 test files (~96 tests): Messaging, permissions, service worker
- `packages/client` - 5 test files (~97 tests): FishyAppClient, connection monitoring
- `packages/lair` - 1 test file (~25 tests): Key management
- `packages/shared` - 1 test file: Shared utilities

**Important**: Vitest uses esbuild, not tsc, so TypeScript type errors are NOT caught by `npm test`. Run `tsc` separately via `npm run build --workspace=@fishy/core` to check types.

**Known issues**:
- Some tests need libsodium; may fail with "No secure random number generator found" when run in isolation
- e2e package has pre-existing build errors (missing @types/node) - not blocking unit tests

---

## Integration Tests

Run integration tests that simulate web-page → extension → WASM flow without a browser:

```bash
npm run test:integration
```

Test files in `packages/core/src/integration/`:
- `profiles-integration.test.ts` - Profile CRUD operations
- `serialization-fixtures.test.ts` - Cross-version serialization compatibility
- `publish-integration.test.ts` - DhtOp generation and publishing

---

## E2E Tests with Gateway

These tests verify the full flow: web page → browser extension → gateway → Holochain conductor network.

### Prerequisites

The `holochain`, `hc`, and `kitsune2-bootstrap-srv` binaries must be available. Run all commands in a nix shell:

```bash
nix develop -c bash
```

### Gateway

The project uses hc-membrane gateway which integrates directly with the kitsune2 network:

| Gateway | Repo | Mode |
|---------|------|------|
| `membrane` | `../hc-membrane` | Kitsune mode |

Set repo path with environment variable:
- `HC_MEMBRANE_DIR` - Path to hc-membrane repo (default: `../hc-membrane`)

### Test hApps

Two hApp fixtures are supported:

| hApp | App ID | Source | UI Server | Tests |
|------|--------|--------|-----------|-------|
| ziptest | `ziptest` | `fixtures/ziptest.happ` (committed binary) | `../ziptest/ui/dist` (port 8081) | Multi-agent sync |
| mewsfeed | `mewsfeed` | `fixtures/mewsfeed.happ` (committed binary) | `../mewsfeed-fishy/ui/dist` (port 8082) | Real-world hApp |

### Using e2e-test-setup.sh

The primary way to set up the E2E environment:

```bash
# Start with default hApp (ziptest)
./scripts/e2e-test-setup.sh start

# Start with specific hApp
./scripts/e2e-test-setup.sh start --happ=ziptest
./scripts/e2e-test-setup.sh start --happ=mewsfeed

# Other commands
./scripts/e2e-test-setup.sh stop     # Stop all services
./scripts/e2e-test-setup.sh pause    # Stop gateway only (for gateway development)
./scripts/e2e-test-setup.sh unpause  # Restart gateway
./scripts/e2e-test-setup.sh status   # Check what's running
./scripts/e2e-test-setup.sh clean    # Remove state files
```

**What it does**:
1. Starts local kitsune2-bootstrap-srv (saves port to `/tmp/fishy-e2e/bootstrap_addr.txt`)
2. Starts 2 conductors via `hc sandbox generate --in-process-lair --run 0` with QUIC transport
3. Waits for arc establishment (up to 90s, minimum 30s)
4. Starts hc-membrane gateway on port 8000
5. Starts UI server (ziptest: port 8081, mewsfeed: port 8082)
6. Initializes test data (saves dna_hash for selected hApp)

**State files** in `/tmp/fishy-e2e/`:
- `bootstrap_addr.txt` - Bootstrap server address
- `admin_port.txt`, `admin_port_2.txt` - Conductor admin ports
- `app_id.txt`, `happ_path.txt`, `dna_hash.txt` - hApp configuration
- PIDs and logs for all services

### Running Playwright Tests

The Playwright tests are in `packages/e2e/`:

| Test File | Description | Fixture |
|-----------|-------------|---------|
| `ziptest.test.ts` | Multi-agent: profiles, signal exchange, entry sync | ziptest |
| `mewsfeed.test.ts` | Multi-agent: profiles, mew posting, hashtag search | mewsfeed |

**To run tests**:

```bash
# 1. Start E2E environment (in nix shell)
nix develop -c bash
./scripts/e2e-test-setup.sh start --happ=ziptest

# 2. Build extension
npm run build

# 3. Run Playwright tests (from packages/e2e/)
cd packages/e2e
npx playwright test

# Or run specific test
npx playwright test ziptest.test.ts

# With UI (for debugging)
npx playwright test --ui
```

**Multi-agent architecture**:
- Each agent gets a separate Chromium context with its own user data directory
- Each context loads the extension independently (separate keypairs in IndexedDB)
- `setupAutoApproval()` intercepts authorization popups and auto-clicks approve
- Extension readiness detected via `window.holochain?.isFishy === true`

---

## Manual Test Pages

Interactive HTML test pages for developer debugging (not automated CI). Located in `packages/extension/test/`:

| File | Purpose | Gateway Required? | Key Features |
|------|---------|-------------------|--------------|
| `wasm-test.html` | 20+ host function tests: CRUD, links, signing, rollback | No | Self-contained, no network |
| `test-page.html` | Basic extension API: detect, connect, install, callZome, signals | No | Extension detection flow |
| `authorization-test.html` | Authorization flow and permission management | No | Permission revocation |
| `profiles-test.html` | Real hApp integration via FishyAppClient | Optional | Client library testing |

**How to use**:

```bash
# 1. Start E2E environment (for tests that need gateway)
nix develop -c bash
./scripts/e2e-test-setup.sh start

# 2. Build and load extension in Chrome
npm run build
# Open chrome://extensions, enable Developer mode, Load unpacked from packages/extension/dist

# 3. Serve test pages (need HTTP server for module imports)
cd packages/extension/test
python3 -m http.server 8080

# 4. Open test page
# http://localhost:8080/wasm-test.html
# http://localhost:8080/test-page.html
# http://localhost:8080/profiles-test.html
# etc.
```

---

## Troubleshooting

**"holochain not found"**: Make sure you're in the nix shell (`nix develop -c bash`)

**"Admin port set to: 0"**: The actual port is assigned dynamically. Look for "Admin Interfaces: XXXX" in conductor output, or check `/tmp/fishy-e2e/admin_port.txt`

**"No secure random number generator found"**: Some tests need libsodium. Run `npm test` from repo root, not individual test files.

**Playwright extension not loading**: Check that extension is built (`npm run build`) and path is correct in test fixture. Check `.playwright-user-data-*/` directories for IndexedDB state.

**Gateway connection refused**: Check that gateway is running (`./scripts/e2e-test-setup.sh status`). Check that `HC_MEMBRANE_DIR` points to correct repo and gateway is built (`cargo build --release` in hc-membrane).

**Arc not established**: Conductors need time to establish DHT arcs. `e2e-test-setup.sh` waits up to 90s (minimum 30s). Check conductor logs in `/tmp/fishy-e2e/*.log` for arc establishment messages.

**Deserialization errors**: Verify that WASM boundary invariants are followed (see CLAUDE.md). Check that payloads with hashes use Uint8Array (39 bytes), not base64 strings or 32-byte raw keys.

**Test hApp build failures**: For ziptest/mewsfeed, rebuild in respective repos and copy to `fixtures/`.
