# Fishy

## Overview

This project is a browser extension-based implementation of the Holochain conductor as implemented in https://github.com/holochain/holochain/ as well as lair keystore as implemented in https://github.com/holochain/lair.

The Holochain repo is a large mono-repo and the portions to be implemented here would be the ability for a browser based UI to run a holochain hApp wasm in the browser and have the extension take on the host side actions which sign and store source chain data along with making network calls for which it will have a different http gateway based approach rather than using the network protocols as defined in kitsune2.

## Assumptions that differentiate this implementation from the full distributed Holochain implementation

1. These nodes do not gossip, they are considered zero-arc and thus get all data from the network (though they may cache data especially content-addressable data)
2. The identifying context of the hApp is directly obtained from the domain name from which the happ UI and wasm is downloaded.
3. Agency (i.e. the private key pair) for a given hApp context is stored in a local data base mirroring Lair functionality for signing.
4. Node are not expected to have progenitor status on a Holochain network i.e. they are all operating in a context where other always on nodes exist.
5. TODO Bootstrapping assumptions?

## Project Structure

This is a TypeScript mono-repo with the following packages:

```
packages/
├── extension/     # Chrome/Firefox browser extension (MV3)
│   ├── src/
│   │   ├── background/  # Service worker
│   │   ├── content/     # Content scripts (page bridge)
│   │   ├── popup/       # Extension popup UI
│   │   └── lib/         # Shared extension code
│   └── manifest.json
├── core/          # Core Holochain conductor functionality
│   └── src/
│       ├── conductor/   # Conductor logic
│       ├── ribosome/    # Host function implementations
│       └── types/       # Holochain-compatible types
├── lair/          # Browser-based Lair keystore
│   └── src/             # Key management, signing, encryption
└── shared/        # Shared types and utilities
    └── src/
```

## Reference Repos (local paths)

- **Holochain**: `../holochain` - Main conductor, ribosome, HDK/HDI
- **Lair**: `../lair` - Keystore API and implementation
- **hc-http-gw**: `../hc-http-gw` - HTTP gateway for zero-arc nodes

---

## Implementation Plan

### Step 0: Plan Refinement ✓

**Goal**: Ensure the plan is detailed enough for successful Claude-driven implementation.

**Completed**:
- [x] Analyzed Holochain repo structure (42 workspace crates identified)
- [x] Analyzed Lair keystore API (key functions: new_seed, sign_by_pub_key, derive_seed, crypto_box operations)
- [x] Located hc-http-gw at `../hc-http-gw` (Axum-based HTTP bridge)
- [x] Identified 56 host functions in ribosome/host_fn/
- [x] Created mono-repo scaffolding

---

### Step 1: Browser Extension Base ✓

**Goal**: Create a working browser extension with a base API for webpage ↔ extension communication.

**Dependencies**: None

**Completed**:
- [x] **1.1** Configure build tooling for extension (Vite + TypeScript)
- [x] **1.2** Implement background service worker skeleton with message routing
- [x] **1.3** Implement content script that injects `window.holochain` API
- [x] **1.4** Create message passing protocol between content script ↔ background
- [x] **1.5** Add basic popup UI showing connection status
- [x] **1.6** Test: Verify round-trip message passing from page → extension → page

**Key Files**:
- `packages/extension/src/background/index.ts` - Message router with handlers for CONNECT, DISCONNECT, CALL_ZOME, APP_INFO
- `packages/extension/src/content/index.ts` - Bridge that injects window.holochain API
- `packages/extension/src/lib/messaging.ts` - Type-safe message protocol with serialization
- `packages/extension/src/popup/index.html` - Extension popup UI
- `packages/extension/test/test-page.html` - Integration test page

**Tests**:
- ✅ 18 unit tests for message serialization/deserialization (all passing)
- ✅ Integration test webpage with manual testing instructions

---

### Step 2: Lair Keystore Implementation ✓

**Goal**: Implement browser-based key management mirroring Lair functionality.

**Dependencies**: Step 1 (extension infrastructure)

**Reference**: `../lair/crates/lair_keystore_api/src/lair_client.rs`

**Completed**:
- [x] **2.1** Set up IndexedDB storage layer for keys
- [x] **2.2** Implement Ed25519 key generation using libsodium-wrappers
- [x] **2.3** Implement `new_seed()` - generate new signing keypair
- [x] **2.4** Implement `sign_by_pub_key()` - sign data with stored key
- [x] **2.5** Implement `list_entries()` / `get_entry()` - key enumeration
- [x] **2.6** Implement `derive_seed()` - hierarchical key derivation
- [x] **2.7** Implement encryption: `crypto_box_xsalsa_by_pub_key`, `crypto_box_xsalsa_open_by_pub_key`
- [x] **2.8** Implement secret box operations for symmetric encryption

