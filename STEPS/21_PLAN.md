# Step 21: Firefox Compatibility

## Goal

Make the fishy extension fully compatible with Firefox in addition to Chrome, with a dual-build system that produces separate browser-specific outputs from the same source.

**Core challenge**: Firefox lacks `chrome.offscreen`, `SharedArrayBuffer` (for regular extensions), and `chrome.runtime.getContexts()`. The synchronous WASM execution chain (Atomics.wait + SharedArrayBuffer + sync XHR in offscreen document) must be replaced with a Firefox-compatible alternative.

**Key insight**: Workers in Firefox CAN do synchronous XMLHttpRequest directly. This eliminates the offscreen-document-as-sync-XHR-proxy pattern. The ribosome worker can make network calls and sign data directly, without SharedArrayBuffer coordination.

---

## Architecture Comparison

**Chrome (current):**
```
Page -> Content -> Background (ServiceWorker) -> Offscreen (DOM)
                                                     |
                                    sync XHR --------+
                                    sign fwd --------+-----> Worker
                                    SharedArrayBuffer +      WASM + SQLite
                                    Atomics -----------+      Atomics.wait
```

**Firefox (proposed):**
```
Page -> Content -> Background (Event Page, DOM) -> Worker
                                                     |
                                               sync XHR (direct)
                                               Lair signing (direct/preloaded keys)
                                               WASM + SQLite
```

---

## Key Constraints

1. **Chrome must not regress** -- all existing tests must continue passing
2. **Same feature set** on both browsers (zome calls, signing, publishing, signals, storage)
3. **Serialization correctness** across all boundaries on both browsers
4. **Minimal code duplication** -- shared code where possible, browser-specific modules where necessary
5. **Build system** produces `dist-chrome/` and `dist-firefox/` from same source

---

## Analysis: Firefox MV3 Differences

