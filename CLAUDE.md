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

---

## Requirements, Tradeoffs & Dev Instructions

0. When reporting on status, or asking questions don't add the emotional tags at the beginning and end of phrases, (you can tell you are doing this if there's an exclamation point at the end of the phrase/sentence).  Just code related information.
1. Each step of the process must be built using test-driven development practices such that CI can confirm no regressions before merging a PR
2. **User testing is required before commits**: After implementing features, user testing must be performed in a real browser environment before creating git commits. This ensures functionality works as expected.
3. Different portions of the plan, or even the same plan may be worked on from different workstations, so claude must be set up to pick up sessions where they were left off.
4. Perfect is the enemy of the good. This plan should not be implemented to the highest possible standard of efficiency or robustness, but rather in a way that allows for reaching the functionality goals in reasonable time, and iterating on quality goals over time.
5. Don't add claude co-authored/generated messages in commit descriptions
6. **Avoiding Solution Loops**: When debugging persistent issues (especially serialization):
   - ALWAYS read the "Failed Solutions Archive" before proposing solutions
   - Document WHY a solution failed, not just WHAT failed
   - Before retrying a similar approach, explain how it differs from the failed attempt
   - Use the Explore agent to research Holochain's actual implementation before making assumptions
   - Add comprehensive logging to compare byte-level differences
   - DO NOT assume version incompatibilities without proof
7. **Strong typing**: when possible allways use strong typeing in typescript, ESPECIALLY when serializing and deserializing accross WASM boundaries.  Look in Holochain code base for types and make typscript equivalents, paying atttention the the serde serialization method being used (which is generally internal, i.e. type: "name")
8. **Holochain reference sources**: We are using Holochain 0.6.  The source for this is local and lives at the same level as this repo. DO NOT USE .cargo files or web searches to research holochain, just look locally.
9. **Serialization Errors**: Make sure to look at TRACE output when trying to figure out serialization problems, the WASM will tell you what was wrong in that error message.

---

## Development Strategy

- **Trace full data flow** before deep-diving into any layer (Input → Encode → WASM → Decode → Transport → UI)
- **Check LESSONS_LEARNED.md** before any serialization work - failed solutions are archived there
- **Use ../holochain/ as canonical reference**, not web searches (docs may be outdated)
- **Measure first, code second** - capture byte-level output before making changes
- **Automated tests first**, manual browser testing only for final verification
- **Chrome message passing** loses Uint8Array types - convert to/from Array at boundaries

---

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

---

## Holochain Client Compatibility

### Web-App Development Constraint

