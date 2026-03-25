# Holochain Web Conductor Testing Guide

This document covers testing for both **hApp developers testing their apps with HWC** and **HWC contributors testing the extension itself**.

---

## Testing Your hApp with HWC

If you're building an app that uses `@holo-host/web-conductor-client`, here's how to test it.

### Unit Testing (mocked extension)

Mock `window.holochain` to test your app logic without the extension:

```typescript
// test-setup.ts
const mockHolochain = {
  isWebConductor: true,
  version: '0.1.0',
  myPubKey: new Uint8Array(39),
  installedAppId: 'test-app',
  connect: vi.fn().mockResolvedValue(undefined),
  callZome: vi.fn().mockResolvedValue(/* your expected return */),
  appInfo: vi.fn().mockResolvedValue({
    contextId: 'test-app',
    agentPubKey: new Uint8Array(39),
    cells: [[new Uint8Array(39), new Uint8Array(39)]],
    status: 'enabled',
  }),
  on: vi.fn().mockReturnValue(() => {}),
  configureNetwork: vi.fn().mockResolvedValue(undefined),
  getConnectionStatus: vi.fn().mockResolvedValue({
    httpHealthy: true, wsHealthy: true, linkerUrl: 'ws://localhost:8090', lastChecked: Date.now(),
  }),
  onConnectionChange: vi.fn().mockReturnValue(() => {}),
};

(globalThis as any).window = { holochain: mockHolochain };
```

### E2E Testing (real extension + linker)

For full integration testing with a real extension and linker, use the e2e test infrastructure in `packages/e2e/`. The `e2e-test-setup.sh` script orchestrates the full stack:

1. Bootstraps Holochain conductors
2. Starts the linker
3. Loads the extension
4. Runs Playwright tests

