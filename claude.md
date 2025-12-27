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

### Step 5: WASM Execution with Mocked Host Functions ✓

**Goal**: Run hApp WASM with host functions that return mock data.

**Dependencies**: Step 4

**Reference**: `../holochain/crates/holochain/src/core/ribosome/host_fn/`

**Completed**:
- [x] **5.1** Set up WASM runtime - Browser-native WebAssembly API with compilation caching
- [x] **5.2** Define host function import interface - Registry pattern with auto-registration
- [x] **5.3** Implement info functions (4): agent_info, dna_info, zome_info, call_info
- [x] **5.4** Implement CRUD operations (5): create, get, update, delete, query
- [x] **5.5** Implement link operations (4): create_link, delete_link, get_links, count_links
- [x] **5.6** Implement utility functions (4): random_bytes, sys_time, trace, hash
- [x] **5.7** Implement signing functions (3): sign, sign_ephemeral, verify_signature
- [x] **5.8** Integration with background worker - handleCallZome() routes to ribosome

**Implementation Details**:
- **20 host functions** implemented (4 info + 4 utility + 3 signing + 5 CRUD + 4 links)
- Browser-native WebAssembly API (no external libraries)
- Module caching by DNA hash for performance
- MessagePack serialization via @msgpack/msgpack
- Real Ed25519 crypto via libsodium-wrappers (sign_ephemeral, verify_signature)
- Mock implementations for CRUD/links (Step 6 adds real persistence)
- Mock signatures for sign (Step 6+ adds Lair integration)

**Key Files**:
- `packages/core/src/ribosome/runtime.ts` (137 lines) - WASM compilation & caching
- `packages/core/src/ribosome/serialization.ts` (198 lines) - MessagePack & memory ops
- `packages/core/src/ribosome/index.ts` (108 lines) - callZome() entry point
- `packages/core/src/ribosome/host-fn/index.ts` (148 lines) - Registry with auto-init
- `packages/core/src/ribosome/host-fn/*.ts` (20 files) - Individual host functions
- `packages/extension/src/background/index.ts` - Updated handleCallZome() to route to ribosome
- `packages/extension/test/wasm-test.html` - Manual test page

**Tests**:
- ✅ 34 tests passing (13 runtime + 21 serialization)
- ✅ WASM compilation and caching verified
- ✅ MessagePack round-trip serialization working
- ✅ Host function registry initialized with 20 functions
- ⏳ Manual browser testing pending

**Notes**:
- CRUD operations return mock data (no source chain persistence yet)
- Link operations return empty arrays (no link storage yet)
- sign() uses deterministic mock signatures (Lair integration in later step)
- hash() uses placeholder algorithm (TODO: Blake2b)

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
6. **Avoiding Solution Loops**: When debugging persistent issues (especially serialization):
   - ALWAYS read the "Failed Solutions Archive" before proposing solutions
   - Document WHY a solution failed, not just WHAT failed
   - Before retrying a similar approach, explain how it differs from the failed attempt
   - Use the Explore agent to research Holochain's actual implementation before making assumptions
   - Add comprehensive logging to compare byte-level differences
   - DO NOT assume version incompatibilities without proof

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

## Failed Solutions Archive

> **Purpose**: This section documents serialization solutions that have been attempted and FAILED. Do NOT retry these approaches without a fundamentally different understanding of the root cause.

### Problem Statement

**Symptom**: Binary data (Uint8Array/ActionHash) returned from host functions gets double-encoded:
- Input: `{Ok: Uint8Array(39)}` → Serialized to 45 bytes with format `bin8(39, [hash])`
- WASM output: 47 bytes with format `bin8(41, bin8(39, [hash]))`
- The inner `bin8(39)` wrapper gets re-wrapped in `bin8(41)`
- Rust receives `[196, 39, ...]` (msgpack bin8 marker) instead of hash bytes

**Root Cause (Current Understanding)**: The ExternIO double-encoding pattern in background/index.ts:
```javascript
// First encode: parameter → msgpack bytes
const paramBytes = new Uint8Array(encode(normalizedPayload));
// Second encode: bytes → msgpack binary (wraps in another bin8)
const payloadBytes = new Uint8Array(encode(paramBytes));
```

### ❌ Failed Solution #1: msgpack-bridge WASM Module

**Attempted**: Built a separate WASM-based serialization bridge using Rust's `rmpv` library to ensure bit-for-bit compatibility with Holochain's msgpack encoding.