Web-app developers building applications for this extension will use the standard **holochain-client-js** library (https://github.com/holochain/holochain-client-js). This project MUST maintain compatibility with those types and interfaces.

**Key Types** (all using `Uint8Array`):
- `AgentPubKey` - 39-byte Uint8Array
- `ActionHash` - 39-byte Uint8Array
- `EntryHash` - 39-byte Uint8Array
- `DnaHash` - 39-byte Uint8Array
- `CellId` - Tuple of `[DnaHash, AgentPubKey]`

**Call Signatures**:
```typescript
interface CallZomeRequest {
  cell_id: CellId;           // [DnaHash, AgentPubKey]
  zome_name: string;
  fn_name: string;
  provenance?: AgentPubKey;  // Uint8Array
  payload?: any;             // Msgpack-serializable data
}
```

**Critical Requirements**:
1. Hash types MUST remain as `Uint8Array` (not base64 strings or objects)
2. Return values from zome calls MUST match holochain-client-js expectations
3. `AppInfo` structure MUST follow the same schema as standard Holochain
4. Future shim layer will auto-detect extension context (no code changes needed in web-apps)

**Serialization Contract**:
- Data flow: Web-app (JS types) → Extension (Chrome messaging) → WASM (msgpack) → Host functions → Back through stack
- **Chrome messaging converts Uint8Arrays to objects** with numeric keys `{0: 1, 1: 2, ...}`
- Extension must normalize back to Uint8Array before processing
- WASM expects msgpack-encoded bytes in exact format used by Holochain's `holochain_serialized_bytes` crate

---

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

### Step 2.5: Lair UI Integration ✓

**Goal**: Add UI in extension popup for Lair key management before implementing web page authorization.

**Dependencies**: Step 2 (Lair client)

**Status**: COMPLETE

**Details**: See [STEPS/2.5_PLAN.md](./STEPS/2.5_PLAN.md)

---

### Step 3: Authorization Mechanism ✓

**Goal**: Implement user consent flow for page ↔ extension connections (like MetaMask).

**Dependencies**: Step 1, Step 2

**Status**: COMPLETE - 18 tests passing (9 PermissionManager + 9 AuthManager)

**Details**: See [STEPS/3_PLAN.md](./STEPS/3_PLAN.md)

---

### Step 4: hApp Context Creation ✓

**Goal**: Create hApp contexts based on domain-served data.

**Dependencies**: Step 1, Step 2, Step 3

**Status**: COMPLETE - 25 tests passing (12 storage + 13 manager)

**Details**: See [STEPS/4_PLAN.md](./STEPS/4_PLAN.md)

---

### Step 5: WASM Execution with Mocked Host Functions ✓

**Goal**: Run hApp WASM with host functions that return mock data.

**Dependencies**: Step 4

**Status**: COMPLETE - 34 tests passing (13 runtime + 21 serialization), 20 host functions implemented

**Details**: See [STEPS/5_PLAN.md](./STEPS/5_PLAN.md)

---

### Step 5.6: Complete Host Functions and Data Types ✓

**Goal**: Flesh out key host functions and gather data types to do so.

**Dependencies**: Steps 5 and 5.5

**Status**: COMPLETE (2025-12-27) - 40/40 tests passing, emit_signal implemented, 22 TypeScript type definitions added

**Details**: See [STEPS/5.6_PLAN.md](./STEPS/5.6_PLAN.md)

---

### Step 5.7: .happ Bundle Support with DNA Manifest Integration ✓

**Goal**: Add support for loading .happ bundles to access DNA manifest metadata required for proper link/entry type resolution.

**Dependencies**: Step 5.6

**Status**: COMPLETE (2025-12-28) - 22/22 tests passing, bundle unpacking working, manifest data flowing to host functions

**Details**: See [STEPS/5.7_PLAN.md](./STEPS/5.7_PLAN.md)

---

### Step 6: Storage Infrastructure ⏳ IN PROGRESS

**Goal**: Build IndexedDB-based source chain storage layer with full CRUD for actions, entries, and links.

**Dependencies**: Steps 5.x

**Status**: Mostly complete - Storage layer complete, host function integration complete except get_details

**Details**: See [STEPS/6_PLAN.md](./STEPS/6_PLAN.md)

---

### Step 6.5: Host Function Integration ⏳ IN PROGRESS

**Goal**: Wire up existing host functions to use the new storage layer, replacing mock implementations with real persistence.

**Dependencies**: Step 6 (Storage Infrastructure)

**Status**: Mostly complete - Entry/link operations working, get_details deferred

**Details**: See [STEPS/6_PLAN.md](./STEPS/6_PLAN.md) (combined with Step 6)

---

### ✅ Step 6.6: Automated Integration Testing (COMPLETE)

**Goal**: Have automated integration tests that simulate the web-page → extension → WASM flow, eliminating the manual reload/click testing loop.

**Status**: ✅ COMPLETE (2025-12-29)

**Details**: See [STEPS/6.6_PLAN.md](./STEPS/6.6_PLAN.md)
**Completion**: See [STEPS/6.6_COMPLETION.md](./STEPS/6.6_COMPLETION.md)

---

### Step 6.7: Test with profiles ✅ COMPLETE

**Goal**: Create a test page using the real profiles WASM to exercise the fishy browser extension with actual holochain-open-dev patterns:

     1. Add signal subscription support to the extension API
     2. Create a single-file test page with CDN imports
     3. Exercise create-profile and list-profiles functionality
     4. Validate extension works with real Holochain app patterns

**Status**: COMPLETE (2025-12-29) - Signal infrastructure added, profiles test page working, get_details fixed for UPDATE actions

**Completion**: See [STEPS/6.7_COMPLETION.md](./STEPS/6.7_COMPLETION.md)

---

### Step 7: Network Host Functions ✅ COMPLETE

**Goal**: Implement host functions that make real network requests via hc-http-gw.

**Dependencies**: Step 6.X

**Status**: COMPLETE (2026-01-01) - E2E network fetch working with cascade caching

**Sub-tasks**:
1. **7.1** ✅ Implement a query cascade for get that tries local chain first, network cache, and then makes network requests
2. **7.2** ✅ Replace mock network with network fetch from local test instance of hc-http-gw

**Key Files**:
- `packages/core/src/network/cascade.ts` - Cascade pattern implementation
- `packages/core/src/network/sync-xhr-service.ts` - Gateway network service
- `packages/core/src/ribosome/host-fn/get.ts` - Uses cascade for lookups

**Completion**: See [STEPS/7.2_COMPLETION.md](./STEPS/7.2_COMPLETION.md)

---

### Step 8: hc-http-gw Extensions

**Goal**: Extend hc-http-gw to support zero-arc node publish operations.

**Dependencies**: Step 7

**Reference**: `../hc-http-gw/src/`

**Sub-tasks**:
1. **8.1** Analyze current hc-http-gw endpoints
2. **8.2** Design publish endpoint for zero-arc nodes
3. **8.3** Implement `/publish` endpoint for committing to DHT
4. **8.4** Implement authentication for publish requests
5. **8.5** Handle publish responses in extension

**Key Files**:
- `../hc-http-gw/src/routes/publish.rs` (new)
- `packages/core/src/conductor/network.ts`

**Tests**:
- Publish request accepted by gateway
- Published data retrievable via get

---

### Step 9: Additional Holochain Features

**Goal**: Add Holochain other holochain features that make things more robust: app validation when committing entries;

**Sub-tasks**:
1. **9.1** Implement `get_agent_activity`
1. **9.1** Implement `must_get**`
1. **9.1** Implement validation callbacks


**Tests**:
- get agent activity works
- validation success and failure cases

### Step 9.5: Gateway Real-Time Connection for Remote Signals ✅ COMPLETE

**Goal**: Enable hc-http-gw to proxy signals from Holochain to browser extensions via WebSocket.

**Status**: COMPLETE (2025-12-31)

**Dependencies**: Step 7.2

**Sub-tasks** (all complete):
1. **Phase 1**: WebSocket Infrastructure (Gateway) - WebSocket route handler, message protocol, connection state machine
2. **Phase 2**: Agent Proxy Registration (Gateway) - AgentProxyManager for tracking browser agents
3. **Phase 3**: Signal Forwarding (Gateway) - Subscribe to app signals, forward to registered browser agents
4. **Phase 4**: Browser Integration (Extension) - WebSocketNetworkService, offscreen document wiring, background signal dispatch

**Key Files**:
- `../hc-http-gw-fork/src/routes/websocket.rs` - WebSocket upgrade handler
- `../hc-http-gw-fork/src/agent_proxy.rs` - AgentProxyManager
- `packages/core/src/network/websocket-service.ts` - WebSocket client
- `packages/extension/src/offscreen/index.ts` - Signal forwarding to background

**Tests**:
- 20 WebSocket handler tests (gateway)
- 13 agent proxy tests (gateway)
- 3 signal forwarding tests (gateway)
- 20 WebSocketNetworkService tests (extension)
- 8 offscreen integration tests (extension)

**Details**: See [STEPS/9.5_COMPLETION.md](./STEPS/9.5_COMPLETION.md)

---

### Step 9.6: Kitsune2 Remote Signal Forwarding ⏳ IN PROGRESS

**Goal**: Wire up kitsune2 in gateway so conductor agents can send `send_remote_signal` to browser agents.

**Status**: Planning Complete - Ready for Implementation

**Discovery**: Infrastructure is 90% built in hc-http-gw-fork:
- `src/kitsune_proxy.rs` - KitsuneProxy, ProxySpaceHandler (complete)
- `src/proxy_agent.rs` - ProxyAgent for browser agents (complete)
- `GatewayKitsune` manager (complete)
- **Missing**: Initialization in `bin/hc-http-gw.rs`

**Implementation Steps**:
1. Add `gateway_kitsune` param to `service.rs:with_auth()`
2. Parse `HC_GW_KITSUNE2_*` env vars in binary
3. Build `GatewayKitsune` when enabled
4. Create E2E test with SweetConductor

**Files to Modify**:
- `../hc-http-gw-fork/src/service.rs` - Add gateway_kitsune param
- `../hc-http-gw-fork/src/bin/hc-http-gw.rs` - Initialize GatewayKitsune
- `../hc-http-gw-fork/tests/remote_signal_e2e.rs` - NEW E2E test

**Tests**:
- E2E test: conductor agent sends signal, browser receives via WebSocket


---

### Step 10: Integration Testing

**Goal**: Test with existing Holochain hApps.

**Dependencies**: All previous steps

**Sub-tasks**:
1. **10.1** created updated version of @holochain/client that detects in-browser-extension context
2. **10.2** Test version of scaffold created forum app in this context
3. **10.3** Test version of kando in this context

---

### Step 11: Synchronous SQLite Storage Layer ✓

**Goal**: Replace IndexedDB + session cache with SQLite WASM using OPFS for synchronous durable storage, eliminating the expensive full-chain reload required before every transaction.

**Dependencies**: None (out-of-sequence optimization)

**Status**: COMPLETE (2026-01-01)

**Problem Solved**:
- Before each zome call: `preloadChainForCell()` loaded ENTIRE chain into memory
- O(n) startup cost per zome call where n = chain size
- Data now durably persisted when COMMIT returns

**Solution Implemented**:
- SQLite WASM with opfs-sahpool VFS for synchronous durable writes
- Ribosome Worker runs WASM + SQLite together (single worker, no cross-worker overhead)
- Network calls proxy through offscreen for sync XHR
- Result unwrapping for holochain-client API compatibility

**Key Files**:
- `packages/extension/src/offscreen/ribosome-worker.ts` - Main worker with SQLite + WASM
- `packages/extension/src/offscreen/index.ts` - Offscreen document, spawns worker

**Details**: See [STEPS/11_COMPLETION.md](./STEPS/11_COMPLETION.md)

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

## Serialization Debugging

> **⚠️ CRITICAL**: Before attempting ANY serialization fixes, read [LESSONS_LEARNED.md](./LESSONS_LEARNED.md)

This project has experienced extensive serialization debugging across multiple sessions. The most critical lessons learned are documented in `LESSONS_LEARNED.md`, which contains:

- **Meta-Lesson**: Why UI boundary decoding (not WASM encoding) was the actual fix
- **Failed Solutions Archive**: 6 attempted solutions that failed and why
- **Serialization Testing Strategy**: 4-level testing approach for validation

**Key Takeaway**: Hours were spent debugging encoding at the WASM boundary (ExternIO, msgpack-bridge, codec compatibility) when the actual issue was missing `decodeResult()` in the background script. The problem was "encoding tunnel vision" - focusing on how to encode parameters going TO WASM while missing that results FROM WASM needed explicit msgpack decoding before Chrome message passing.

**DO NOT** retry failed solutions without first understanding:
1. Why they failed (read the archive)
2. How your approach fundamentally differs
3. What evidence supports your new hypothesis

See [LESSONS_LEARNED.md](./LESSONS_LEARNED.md) for complete details.

---

## Session Continuity

To support picking up work across sessions:

1. **This file** (`CLAUDE.md`) serves as the source of truth for project plan and overall state
2. **SESSION.md** tracks the current step in progress with status and notes
3. **STEPX_PLAN.md** files contain detailed plans for each step (created before implementation)
4. **STEPX_COMPLETION.md** files contain completion notes for finished steps
5. **Git commits** should be atomic and well-described
6. **TODO comments** in code should reference step numbers (e.g., `// TODO(Step 5.3): implement agent_info`)
7. **Each step** should be completable in isolation once dependencies are met
8. **Tests** verify step completion - all tests pass = step complete

### File Structure

```
/
├── CLAUDE.md              # Main project plan (this file)
├── SESSION.md             # Current session state (current step only)
├── STEPX_PLAN.md          # Detailed plan for step X
├── STEPX_COMPLETION.md    # Completion notes for step X
└── LESSONS_LEARNED.md     # Serialization debugging lessons
```

### Workflow for Starting a New Step

1. **Create STEPX_PLAN.md** before implementation with detailed sub-tasks
2. **Update SESSION.md** to show the new current step
3. **Update CLAUDE.md** step status to "IN PROGRESS"

### Workflow for Completing a Step

When a step is complete:

1. **Create STEPX_COMPLETION.md** with:
   - Completion date and status
   - Summary of what was accomplished
   - Test results
   - Issues found and fixed
   - Key architectural decisions
   - Files created/modified
   - Known limitations

2. **Update SESSION.md**:
   - Update "Last Updated" date
   - Update "Current Step" to the next step
   - Add link to the new STEPX_COMPLETION.md in the "Completed Steps" section
   - Update the "Claude Context Prompt for Resuming"

3. **Update CLAUDE.md**:
   - Mark completed step with checkmark
   - Update step status to "COMPLETE"
   - Add any new sub-steps if the plan evolved

4. **Commit documentation**:
   - Include STEPX_COMPLETION.md, SESSION.md, and CLAUDE.md in the commit
   - Use commit message format: "docs: Step X complete"