**Key Files**:
- `packages/lair/src/index.ts` - Main exports
- `packages/lair/src/client.ts` - LairClient implementation
- `packages/lair/src/storage.ts` - IndexedDB storage with Uint8Array serialization
- `packages/lair/src/types.ts` - TypeScript type definitions
- `packages/lair/src/client.test.ts` - Comprehensive test suite (21 tests)

**Tests**:
- ✅ 21/21 tests passing
- Key generation, signing, encryption, derivation all verified
- IndexedDB persistence tested with fake-indexeddb

---

### Step 2.5: Lair UI Integration

**Goal**: Add UI in extension popup for Lair key management before implementing web page authorization.

**Dependencies**: Step 2 (Lair client)

**Sub-tasks**:
1. **2.5.1** Implement lock/unlock mechanism
   - Explore WebAuthn/Passkeys API for modern authentication
   - Fallback to passphrase-based if WebAuthn not suitable
   - Lock state persists across browser restarts
2. **2.5.2** Create keypair management UI
   - Create new keypairs with tag and exportable flag
   - List existing keypairs with metadata
   - Delete keypairs (with confirmation)
3. **2.5.3** Implement sign/verify operations in UI
   - Text input for data to sign
   - Display signature in base64
   - Verify signatures from other keypairs
4. **2.5.4** Implement export/import functionality
   - Export keypairs with passphrase-based encryption
   - Enforce exportable flag (non-exportable keys cannot be exported)
   - Import encrypted keypairs
   - Follow security model from original Lair
5. **2.5.5** Add Lair operations to background service worker
   - Message types for all Lair operations
   - Handlers that check lock state before operations
   - Only accessible from extension popup (not web pages)
6. **2.5.6** Write tests for UI operations
   - Lock/unlock flow
   - Create/list/delete keypairs
   - Sign/verify operations
   - Export/import with encryption

**Key Files**:
- `packages/extension/src/popup/lair.html` - Lair management UI
- `packages/extension/src/popup/lair.ts` - UI logic
- `packages/extension/src/lib/lair-lock.ts` - Lock/unlock mechanism
- `packages/extension/src/lib/lair-export.ts` - Export/import with encryption
- `packages/extension/src/background/index.ts` - Add Lair message handlers
- `packages/extension/src/lib/messaging.ts` - Add Lair message types

**Tests**:
- Lock/unlock mechanism works correctly
- Keypair operations only work when unlocked
- Export respects exportable flag
- Import/export round-trip with passphrase
- UI properly displays key information

**Design Decisions**:
- Lair operations NOT exposed through window.holochain API (popup only)
- Passphrase-based export/import for simplicity
- Strict enforcement of exportable flag
- Lock state persists across restarts

**Implementation Notes** (Step 2.5 Complete ✓):
- Used Web Crypto API PBKDF2 instead of libsodium crypto_pwhash (Argon2id) for broader browser compatibility
- Integrated export/import methods directly into LairClient instead of separate lair-export.ts file
- Passphrase-based lock/unlock chosen over WebAuthn/Passkeys for v1 (can add WebAuthn later)
- Chrome message passing serialization handled with toUint8Array() helper pattern
- Files created: lair.html (9.74KB), lair.ts (474 lines), lair-lock.ts (311 lines)
- Methods added to LairClient: exportSeedByTag(), importSeed(), deleteEntry()
- 13 new message types added for Lair operations
- All functionality verified working in Chrome browser

---

### Step 3: Authorization Mechanism ✓

**Goal**: Implement user consent flow for page ↔ extension connections (like MetaMask).

**Dependencies**: Step 1, Step 2

**Completed**:
- [x] **3.1** Design permission model (per-domain, simple approach - no per-action granularity)
- [x] **3.2** Create authorization request popup (authorize.html + authorize.ts)
- [x] **3.3** Implement permission storage via PermissionManager (chrome.storage.local)
- [x] **3.4** Add permission check middleware to message handler (handleConnect with AuthManager)
- [x] **3.5** Implement permission revocation UI (permissions.html + permissions.ts)
- [x] **3.6** Handle first-time connection prompts (popup window with 2-minute timeout)

**Key Files**:
- `packages/extension/src/lib/permissions.ts` - PermissionManager class (220 lines)
- `packages/extension/src/lib/auth-manager.ts` - AuthManager class (159 lines)
- `packages/extension/src/popup/authorize.html` - Authorization popup UI
- `packages/extension/src/popup/authorize.ts` - Authorization popup logic
- `packages/extension/src/popup/permissions.html` - Permission management UI
- `packages/extension/src/popup/permissions.ts` - Permission management logic
- `packages/extension/test/authorization-test.html` - Manual test page

