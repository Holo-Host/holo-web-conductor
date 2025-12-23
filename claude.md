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

### Step 1: Browser Extension Base

**Goal**: Create a working browser extension with a base API for webpage ↔ extension communication.

**Dependencies**: None

**Sub-tasks**:
1. **1.1** Configure build tooling for extension (esbuild/vite + TypeScript)
2. **1.2** Implement background service worker skeleton
3. **1.3** Implement content script that injects `window.holochain` API
4. **1.4** Create message passing protocol between content script ↔ background
5. **1.5** Add basic popup UI showing connection status
6. **1.6** Test: Verify round-trip message passing from page → extension → page

**Key Files**:
- `packages/extension/src/background/index.ts`
- `packages/extension/src/content/index.ts`
- `packages/extension/src/lib/messaging.ts`

**Tests**:
- Unit tests for message serialization
- Integration test with test webpage

---

### Step 2: Lair Keystore Implementation

**Goal**: Implement browser-based key management mirroring Lair functionality.

**Dependencies**: Step 1 (extension infrastructure)

**Reference**: `../lair/crates/lair_keystore_api/src/lair_client.rs`

**Sub-tasks**:
1. **2.1** Set up IndexedDB storage layer for keys
2. **2.2** Implement Ed25519 key generation using Web Crypto API or libsodium.js
3. **2.3** Implement `new_seed()` - generate new signing keypair
4. **2.4** Implement `sign_by_pub_key()` - sign data with stored key
5. **2.5** Implement `list_entries()` / `get_entry()` - key enumeration
6. **2.6** Implement `derive_seed()` - hierarchical key derivation
7. **2.7** Implement encryption: `crypto_box_xsalsa_by_pub_key`, `crypto_box_xsalsa_open_by_pub_key`
8. **2.8** Implement secret box operations for symmetric encryption

**Key Files**:
- `packages/lair/src/index.ts`
- `packages/lair/src/storage.ts` (IndexedDB)
- `packages/lair/src/crypto.ts` (Ed25519, X25519, XSalsa20)

**Tests**:
- Key generation produces valid Ed25519 keys
- Sign/verify round-trip
- Encrypt/decrypt round-trip
- Keys persist across sessions (IndexedDB)

---

### Step 3: Authorization Mechanism

**Goal**: Implement user consent flow for page ↔ extension connections (like MetaMask).

**Dependencies**: Step 1, Step 2

**Sub-tasks**:
1. **3.1** Design permission model (per-domain, per-action)
2. **3.2** Create authorization request popup
3. **3.3** Implement permission storage (approved domains)
4. **3.4** Add permission check middleware to message handler
5. **3.5** Implement permission revocation UI
6. **3.6** Handle first-time connection prompts

**Key Files**:
- `packages/extension/src/popup/authorize.ts`
- `packages/extension/src/lib/permissions.ts`

**Tests**:
- Unauthorized domain is blocked
- Authorized domain can make calls
- Permission persists across sessions
- User can revoke permissions

---

### Step 4: hApp Context Creation

**Goal**: Create hApp contexts based on domain-served data.

**Dependencies**: Step 1, Step 2, Step 3

**Sub-tasks**:
1. **4.1** Define hApp context structure (domain, DNA hashes, agent key)
2. **4.2** Implement context storage (IndexedDB)
3. **4.3** Create context initialization flow from web page
4. **4.4** Associate agent keys with contexts
5. **4.5** Implement context listing and selection

**Key Files**:
- `packages/core/src/conductor/context.ts`
- `packages/core/src/conductor/storage.ts`

**Tests**:
- Context created for new domain
- Same domain reuses existing context
- Context persists across sessions

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
Step 1 (Extension Base)
    │
    ├──────────────────┐
    v                  v
Step 2 (Lair)      Step 3 (Auth)
    │                  │
    └──────┬───────────┘
           v
       Step 4 (hApp Context)
           │
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

## Requirements & Tradeoffs

1. Each step of the process must be built using test-driven development practices such that CI can confirm no regressions before merging a PR
2. Different portions of the plan, or even the same plan may be worked on from different workstations, so claude must be set up to pick up sessions where they were left off.
3. Perfect is the enemy of the good. This plan should not be implemented to the highest possible standard of efficiency or robustness, but rather in a way that allows for reaching the functionality goals in reasonable time, and iterating on quality goals over time.

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