**Why It Failed**:
- Created `packages/msgpack-bridge/` with Rust codec using `rmpv` 1.3 (same version as Holochain)
- Compiled to WASM with wasm-pack
- Added initialization complexity for service workers
- **Result**: The double-encoding issue persisted even with Rust codec
- **Root Cause Not Addressed**: Using the same codec doesn't solve the ExternIO wrapping pattern issue

**Commit**: 77fab6a - "feat: add serialization bridge solutions (broken)"

**Lessons Learned**:
- The issue is NOT codec incompatibility between @msgpack/msgpack and rmp-serde
- The issue is NOT about which library does the encoding
- The issue IS about how data is wrapped/unwrapped for ExternIO format

### ❌ Failed Solution #2: Removing Double-Encoding

**Attempted**: Removed the second `encode()` call to eliminate double-wrapping.

**Why It Failed**:
- WASM expects ExternIO format which requires specific byte wrapping
- Removing the wrapper breaks the calling convention
- HDK on the WASM side expects a specific format

**Lessons Learned**:
- Cannot arbitrarily change the ExternIO format without coordinating with WASM-side expectations
- The HDK and host function interface has a contract that must be honored

### ❌ Failed Solution #3: Converting Uint8Arrays to Plain Arrays

**Attempted**: Convert Uint8Array to regular JavaScript arrays before encoding to avoid msgpack binary type.

**Why It Failed**:
- msgpack treats arrays differently than binary data
- Resulted in different encoding format that WASM couldn't parse
- Lost semantic meaning of "this is binary data"

**Lessons Learned**:
- Type semantics matter - binary data vs array of numbers are different
- msgpack format must match what Rust's serde expects

### ❌ Failed Solution #4: Double-Decode Workaround

**Attempted**: Add extra decode step on the receiving end to unwrap double-encoded data.

**Why It Failed**:
- Band-aid solution that doesn't address root cause
- Breaks for data that's correctly single-encoded
- Creates asymmetry in the serialization pipeline

**Lessons Learned**:
- Workarounds create more complexity than they solve
- Need to fix the encoding side, not add hacks on decoding side

### ❌ Failed Solution #5: Removing Result Wrapper from serializeResult (Attempted 3+ Times)

**Attempted**: Modified `serializeResult()` in `packages/core/src/ribosome/serialization.ts` to return raw data instead of wrapping in `{Ok: data}`.

**Original code**:
```typescript
export function serializeResult(
  instance: WebAssembly.Instance,
  data: unknown
): bigint {
  // Wrap in Result::Ok - HDK expects Result<T, WasmError>
  const result = { Ok: data };
  const { ptr, len } = serializeToWasm(instance, result);
  return createI64Result(ptr, len);
}
```

**Failed change**:
```typescript
export function serializeResult(
  instance: WebAssembly.Instance,
  data: unknown
): bigint {
  // WRONG: Removed wrapper, serialized raw data
  const { ptr, len } = serializeToWasm(instance, data);
  return createI64Result(ptr, len);
}
```

**Why It Was Proposed**:
- Byte-level analysis (investigations/byte-comparison.md) showed double-wrapping occurs: `bin8(41, bin8(39, hash))`
- Logical reasoning: "If data gets double-wrapped, remove one wrapper layer"
- Observation: Host function returns `{Ok: Uint8Array(39)}` → 45 bytes, but WASM outputs 47 bytes with extra wrapper
- Assumption: The {Ok: ...} wrapper at the host function level causes the double-wrapping

**Why It Failed**:
- **HDK explicitly requires Result<T, WasmError> from host functions**
- Error message when attempted: `"invalid type: sequence, expected \`Ok\` or \`Err\`"`
- ALL 7 zome test functions fail immediately with deserialization errors
- The WASM guest code expects to deserialize Result types from host function returns
- This is part of the Holochain host function contract - host functions MUST return Result

**Evidence from Holochain Source**:
- Host functions in Holochain conductor return `Result<T, WasmError>`
- HDK's host function imports expect Result wrapper
- The ribosome deserializes host function returns as Result types

**Commit (Reverted)**: cb0776c - "WIP: Step 5.5 - msgpack serialization double-encoding issue"

**Lessons Learned**:
- **The {Ok: ...} wrapper is NOT optional** - it's a required part of the host function contract
- Logical reasoning about "remove one wrapper" fails because it ignores protocol requirements
- The double-wrapping issue must be solved WHILE maintaining the Result wrapper
- This solution has been attempted **at least 3 times** across multiple sessions, proving the need for this archive
- The byte-level analysis proved the encoding libraries are correct, so the issue is in the data flow, not the wrapper itself