**Tests**:
- ✅ 9 PermissionManager tests (grant, deny, revoke, list, persistence)
- ✅ 9 AuthManager tests (create, resolve, timeout, cleanup)
- ✅ Build successful - all files compiled
- ✅ Extension loads without errors in Chrome

**Implementation Notes**:
- Per-domain permissions (simple model, can expand to per-action later)
- MetaMask-style popup window approach
- Promise-based authorization flow with 2-minute timeout
- Permissions persist across browser restarts via chrome.storage.local
- Added 'wasm-unsafe-eval' CSP to manifest.json for libsodium WebAssembly support

---

### Step 4: hApp Context Creation ✓

**Goal**: Create hApp contexts based on domain-served data.

**Dependencies**: Step 1, Step 2, Step 3

**Completed** (2025-12-26):
- [x] **4.1** Define hApp context structure (domain, DNA hashes, agent key) - HappContext, DnaContext, CellId types
- [x] **4.2** Implement context storage (IndexedDB) - HappContextStorage class with fishy_happ_contexts database
- [x] **4.3** Create context initialization flow from web page - installHapp() API with INSTALL_HAPP message type
- [x] **4.4** Associate agent keys with contexts - One agent key per domain, created via Lair with tag `${domain}:agent`
- [x] **4.5** Implement context listing and selection - listContexts(), getContextForDomain(), enable/disable

**Key Files**:
- `packages/core/src/index.ts` - HappContext, DnaContext, CellId types
- `packages/extension/src/lib/happ-context-storage.ts` - IndexedDB storage (2 stores: contexts + dna_wasm)
- `packages/extension/src/lib/happ-context-manager.ts` - Business logic orchestration
- `packages/extension/src/background/index.ts` - Message handlers (INSTALL_HAPP, LIST_HAPPS, etc.)
- `packages/extension/test/happ-install-test.html` - Manual test page

**Tests**:
- ✅ 12 storage tests (context CRUD, domain index, DNA WASM deduplication)
- ✅ 13 manager tests (install flow, permission checks, agent key lifecycle)
- ✅ 79 total tests passing + 16 skipped
- ⏳ Manual browser testing pending

---

### Step 5: WASM Execution with Mocked Host Functions

**Goal**: Run hApp WASM with host functions that return mock data.

**Dependencies**: Step 4

**Reference**: `../holochain/crates/holochain/src/core/ribosome/host_fn/`

**Sub-tasks**:
1. **5.1** Set up WASM runtime (browser-native WebAssembly or wasmer-js)
2. **5.2** Define host function import interface matching Holochain's
3. **5.3** Implement mock versions of info functions:
   - `agent_info`, `dna_info`, `zome_info`, `call_info`
4. **5.4** Implement mock CRUD operations (return canned data):
   - `create`, `get`, `update`, `delete`, `query`
5. **5.5** Implement mock link operations:
   - `create_link`, `delete_link`, `get_links`, `count_links`
6. **5.6** Implement utility functions:
   - `random_bytes`, `sys_time`, `trace`, `hash`
7. **5.7** Implement signing functions (delegate to Lair):
   - `sign`, `sign_ephemeral`, `verify_signature`
8. **5.8** Test with sample HDK zome functions

**Host Functions (56 total, grouped)**:

| Category | Functions | Priority |
|----------|-----------|----------|
| Info | agent_info, dna_info, zome_info, call_info, capability_info | High |
| CRUD | create, get, update, delete, query | High |
| Links | create_link, delete_link, get_links, get_links_details, count_links | High |
| Signing | sign, sign_ephemeral, verify_signature | High |
| Crypto | create_x25519_keypair, *_encrypt, *_decrypt | Medium |
| Signals | emit_signal, send_remote_signal | Medium |
| DHT Must-Get | must_get_action, must_get_entry, must_get_valid_record | Low (network) |
| Clone Cells | create/delete/enable/disable_clone_cell | Low |
| Chain | close_chain, open_chain | Low |
| Utility | random_bytes, sys_time, trace, sleep, schedule | High |

**Key Files**:
- `packages/core/src/ribosome/host_fn/*.ts` (one per function)
- `packages/core/src/ribosome/wasm_runtime.ts`

**Tests**:
- Each host function returns expected mock data
- WASM can call host functions and receive results
- Test with simple "hello world" zome

---

### Step 6: Local Chain Data Storage

**Goal**: Implement real source chain storage for create/update/delete operations.

**Dependencies**: Step 5

**Sub-tasks**:
1. **6.1** Design source chain data model (actions, entries, hashes)
2. **6.2** Implement chain storage (IndexedDB)
3. **6.3** Implement `create` - write entry to chain
4. **6.4** Implement `update` - create update action
5. **6.5** Implement `delete` - create delete action
6. **6.6** Implement `query` - query local chain
7. **6.7** Implement `get` - retrieve from local chain
8. **6.8** Implement link storage
9. **6.9** Hash computation (action hash, entry hash)