| Feature | Chrome MV3 | Firefox MV3 |
|---------|------------|-------------|
| Background | Service worker (no DOM) | Event page (has DOM access) |
| Offscreen document | `chrome.offscreen` API | Not available |
| SharedArrayBuffer | Available in extension pages | Not available (Bug 1673477) |
| Sync XHR in Worker | Available but CORS may block cross-origin | Available (to be verified for cross-origin) |
| Message passing | Converts Uint8Array to `{0:x, 1:y}` objects | Preserves Uint8Array (structured clone) |
| Manifest background key | `"service_worker"` | `"scripts"` |
| Context enumeration | `chrome.runtime.getContexts()` | Not available |
| Worker from background | Cannot (SW can't create Workers) | Can (event page has DOM) |
| OPFS / opfs-sahpool | Available in Workers | Available since Firefox 111 |

---

## Implementation Plan

### Phase 1: Browser Abstraction Layer

**Goal**: Detect browser and provide feature flags.

**New file**: `packages/extension/src/lib/browser-api.ts`
- `isFirefox(): boolean` -- feature detection via `typeof chrome.offscreen === 'undefined'`
- `hasOffscreenSupport(): boolean`
- `hasSharedArrayBufferSupport(): boolean` -- test actual `SharedArrayBuffer` construction
- Continue using `chrome.*` namespace everywhere (Firefox supports it in MV3)
- No `webextension-polyfill` dependency needed

**Files**: New `browser-api.ts` only.

### Phase 2: Dual Manifest + Build System

**Goal**: Produce separate Chrome and Firefox builds.

**2A: Manifest split**

`manifest.chrome.json`:
- `"background": { "service_worker": "background/index.js", "type": "module" }`
- `"permissions": ["storage", "unlimitedStorage", "offscreen"]`

`manifest.firefox.json`:
- `"background": { "scripts": ["background/index.js"] }`
- `"permissions": ["storage", "unlimitedStorage"]` (no offscreen)
- `"browser_specific_settings": { "gecko": { "id": "fishy@holochain.org", "strict_min_version": "128.0" } }`

**2B: Build system changes**

Modify `vite.config.ts`:
- Accept `BROWSER` env var (`chrome` | `firefox`, default `chrome`)
- Inject `__BROWSER__` compile-time constant via Vite `define`
- Output to `dist-chrome/` or `dist-firefox/`
- Firefox: skip offscreen HTML + offscreen.js bundle entries
- Firefox: still build ribosome-worker.js (spawned from background, not offscreen)
- Copy appropriate manifest file

New npm scripts:
```
"build:chrome": "BROWSER=chrome vite build"
"build:firefox": "BROWSER=firefox vite build"
```

**Files**: `vite.config.ts`, new `manifest.chrome.json`, new `manifest.firefox.json`, delete `manifest.json`.

### Phase 3: Executor Interface (Background Refactoring)

**Goal**: Extract offscreen-document management behind a platform interface.

**3A: Interface** -- `packages/extension/src/lib/zome-executor.ts`
```typescript
export interface ZomeExecutor {
  ensureReady(): Promise<void>;
  executeZomeCall(request): Promise<{result: unknown; signals: any[]}>;
  configureNetwork(config): Promise<void>;
  updateSessionToken(token: string | null): Promise<void>;
  registerAgent(dnaHash, agentPubKey): Promise<void>;
  unregisterAgent(dnaHash, agentPubKey): Promise<void>;
  getAllRecords(dnaHash, agentPubKey): Promise<any>;
  getWsState(): any;
  disconnect(): void;
  reconnect(): void;
}
```

**3B: Chrome executor** -- `packages/extension/src/lib/chrome-zome-executor.ts`
- Extract from `background/index.ts`: `ensureOffscreenDocument()`, `hasOffscreenDocument()`, offscreen message routing
- Wraps all `chrome.offscreen.*` and `sendMessage({target: "offscreen"})` calls

**3C: Firefox executor** -- `packages/extension/src/lib/firefox-zome-executor.ts`
- Creates Worker directly from background event page (has DOM)
- Worker handles WASM + SQLite + sync XHR + signing
- WebSocket service runs in background event page
- Communication via standard `postMessage`

**3D: Background refactoring** -- modify `background/index.ts`
- Import executor factory that returns Chrome or Firefox executor based on `__BROWSER__`
- Replace ~15 direct offscreen call sites with executor interface calls

**Files**: New `zome-executor.ts`, `chrome-zome-executor.ts`, `firefox-zome-executor.ts`. Modify `background/index.ts`.

### Phase 4: Firefox Worker Architecture

**Goal**: Ribosome worker operates without SharedArrayBuffer on Firefox.

**4A: Direct sync XHR in worker**

Modify `ribosome-worker.ts` -- `ProxyNetworkService` gains a direct sync XHR mode:

```typescript
fetchSync(method, url, headers?, body?) {
  if (this.useDirectXhr) {
    // Firefox: sync XHR directly from worker
    const xhr = new XMLHttpRequest();
    xhr.open(method, fullUrl, false);
    // ...
  } else {
    // Chrome: Atomics.wait + SharedArrayBuffer (existing)
  }
}
```

**Critical risk**: Do Workers in Firefox extension context inherit `host_permissions` for cross-origin XHR? Must verify early. **Fallback**: If CORS blocks, run WASM in the background event page's main thread (has DOM + host permissions).

**4B: Signing without SharedArrayBuffer**

Preload Ed25519 signing keys into worker:
1. Background sends `LOAD_SIGNING_KEY` message with keypair when Lair is unlocked
2. Worker stores in memory (`Map<pubKeyBase64, secretKey>`)
3. Worker signs directly using `libsodium-wrappers` (already bundled)
4. No cross-context roundtrip needed

`ProxyLairClient` gains a direct-signing mode:
```typescript
signSync(pub_key, data) {
  if (this.useDirectSigning) {
    return sodium.crypto_sign_detached(data, this.directKeys.get(keyStr));
  }
  // else: SharedArrayBuffer path
}
```

**4C: Worker initialization differences**

`INIT` message handler branches on presence of SharedArrayBuffers:
- Present: Chrome path (existing)
- Absent: Firefox path (enable direct sync XHR + direct signing)

**Files**: Modify `ribosome-worker.ts`. New `firefox-lair-bridge.ts` (key preloading).

### Phase 5: Serialization Boundary Audit

**Goal**: Verify all boundaries work correctly on Firefox.

| Boundary | Chrome behavior | Firefox behavior | Action |
|----------|----------------|-----------------|--------|
| Page <-> Content | Converts Uint8Array | Preserves | Existing normalization handles both |
| Content <-> Background | Converts Uint8Array | Preserves | Existing normalization handles both |
| Background <-> Worker | N/A (through offscreen) | Preserves (postMessage) | Standard structured clone |
| WASM <-> Memory | Same | Same | No change |
| Gateway responses | Same | Same | No change |
| SQLite blobs | Same | Same | No change |

**Recommendation**: Keep all normalization functions in place. They are no-ops when data is already Uint8Array. Optimization deferred.

**Files**: Audit only, no changes expected.

### Phase 6: SQLite / OPFS Verification

**Goal**: Confirm SQLite persistence works in Firefox extension Workers.

- `@sqlite.org/sqlite-wasm` `opfs-sahpool` VFS requires `FileSystemSyncAccessHandle` -- supported in Firefox Workers since Firefox 111
- Fix `document` polyfill in `ribosome-worker.ts` to handle `moz-extension://` URLs (currently assumes `chrome-extension://`)
- **Fallback**: If `opfs-sahpool` fails, existing fallback to `:memory:` SQLite handles it. Data re-fetched from gateway.

**Files**: Minor fix in `ribosome-worker.ts`.

### Phase 7: E2E Testing

**Goal**: Playwright tests run on both Chrome and Firefox.

- Add `firefox-extension` project to `playwright.config.cjs`
- Browser-conditional extension loading in `browser-context.ts`
- Firefox extension loading via `web-ext` or temporary add-on
- Browser-conditional extension path (`dist-chrome` vs `dist-firefox`)

**Files**: `playwright.config.cjs`, `browser-context.ts`, `fixtures.ts`.

### Phase 8: WebSocket + Signals

**Goal**: Remote signal delivery works on Firefox.

- `WebSocketNetworkService` is pure TypeScript (standard WebSocket API) -- works in both browsers
- Chrome: runs in offscreen document
- Firefox: runs in background event page (has DOM for WebSocket)
- Signal forwarding via `chrome.tabs.sendMessage` works identically on both browsers

**Files**: Handled by Firefox executor in Phase 3C.

---

## Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Worker sync XHR blocked by CORS in Firefox extensions | High | Test early (Phase 4A). Fallback: WASM in background event page |
| SQLite `opfs-sahpool` fails in Firefox Workers | Medium | Existing fallback to `:memory:`. Data re-fetched from gateway |
| Firefox event page idle suspension kills Worker/WebSocket | Medium | Implement reconnection logic. Use `alarms` API for keepalive |
| Playwright Firefox extension testing limitations | Medium | May need `web-ext` + custom harness |
| Key preloading security (secret keys in Worker memory) | Low | Same-origin, same-process. No worse than current Chrome path |

---

## Future Direction: JSPI

WebAssembly JavaScript Promise Integration (Phase 4 W3C, Chrome 137+, Firefox 139+ behind flag) would eventually allow:
- Async host functions that suspend/resume WASM natively
- No sync XHR, SharedArrayBuffer, or offscreen documents needed
- One unified architecture for both browsers
- Monitor Firefox JSPI unflagging for future migration

---

## Files Summary

**New files** (7):
| File | Purpose |
|------|---------|
| `packages/extension/manifest.chrome.json` | Chrome-specific manifest |
| `packages/extension/manifest.firefox.json` | Firefox-specific manifest |
| `packages/extension/src/lib/browser-api.ts` | Browser detection + feature flags |
| `packages/extension/src/lib/zome-executor.ts` | Executor interface |
| `packages/extension/src/lib/chrome-zome-executor.ts` | Chrome executor (offscreen) |
| `packages/extension/src/lib/firefox-zome-executor.ts` | Firefox executor (direct worker) |
| `packages/extension/src/lib/firefox-lair-bridge.ts` | Key preloading for Firefox worker |

**Modified files** (8):
| File | Change |
|------|--------|
| `packages/extension/vite.config.ts` | Dual-browser build, `__BROWSER__` define |
| `packages/extension/package.json` | `build:chrome`, `build:firefox` scripts |
| `packages/extension/src/background/index.ts` | Executor interface instead of direct offscreen calls |
| `packages/extension/src/offscreen/ribosome-worker.ts` | Direct sync XHR + direct signing modes |
| `packages/e2e/playwright.config.cjs` | Firefox project |
| `packages/e2e/tests/fixtures.ts` | Browser-conditional extension loading |
| `packages/e2e/src/browser-context.ts` | Firefox context creation |
| Root `package.json` | Build scripts |

**Deleted files** (1):
| File | Reason |
|------|--------|
| `packages/extension/manifest.json` | Replaced by browser-specific manifests |

---

## Success Criteria

1. `npm run build:chrome` produces working Chrome build -- all existing tests pass
2. `npm run build:firefox` produces valid Firefox build
3. Firefox extension loads in `about:debugging#/runtime/this-firefox`
4. Zome calls work end-to-end on Firefox (create entry, read back)
5. Signing works on Firefox (key preloading + libsodium)
6. SQLite persistence works on Firefox (or graceful fallback to memory)
7. WebSocket signals delivered on Firefox
8. E2E tests pass on both Chrome and Firefox