### ❌ Failed Solution #6: ExternIO Double-Encoding for WASM Boundary

**Attempted**: Implemented ExternIO-style double-encoding/decoding based on Holochain's ExternIO type:
- Added `serializeExternIO()` and `deserializeExternIO()` helper functions
- Double-encode: `encode(encode(data))` to create `bin8([msgpack bytes])`
- Double-decode: `decode(decode(bytes))` to unwrap `bin8` then decode inner msgpack
- Applied to various WASM boundary crossings (zome inputs, outputs, host function returns)

**Why It Was Proposed**:
- Found ExternIO in Holochain source: `#[serde(with = "serde_bytes")]` wraps Vec<u8> in msgpack bin8
- ExternIO::encode() does: data → msgpack → Vec<u8> → serialize → bin8 wrapper
- Assumed this pattern applied to all WASM boundary crossings
- Logs showed zome functions returning 47 bytes (potential bin8 wrapper)

**Why It Failed**:
1. **Zome function inputs**: Applied ExternIO double-encoding, got "Offset is outside the bounds of the DataView"
   - Error indicated WASM not expecting double-encoded input
   - Reverted to single encoding (plain msgpack)

2. **Host function returns**: Applied ExternIO double-encoding, got WASM error:
   ```
   bytes = [196, 98, 129, 162, 79, 107, ...]
   Deserialize("invalid value: byte array, expected `Ok` or `Err`")
   ```
   - WASM saw bin8 (byte array) when expecting map (Result type)
   - HDK expects to deserialize Result directly, not unwrap bin8 first
   - Reverted to single encoding

3. **Zome function outputs**: Applied ExternIO double-decoding, got "Offset is outside the bounds of the DataView"
   - Indicates zome functions NOT returning ExternIO-wrapped data
   - Reverted to single decoding

**Evidence**:
- Testing showed only plain msgpack works (no ExternIO at any boundary)
- 6/7 test functions work with plain msgpack
- Only `get_test_entry` fails, but with different error (BadSize, not ExternIO-related)

**Commits**:
- ExternIO implementation: (uncommitted, reverted)
- Helper functions remain in serialization.ts but unused

**Lessons Learned**:
- ExternIO is NOT used at the WASM boundaries we're implementing
- ExternIO may be specific to certain Holochain contexts (conductor ↔ WASM) not applicable here
- The test zome may be compiled without ExternIO expectations
- Cannot assume Holochain source code patterns apply without testing
- "Offset is outside the bounds of the DataView" = strong signal of wrong encoding approach
- WASM error messages about deserialize types are diagnostic: "expected X, got Y" reveals format mismatch

**Correct Approach**:
- Zome inputs: Plain msgpack (single encode)
- Zome outputs: Plain msgpack (single decode)
- Host function inputs: Plain msgpack (single decode)
- Host function returns: Plain msgpack {Ok: data} (single encode)

**Remaining Issue**:
The original double-wrapping problem persists - `create_test_entry` returns Uint8Array(41) with bin8 wrapper instead of Uint8Array(39) raw hash. This is NOT solved by ExternIO approach.

### 🔍 What We Know Works

1. **Simple types** (numbers, strings, booleans, objects with primitives) serialize correctly
2. **Chrome message passing normalization** (normalizeUint8Arrays) correctly handles Uint8Array → object conversion
3. **msgpack round-trip** for non-binary data works fine
4. **WASM compilation and execution** works correctly
5. **Host function registry** and calling mechanism works

### 🔍 What Doesn't Work

1. **Binary data in host function returns** - Gets double-encoded when returning ActionHash/EntryHash
2. **Nested Uint8Arrays** - When wrapped in Result types like `{Ok: Uint8Array}`

### 📚 ExternIO Deep Dive - THE ACTUAL CONTRACT

**Source**: `/home/eric/code/metacurrency/holochain/holochain/crates/holochain_integrity_types/src/zome_io.rs`

ExternIO is Holochain's boundary type for all data crossing the WASM boundary:

```rust
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(transparent)]
#[repr(transparent)]
pub struct ExternIO(#[serde(with = "serde_bytes")] pub Vec<u8>);

impl ExternIO {
    pub fn encode<I>(input: I) -> Result<Self, SerializedBytesError>
    where I: serde::Serialize + std::fmt::Debug,
    {
        Ok(Self(holochain_serialized_bytes::encode(&input)?))
    }

    pub fn decode<O>(&self) -> Result<O, SerializedBytesError>
    where O: serde::de::DeserializeOwned + std::fmt::Debug,
    {
        holochain_serialized_bytes::decode(&self.0)
    }
}
```

**KEY INSIGHTS**:

1. **`#[serde(with = "serde_bytes")]`** - This annotation tells serde to treat the Vec<u8> as raw bytes, NOT as a sequence
   - When serialized with msgpack, it becomes `bin8`/`bin16`/`bin32` format
   - When deserialized, it expects msgpack binary format

2. **ExternIO.encode() ALREADY does msgpack encoding** - The input data gets msgpack-encoded into bytes, then wrapped in ExternIO

3. **The Double-Encoding Pattern IS INTENTIONAL**:
   ```
   Data (e.g., ActionHash)
     → msgpack encode (inside ExternIO.encode())
     → Vec<u8> bytes
     → ExternIO(Vec<u8>)
     → msgpack encode again (when ExternIO itself is serialized)
     → msgpack bin8 wrapper around the inner msgpack bytes
   ```

4. **On the WASM side**, when a function returns `ExternIO`:
   - The return value is ALREADY msgpack-encoded data wrapped in ExternIO
   - The ExternIO itself gets serialized as msgpack binary
   - The host receives: `bin8(length, [inner_msgpack_bytes])`

5. **For zome calls INPUT**:
   - Web-page calls with payload (e.g., `{foo: "bar"}`)
   - Extension should: `ExternIO.encode(payload)` equivalent in TypeScript
   - This means: `encode(payload)` → bytes → then wrap those bytes as msgpack binary

6. **For host function RETURN values**:
   - Host function has data (e.g., `{Ok: ActionHash}`)
   - Host must: `ExternIO.encode(data)` equivalent
   - Return to WASM as i64 (pointer + length)
   - WASM receives msgpack bytes that it can decode

**THE CRITICAL QUESTION**: Is our TypeScript implementation correctly mimicking ExternIO's double-encoding?

Current implementation in `background/index.ts`:
```javascript
// Encode the zome parameter
const paramBytes = new Uint8Array(encode(normalizedPayload));
// Wrap in ExternIO format by encoding the bytes again
const payloadBytes = new Uint8Array(encode(paramBytes));
```

**Potential Issue**: The second `encode(paramBytes)` treats the Uint8Array as msgpack binary type, but does it match exactly what `#[serde(with = "serde_bytes")]` produces?

**Test This**: Compare byte-for-byte:
1. Rust: `ExternIO::encode(data)` → serialize → what bytes?
2. TypeScript: `encode(encode(data))` → what bytes?
3. Do they match?

### 🧬 Meta-Analysis: The msgpack-bridge Back-and-Forth

**WHY does the msgpack-bridge keep being reconsidered, then rejected, then reconsidered again?**

This pattern reveals a deeper issue with how Claude approaches the problem:

**The Loop**:
1. Claude sees double-encoding issue
2. Claude suspects @msgpack/msgpack vs rmp-serde incompatibility
3. Claude builds msgpack-bridge WASM module using Rust's rmpv
4. Claude tests and sees problem persists
5. Claude realizes it's not about the codec
6. Claude reverts to @msgpack/msgpack
7. **[Time passes, new session starts]**
8. Claude sees double-encoding issue again...
9. **GOTO step 2** (loop!)

**Root Cause of the Loop**:
- **Symptom focus** instead of understanding the protocol
- **Assumption** that matching Rust's library = matching behavior
- **Missing**: Deep understanding of ExternIO contract (now documented above!)
- **Missing**: Byte-level comparison of what Holochain actually produces vs what we produce

**The msgpack-bridge IS technically correct** - using rmpv WILL produce identical bytes to Holochain for the SAME operations. But:
- The complexity of WASM initialization in service workers is HIGH
- The debugging is HARDER (binary WASM vs readable TypeScript)
- **IT DOESN'T SOLVE THE ROOT ISSUE** which is about understanding the ExternIO protocol

**When to Consider msgpack-bridge**:
✅ **YES** - If byte-level testing proves @msgpack/msgpack produces different bytes than rmpv for the same input
✅ **YES** - If we find edge cases where JavaScript msgpack != Rust msgpack (e.g., handling of Map vs Object)