**Key Files**:
- `packages/core/src/conductor/source_chain.ts`
- `packages/core/src/conductor/chain_storage.ts`

**Tests**:
- Create stores entry and action
- Query returns created entries
- Update creates proper chain linkage
- Delete marks entries appropriately

---

### Step 7: hc-http-gw Extensions

**Goal**: Extend hc-http-gw to support zero-arc node publish operations.

**Dependencies**: Step 6

**Reference**: `../hc-http-gw/src/`

**Sub-tasks**:
1. **7.1** Analyze current hc-http-gw endpoints
2. **7.2** Design publish endpoint for zero-arc nodes
3. **7.3** Implement `/publish` endpoint for committing to DHT
4. **7.4** Implement authentication for publish requests
5. **7.5** Handle publish responses in extension

**Key Files**:
- `../hc-http-gw/src/routes/publish.rs` (new)
- `packages/core/src/conductor/network.ts`

**Tests**:
- Publish request accepted by gateway
- Published data retrievable via get

---

### Step 8: Network Host Functions

**Goal**: Implement host functions that make real network requests via hc-http-gw.

**Dependencies**: Step 7

**Sub-tasks**:
1. **8.1** Implement network client for hc-http-gw
2. **8.2** Replace mock `get` with network fetch
3. **8.3** Implement `must_get_*` functions (DHT retrieval)
4. **8.4** Implement `get_agent_activity`
5. **8.5** Implement `send_remote_signal` via gateway
6. **8.6** Implement `call` for cross-cell calls

**Key Files**:
- `packages/core/src/conductor/network.ts`
- `packages/core/src/ribosome/host_fn/get.ts` (updated)

**Tests**:
- Get retrieves data from network
- Published data is retrievable
- Remote signals delivered

---

### Step 9: Integration Testing

**Goal**: Test with existing Holochain hApps.

**Dependencies**: All previous steps

**Sub-tasks**:
1. **9.1** Select test hApps (simple CRUD, links, signals)
2. **9.2** Create test harness for running hApp UIs
3. **9.3** Test basic CRUD operations end-to-end
4. **9.4** Test link operations
5. **9.5** Test multi-agent scenarios (if applicable)
6. **9.6** Performance testing
7. **9.7** Fix discovered issues

---

## Dependency Graph

```
Step 0 ✓
    │
    v
Step 1 (Extension Base) ✓
    │
    v
Step 2 (Lair Client) ✓
    │
    v
Step 2.5 (Lair UI) ✓
    │
    └──────┬───────────┐
           v           v
       Step 3      Step 4
       (Auth)      (hApp Context)
           │           │
           └─────┬─────┘
                 v
             Step 5 (WASM + Mock Host Fn)
                 │
                 v
             Step 6 (Local Chain)
                 │
                 v
             Step 7 (hc-http-gw)
                 │
                 v
             Step 8 (Network Host Fn)
                 │
                 v
             Step 9 (Integration Tests)
```

---

## Requirements, Tradeoffs & Dev Instructions

1. Each step of the process must be built using test-driven development practices such that CI can confirm no regressions before merging a PR
2. **User testing is required before commits**: After implementing features, user testing must be performed in a real browser environment before creating git commits. This ensures functionality works as expected.
3. Different portions of the plan, or even the same plan may be worked on from different workstations, so claude must be set up to pick up sessions where they were left off.
4. Perfect is the enemy of the good. This plan should not be implemented to the highest possible standard of efficiency or robustness, but rather in a way that allows for reaching the functionality goals in reasonable time, and iterating on quality goals over time.
5. Don't add claude co-authored/generated messages in commit descriptions

---

## Technical Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Web Crypto API limitations | May not support all Ed25519 operations | Use libsodium.js (sodium-native) as fallback |
| WASM memory limits in extension | Large hApps may fail | Implement streaming/chunking, test with real hApps early |
| Extension ↔ Page communication security | XSS/injection risks | Use structured cloning, validate all messages |
| IndexedDB size limits | May hit storage caps | Implement LRU cache for DHT data, keep source chain complete |
| hc-http-gw compatibility | API may change | Pin to specific version, abstract network layer |
| Cross-browser compatibility | Firefox/Chrome differences | Use webextension-polyfill, test on both |

---

## Session Continuity

To support picking up work across sessions:

1. **This file** (`claude.md`) serves as the source of truth for project state
2. **Git commits** should be atomic and well-described
3. **TODO comments** in code should reference step numbers (e.g., `// TODO(Step 5.3): implement agent_info`)
4. **Each step** should be completable in isolation once dependencies are met
5. **Tests** verify step completion - all tests pass = step complete