See the [E2E Tests with Linker](#e2e-tests-with-linker) section below for details.

### Testing Joining Service Flows

The `@holo-host/joining-service` package includes test utilities:

```typescript
import { createApp, resolveConfig } from '@holo-host/joining-service';

// Spin up a test joining service with open auth
const config = resolveConfig({
  happ: { id: 'test', name: 'Test' },
  auth_methods: ['open'],
  linker_urls: ['ws://localhost:8090'],
});
const app = createApp({ config });
// Use with fetch() or a test HTTP client
```

See the joining-service [E2E tests](https://github.com/Holo-Host/joining-service/tree/main/test/e2e) for examples of testing email verification, invite codes, agent whitelist, and reconnect flows.

---

## HWC Internal Testing

The rest of this document covers testing procedures for the Holochain Web Conductor extension itself.

## Quick Reference

| Test Type | Command | Requirements |
|-----------|---------|--------------|
| Unit tests (vitest) | `npm test` | None |
| Build validation | `npm run build` | None |
| Type checking | `npm run typecheck` | None (tsc --noEmit all packages) |
| Integration tests | `npm run test:integration` | None |
| Browser tests (Playwright) | `npm run e2e:test:browsers` | `npm run build` (no nix, no conductor/linker) |
| E2E (Playwright) | `npm run e2e:test:cross-browser` | nix shell, conductor, linker (auto-started) |
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
- `packages/client` - 5 test files (~97 tests): WebConductorAppClient, connection monitoring
- `packages/lair` - 1 test file (~25 tests): Key management
- `packages/shared` - 1 test file: Shared utilities

**Important**: `npm test` includes typechecking, but running vitest directly does not. See [DEVELOPMENT.md](./DEVELOPMENT.md#typecheck-pipeline) for details.

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

## Browser Tests (Chrome + Firefox)

Automated Playwright tests that exercise the extension's local WASM execution on `happ-test.html`. No external dependencies — no nix shell, conductors, linker, or hApp repos required.

```bash
# Build the extension first
npm run build

# Run browser tests (Chrome + Firefox)
npm run e2e:test:browsers
```

This runs the `happ-test.html` "Run All Tests" suite in both Chrome and Firefox, covering:
- Extension detection and authorization
- hApp installation (test.happ with test-zome.wasm)
- Client connection via WebConductorAppClient
- Zome functions: get_agent_info, CRUD entries, links, signals, query, signing, transaction rollback

Test file: `packages/e2e/tests/browser-tests.test.ts`
Config: `packages/e2e/playwright.browser-tests.cjs`

---

## E2E Tests with Linker

These tests verify the full flow: web page → browser extension → linker → Holochain conductor network.

### Prerequisites

The `holochain`, `hc`, and `kitsune2-bootstrap-srv` binaries must be available. Run all commands in a nix shell:

```bash
nix develop -c bash
```

### Linker

The project uses h2hc-linker which integrates directly with the kitsune2 network:

| Linker | Repo | Mode |
|--------|------|------|
| `h2hc-linker` | `../h2hc-linker` | Kitsune mode |

Set repo path with environment variable:
- `H2HC_LINKER_DIR` - Path to h2hc-linker repo (default: `../h2hc-linker`)

### Test hApps

Two hApp fixtures are supported:

| hApp | App ID | Source | UI Server | Tests |
|------|--------|--------|-----------|-------|
| ziptest | `ziptest` | `fixtures/ziptest.happ` (committed binary) | `../ziptest/ui/dist` (port 8081) | Multi-agent sync |
| mewsfeed | `mewsfeed` | `fixtures/mewsfeed.happ` (committed binary) | `../mewsfeed/ui/dist` (port 8082) | Real-world hApp, cross-browser |

### Running E2E Tests

All e2e commands go through the TypeScript CLI (`npm run e2e`), which automatically manages the test environment (conductors, linker, bootstrap server). The correct hApp is inferred from the test being run.

The Playwright tests are in `packages/e2e/`:

| Test File | Project | Description | Fixture |
|-----------|---------|-------------|---------|
| `ziptest.test.ts` | `chromium-extension` | Multi-agent: profiles, signal exchange, entry sync | ziptest |
| `mewsfeed.test.ts` | `chromium-extension` | Multi-agent: profiles, mew posting, hashtag search | mewsfeed |
| `cross-browser.test.ts` | `cross-browser` | Alice (Chrome) + Bob (Firefox): mewsfeed interop | mewsfeed |

**To run tests** (all commands from the project root, in nix shell):

```bash
# Run a specific test suite (starts env automatically with correct hApp):
nix develop -c npm run e2e:test:ziptest         # Ziptest, Chrome-only
nix develop -c npm run e2e:test:mewsfeed        # Mewsfeed, Chrome-only
nix develop -c npm run e2e:test:cross-browser   # Mewsfeed, Chrome + Firefox

# Run all tests:
nix develop -c npm run e2e:test

# Run with custom options:
nix develop -c npm run e2e:test -- --project=chromium-extension --test=tests/ziptest.test.ts --headed
```

**Environment management** (for debugging or manual testing):

```bash
nix develop -c npm run e2e:env:start            # Start env (default: ziptest)
nix develop -c npm run e2e:env:start -- --happ=mewsfeed  # Start with specific hApp
nix develop -c npm run e2e:env:status           # Check what's running
nix develop -c npm run e2e:env:stop             # Stop all services
nix develop -c npm run e2e:logs                 # Stream service logs
```

**Idempotent startup**: If the environment is already running with the correct hApp, it skips startup. If it's running with a different hApp, it stops and restarts with the correct one.

### Environment internals

The CLI wraps `scripts/e2e-test-setup.sh`, which orchestrates:
1. Local kitsune2-bootstrap-srv (saves port to `/tmp/hwc-e2e/bootstrap_addr.txt`)
2. 2 conductors via `hc sandbox generate --in-process-lair --run 0` with QUIC transport
3. Arc establishment (up to 90s, minimum 30s)
4. h2hc-linker on port 8000
5. UI server (ziptest: port 8081, mewsfeed: port 8082)
6. Test data initialization (saves dna_hash for selected hApp)

**State files** in `/tmp/hwc-e2e/`:
- `bootstrap_addr.txt` - Bootstrap server address
- `admin_port.txt`, `admin_port_2.txt` - Conductor admin ports
- `app_id.txt`, `happ_path.txt`, `dna_hash.txt` - hApp configuration
- PIDs and logs for all services

**Multi-agent architecture**:
- Each agent gets a separate browser context with its own user data directory
- Each context loads the extension independently (separate keypairs in IndexedDB)
- `setupAutoApproval()` intercepts authorization popups and auto-clicks approve
- Extension readiness detected via `window.holochain?.isWebConductor === true`

**Cross-browser notes**:
- The `cross-browser` project manages its own browser contexts (Chrome + Firefox)
- Firefox extension loading uses `playwright-webextext` (temporary add-on install)
- Localhost origins are auto-approved (no popup) since Playwright cannot interact with Firefox extension popups

---

## Manual Test Pages

Interactive HTML test pages for developer debugging (not automated CI). Located in `packages/extension/test/`:

| File | Purpose | Requirements | What You'll See |
|------|---------|-------------|-----------------|
| `sandbox-test.html` | Exercise all extension APIs and 20+ host functions | Extension loaded in Chrome | "Run All" button, 20+ green checks |
| `happ-test.html` | Test WebConductorAppClient library integration | Extension loaded in Chrome | Client CRUD, connection status |
| `authorization-test.html` | Test permission grant/revoke popup flow | Extension loaded in Chrome | Popup opens, permission persists |

**Quick start** (no linker needed):

```bash
# 1. Build extension
npm run build

# 2. Load extension in Chrome
#    Open chrome://extensions, enable Developer mode, Load unpacked from packages/extension/dist

# 3. Serve test pages
./scripts/serve-test-pages.sh

# 4. Open test page and click "Run All"
#    http://localhost:8080/sandbox-test.html
```

**Shared utilities**: `packages/extension/test/lib/test-helpers.js` provides logging, status display, hash formatting, and a `TestRunner` class used by both test pages.

**Test fixtures**: `test.happ`, `test.dna`, `test-zome.wasm` are pre-built from `packages/test-zome/`. Rebuild with `cd packages/test-zome && ./pack.sh`.

---

## Runtime Log Filtering

The extension uses a centralized logger with filterable prefixes. By default, only `info`, `warn`, and `error` messages are shown. Use `setHwcLogFilter()` in any extension console to enable `debug`/`perf`/`trace` output.

```javascript
setHwcLogFilter('*');              // All debug logs
setHwcLogFilter('*,PERF');         // All debug + performance metrics
setHwcLogFilter('*,TRACE');        // All debug + trace detail
setHwcLogFilter('CallZome,Cascade'); // Specific prefixes only
setHwcLogFilter('');               // Quiet (default): info/warn/error only
```

The filter persists across restarts (via `chrome.storage.local`) and syncs across all extension contexts.

### Available prefixes

| Prefix | Package | What it covers |
|--------|---------|----------------|
| `Background` | extension | Service worker lifecycle, message routing |
| `Auth` | extension | Permission/authorization flow |
| `CallZome` | extension | Zome call dispatch from background to offscreen |
| `Linker` | extension | Linker configuration, network setup |
| `Signal` | extension | Remote signal send/receive/delivery |
| `Lair` | extension | Key storage operations |
| `HappContext` | extension | hApp install/uninstall/enable/disable |
| `HappContextStorage` | extension | IndexedDB context persistence |
| `Offscreen` | extension | Offscreen document lifecycle, message handling |
| `OffscreenMgr` | extension | Chrome offscreen document management |
| `ZomeCall` | extension | Zome call execution in offscreen |
| `Network` | extension | Network configuration, WS state |
| `Publish` | extension/core | DHT op publishing and tracking |
| `RibosomeWorker` | extension | WASM worker init, network proxy, SQLite |
| `SQLiteWorker` | extension | SQLite WASM worker |
| `FirefoxExec` | extension | Firefox direct executor |
| `BaseExec` | extension | Base executor (shared WS/signal logic) |
| `AppClient` | client | WebConductorAppClient lifecycle |
| `ConnectionMonitor` | client | Connection state tracking |
| `Reconnect` | client | Reconnection attempts |
| `Ribosome` | core | WASM runtime, performance metrics |
| `HostFn` | core | Host function dispatch |
| `Storage` | core | Source chain and SQLite storage |
| `Genesis` | core | Genesis initialization |
| `GenesisSelfCheck` | core | Genesis validation |
| `Validate` | core | Entry/action validation |
| `Cascade` | core | Data retrieval (local + network) |
| `WebSocket` | core | WebSocket connection, auth, heartbeat |
| `ChainRecovery` | core | Source chain recovery |

Special filter keywords:
- `PERF` — enable performance timing breakdowns (requires prefix match too)
- `TRACE` — enable trace-level detail (requires prefix match too)

---

## Troubleshooting

**"holochain not found"**: Make sure you're in the nix shell (`nix develop -c bash`)

**"Admin port set to: 0"**: The actual port is assigned dynamically. Look for "Admin Interfaces: XXXX" in conductor output, or check `/tmp/hwc-e2e/admin_port.txt`

**"No secure random number generator found"**: Some tests need libsodium. Run `npm test` from repo root, not individual test files.

**Playwright extension not loading**: Check that extension is built (`npm run build`) and path is correct in test fixture. Check `.playwright-user-data-*/` directories for IndexedDB state.

**Linker connection refused**: Check that linker is running (`npm run e2e:env:status`). Check that `H2HC_LINKER_DIR` points to correct repo and linker is built (`cargo build --release` in h2hc-linker).

**Arc not established**: Conductors need time to establish DHT arcs. The setup script waits up to 90s (minimum 30s). Check conductor logs with `npm run e2e:logs` or in `/tmp/hwc-e2e/*.log`.

**Deserialization errors**: Verify that WASM boundary invariants are followed (see [CONTRIBUTING.md](./CONTRIBUTING.md)). Check that payloads with hashes use Uint8Array (39 bytes), not base64 strings or 32-byte raw keys.

**Test hApp build failures**: For ziptest/mewsfeed, rebuild in respective repos and copy to `fixtures/`.