❌ **NO** - If we haven't done byte-level comparison first
❌ **NO** - If we don't understand what ExternIO expects
❌ **NO** - As a first attempt before understanding the protocol

**Decision Framework for Future Sessions**:

Before considering msgpack-bridge again, MUST complete this checklist:
- [ ] Have we documented the exact bytes Holochain produces for test cases?
- [ ] Have we documented the exact bytes our TypeScript produces?
- [ ] Do the bytes differ? If YES, where exactly?
- [ ] Have we tested with actual Holochain WASM to see what it expects/produces?
- [ ] Can we explain WHY the bytes differ (not just that they do)?
- [ ] Have we tried adjusting the TypeScript encoding to match?
- [ ] Have we exhausted simpler solutions?

**ONLY AFTER** answering these questions should msgpack-bridge be reconsidered.

**The Real Solution Likely Involves**:
- Understanding how Holochain's HDK expects data formatted
- Matching the exact byte sequence for ExternIO serialization
- Potentially adjusting how we handle Uint8Array in TypeScript
- NOT necessarily using the same Rust library

### 🎯 Next Steps Guidance

Before attempting a new solution, ensure you can answer:
1. **Why did the previous approaches fail?** (Understand root cause, not symptoms)
2. **What is the ExternIO format contract?** ✅ NOW DOCUMENTED ABOVE
3. **How does Holochain's conductor handle this?** (Study real_ribosome.rs implementation)
4. **What does the HDK expect to receive?** (Trace the WASM-side code)
5. **Does TypeScript's msgpack.encode(Uint8Array) produce the same bytes as Rust's `#[serde(with = "serde_bytes")]`?**

**Required Testing**:
- Create a test Rust program that serializes ExternIO with different payloads
- Capture the exact bytes produced
- Compare with TypeScript implementation byte-for-byte
- Test specifically with `{Ok: Uint8Array(39)}` (ActionHash)

**DO NOT**:
- Retry msgpack version changes without understanding ExternIO contract ✅ NOW UNDERSTOOD
- Add more encoding/decoding layers without fixing root cause
- Assume the issue is codec compatibility
- Make changes without comprehensive logging to compare byte sequences

---

## Serialization Testing Strategy

### Overview

Serialization bugs are notoriously difficult because:
- Small byte differences cause failures
- Errors manifest far from the root cause
- "Works in tests, fails in production" scenarios

This testing strategy ensures serialization changes are validated thoroughly.

### Level 1: Unit Tests (Already Implemented)

**Location**: `packages/core/src/ribosome/serialization.test.ts` (21 tests)

**Coverage**:
- Round-trip encoding/decoding for primitive types
- Uint8Array handling
- WASM memory operations (read/write)
- Result type wrapping `{Ok: T}` and `{Err: E}`

**When to Run**: After ANY change to serialization.ts
**Expected**: ALL 21 tests must pass

### Level 2: Byte-Level Comparison Tests (NEEDS IMPLEMENTATION)

**Purpose**: Verify our TypeScript produces identical bytes to Holochain's Rust

**Implementation Approach**:

1. **Create Rust test program** (`test-serialization/src/main.rs`):
   ```rust
   use holochain_integrity_types::prelude::*;
   use holochain_serialized_bytes::prelude::*;

   fn main() {
       // Test case 1: Simple object
       let data = json!({"foo": "bar"});
       let extern_io = ExternIO::encode(&data).unwrap();
       let bytes = rmp_serde::to_vec(&extern_io).unwrap();
       println!("TEST_CASE_1: {:?}", bytes);

       // Test case 2: ActionHash in Result
       let hash = ActionHash::from_raw_bytes(vec![0u8; 39]);
       let result: Result<ActionHash, ()> = Ok(hash);
       let extern_io = ExternIO::encode(&result).unwrap();
       let bytes = rmp_serde::to_vec(&extern_io).unwrap();
       println!("TEST_CASE_2: {:?}", bytes);

       // Test case 3: Nested structure
       // ... more test cases
   }
   ```

2. **Capture Rust output**:
   ```bash
   cargo run > rust-bytes.txt
   ```

3. **Create TypeScript comparison test**:
   ```typescript
   import { encode } from '@msgpack/msgpack';

   describe('Byte-level compatibility with Holochain', () => {
     it('matches Rust for simple object', () => {
       const data = {foo: 'bar'};
       const paramBytes = encode(data);
       const externIOBytes = encode(paramBytes);

       // Expected from Rust test program
       const expected = [196, 131, 161, 102, ...]; // bytes from rust-bytes.txt
       expect(Array.from(externIOBytes)).toEqual(expected);
     });

     it('matches Rust for ActionHash in Result', () => {
       const hash = new Uint8Array(39); // all zeros
       const result = {Ok: hash};
       const paramBytes = encode(result);
       const externIOBytes = encode(paramBytes);

       const expected = [...]; // from TEST_CASE_2
       expect(Array.from(externIOBytes)).toEqual(expected);
     });
   });
   ```

4. **If bytes DON'T match**: Document the differences and investigate why
5. **If bytes DO match**: The issue is elsewhere (not encoding, maybe decoding or WASM interface)

### Level 3: Integration Tests with Real WASM (NEEDS IMPLEMENTATION)

**Purpose**: Verify the entire pipeline works with actual Holochain WASM

**Prerequisites**:
- A simple Holochain zome compiled to WASM
- Zome functions that return ActionHash, EntryHash, etc.

**Test Setup**:
```javascript
// test-zomes/simple/src/lib.rs
use hdk::prelude::*;

#[hdk_extern]
fn get_my_agent() -> ExternResult<AgentPubKey> {
    Ok(agent_info()?.agent_latest_pubkey)
}

#[hdk_extern]
fn echo_hash(hash: ActionHash) -> ExternResult<ActionHash> {
    Ok(hash)
}
```

**Compile**:
```bash
cargo build --release --target wasm32-unknown-unknown
```

**Integration Test**:
```typescript
import { callZome } from './ribosome';

describe('Real WASM Integration', () => {
  it('returns AgentPubKey from zome', async () => {
    const result = await callZome({
      dnaHash,
      zomeName: 'simple',
      fnName: 'get_my_agent',
      payload: null,
    });

    expect(result).toHaveProperty('Ok');
    expect(result.Ok).toBeInstanceOf(Uint8Array);
    expect(result.Ok.length).toBe(39);
  });

  it('round-trips ActionHash through zome', async () => {
    const inputHash = new Uint8Array(39).fill(42);
    const result = await callZome({
      dnaHash,
      zomeName: 'simple',
      fnName: 'echo_hash',
      payload: inputHash,
    });

    expect(result.Ok).toEqual(inputHash);
  });
});
```

### Level 4: End-to-End Browser Tests (MANUAL)

**Purpose**: Verify serialization in real browser environment

**Test Page**: `packages/extension/test/wasm-test.html` (already exists)

**Manual Test Cases**:
1. Load extension in Chrome
2. Install hApp with real WASM
3. Call zome function that returns AgentPubKey
4. Verify console shows correct deserialized value (not double-encoded)
5. Call zome function that creates entry and returns ActionHash
6. Verify ActionHash is correct format

### Test-Driven Development Flow

When fixing serialization issues:

1. **Reproduce** - Create a failing test that demonstrates the bug
2. **Isolate** - Determine which level the bug occurs (unit/byte/integration/e2e)
3. **Compare** - If byte-level, compare with Rust output
4. **Fix** - Make minimum change to fix the specific issue
5. **Verify** - All levels of tests pass
6. **Commit** - With clear explanation of what was wrong and how it was fixed

### Debugging Helpers

**Add to serialization.ts**:
```typescript
export function debugEncode(data: any, label: string): Uint8Array {
  console.log(`[${label}] Input:`, data);
  console.log(`[${label}] Input type:`, typeof data, Array.isArray(data) ? 'array' : '');
  const bytes = encode(data);
  console.log(`[${label}] Encoded length:`, bytes.length);
  console.log(`[${label}] First 20 bytes:`, Array.from(bytes.slice(0, 20)));
  console.log(`[${label}] Decoded back:`, decode(bytes));
  return new Uint8Array(bytes);
}
```

**Use in ribosome**:
```typescript
const paramBytes = debugEncode(normalizedPayload, 'PARAM');
const payloadBytes = debugEncode(paramBytes, 'EXTERN_IO');
```

This produces detailed logs for comparing with Rust output.

---

## Session Continuity

To support picking up work across sessions:

1. **This file** (`claude.md`) serves as the source of truth for project state
2. **Git commits** should be atomic and well-described
3. **TODO comments** in code should reference step numbers (e.g., `// TODO(Step 5.3): implement agent_info`)
4. **Each step** should be completable in isolation once dependencies are met
5. **Tests** verify step completion - all tests pass = step complete
