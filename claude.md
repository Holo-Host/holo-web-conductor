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

### Step 5.6: Complete host functions and data-types ✅ COMPLETE (2025-12-27)

**Goal**: flesh out other key host functions, and gather data types to do so

**Dependencies**: Steps 5 and 5.5

**Status**: ✅ **COMPLETE** - 40/40 tests passing, emit_signal implemented, type definitions added, manual testing complete

**What was accomplished**:
- ✅ Created 22 TypeScript type definitions for host function I/O (ChainTopOrdering, GetOptions, CreateInput, etc.)
- ✅ Implemented emit_signal host function with signal collection in CallContext
- ✅ Updated test-zome with 6 new test functions (emit_signal_test, query_test, link operations)
- ✅ Added 6 automated unit tests for emit_signal
- ✅ Created integration test suite (15 tests skipped due to known serialization issue)
- ✅ Enhanced manual testing UI with 6 new test buttons
- ✅ Fixed ZomeCallResult handling and Buffer reference issues
- ✅ Manual testing verified 9 functions working (link operations expected to fail without DNA manifest)

**Sub-tasks**:
1. **5.6.1**: ✅ research the key host functions in the holochain repo (../holochain), which are:
   1.  ✅ any that changes state (i.e. CRUD on entries and links)
   2.  ✅ all functions that retrieve state data (get, get_links and all must_get)
   3.  ✅ emit_signal
2. **5.6.2**: ✅ find out which types are needed to either call these function or return information from them that aren't in ../holochain-client-js, and create typescript types for them
3. **5.6.3**: ✅ create mocks for these functions that return believable data with those types (already done in Step 5)
4. **5.6.4**: ✅ update the test-zome to exercise all of these functions
5. **5.6.5**: ✅ add any automated testing to ensure all of this is working
6. **5.6.6**: ✅ add manual testing affordances to the wasm-test UI with display functions so that hashes appear as B64 in the console results

**Known limitations**:
- Link operations require DNA manifest metadata (will work in Step 6+ with proper DNA handling)
- Integration tests skipped due to known double-encoding issue with binary data (documented in commit cb0776c)
- Signals collected but not yet broadcast to UI (TODO for future step)

---

### Step 5.7: .happ Bundle Support with DNA Manifest Integration ✅ COMPLETE (2025-12-28)

**Goal**: Add support for loading .happ bundles (instead of standalone WASM) to access DNA manifest metadata required for proper link/entry type resolution.

**Dependencies**: Step 5.6

**Status**: ✅ **COMPLETE** - 22/22 tests passing, bundle unpacking working, manifest data flowing to host functions, manual testing complete

**What was accomplished**:
- ✅ Implemented in-browser .happ bundle unpacking (gzip + msgpack, no hc CLI dependency)
- ✅ Created type definitions for AppManifest and DnaManifest (holochain_types compatible)
- ✅ Built bundle unpacker with proper error handling for malformed bundles
- ✅ Updated data structures to store and pass DNA manifests (DnaContext, CallContext, Storage)
- ✅ Rewrote installation flow to unpack .happ bundles and extract manifests
- ✅ Updated host functions (zome_info, create_link, get_links) to use manifest data
- ✅ Created proper .happ test bundle using hc CLI (test-zome packaged with manifests)
- ✅ Fixed critical bundle format discovery: manifests are msgpack objects, not YAML bytes
- ✅ Fixed ActionHash format issues in multiple host functions (create_link, delete_link, delete, update)
- ✅ Added update_test_entry and delete_test_entry functions to test zome
- ✅ Updated manual testing UI with Update Entry and Delete Entry buttons
- ✅ Added get_zome_info test function and UI button for inspecting manifest data
- ✅ Changed contextID from UUID to DNA hash (base64-encoded using encodeHashToBase64 from @holochain/client)
- ✅ Added get_details_test function and UI button for retrieving full record details
- ✅ Automated tests properly validate real bundle format

**Key Discovery**:
The Holochain `hc` CLI packs manifests as MessagePack-serialized objects, NOT as raw YAML bytes. The manifest is already parsed when extracted from msgpack. This was discovered during manual testing when automated tests initially used YAML strings.

**Sub-tasks**:
1. **5.7.1**: ✅ Add dependencies (pako for gzip, @msgpack/msgpack) and create bundle type definitions
2. **5.7.2**: ✅ Implement bundle unpacker (unpackHappBundle, unpackDnaBundle, createRuntimeManifest)
3. **5.7.3**: ✅ Update data structures for manifest storage (DnaContext, CallContext, StorableDnaContext)
4. **5.7.4**: ✅ Update installation flow (HappContextManager.installHapp, background handlers)
5. **5.7.5**: ✅ Update host functions to use manifest (zome_info uses manifest for zome_types)
6. **5.7.6**: ✅ Create test .happ bundle (happ.yaml, dna.yaml, pack.sh script)
7. **5.7.7**: ✅ Update manual testing UI to load .happ instead of standalone .wasm
8. **5.7.8**: ✅ Add automated tests (22 tests for bundle unpacking and manifest handling)
9. **5.7.9**: ✅ Fix bundle format issues discovered during manual testing
10. **5.7.10**: ✅ Fix ActionHash format in host functions (wrong prefix/size)
11. **5.7.11**: ✅ Add missing test functions (update_test_entry, delete_test_entry)
12. **5.7.12**: ✅ Add get_zome_info test function and UI button
13. **5.7.13**: ✅ Use DNA hash as contextID instead of UUID (using encodeHashToBase64 from @holochain/client)
14. **5.7.14**: ✅ Add get_details_test function and UI button

**Files Created** (~800 lines):
- `packages/core/src/types/bundle-types.ts` (200 lines) - Type definitions
- `packages/core/src/bundle/unpacker.ts` (245 lines) - Bundle unpacking
- `packages/core/src/bundle/unpacker.test.ts` (556 lines) - 22 automated tests
- `packages/core/src/bundle/index.ts` (2 lines) - Exports
- `packages/test-zome/happ.yaml` (17 lines) - hApp manifest
- `packages/test-zome/dna.yaml` (14 lines) - DNA manifest
- `packages/test-zome/pack.sh` (32 lines) - Build and pack script

**Files Modified** (~500 lines):
- `packages/core/package.json` - Added pako dependency
- `packages/core/src/index.ts` - Updated DnaContext, InstallHappRequest
- `packages/extension/src/lib/happ-context-storage.ts` - Added manifest storage
- `packages/core/src/ribosome/call-context.ts` - Added dnaManifest field
- `packages/core/src/ribosome/index.ts` - Pass manifest in ZomeCallRequest
- `packages/extension/src/lib/happ-context-manager.ts` - Unpack bundles on install, use DNA hash as contextID, use @holochain/client encodeHashToBase64
- `packages/extension/src/background/index.ts` - Updated INSTALL_HAPP, CALL_ZOME handlers
- `packages/core/src/ribosome/host-fn/zome_info.ts` - Use manifest for zome_types
- `packages/core/src/ribosome/host-fn/create_link.ts` - Fixed ActionHash prefix (0x29)
- `packages/core/src/ribosome/host-fn/delete_link.ts` - Fixed ActionHash size (39 bytes)
- `packages/core/src/ribosome/host-fn/delete.ts` - Fixed ActionHash size (39 bytes)
- `packages/core/src/ribosome/host-fn/update.ts` - Fixed ActionHash size (39 bytes)
- `packages/test-zome/src/lib.rs` - Added update_test_entry, delete_test_entry, get_zome_info, get_details_test
- `packages/extension/test/wasm-test.html` - Load .happ, added Update/Delete/ZomeInfo/GetDetails buttons

**Known Limitations**:
- Entry type extraction not yet implemented (empty entry_defs in zome_info)
- Link type extraction not yet implemented (placeholder link types)
- Link storage not implemented (create_link/get_links return mock data)
- Multi-zome DNA support deferred to Step 6
- DNA hash computation simplified (proper hashing with modifiers in Step 6)

**Next Steps** (Step 6):
- Parse entry types from integrity zome WASM
- Parse link types from integrity zome WASM
- Implement real link storage with type validation
- Implement proper DNA hash computation with modifiers
- Support multi-zome DNAs properly

---

### Step 6: Storage Infrastructure ⏳ IN PROGRESS

**Goal**: Build IndexedDB-based source chain storage layer with full CRUD for actions, entries, and links.

**Dependencies**: Steps 5.x

**Status**: ⏳ Partial - Storage layer complete, host function integration ongoing

**What was accomplished**:
- ✅ Created comprehensive TypeScript types for Holochain data structures (Action, Entry, Link, ChainHead)
- ✅ Implemented SourceChainStorage class with IndexedDB backend (4 stores: actions, entries, links, chainHeads)
- ✅ Added transaction support for atomic chain updates (critical for data integrity)
- ✅ Implemented session cache for synchronous WASM host function access
- ✅ Created utility function for action serialization (toHolochainAction) with proper format:
  - Internally tagged enum format (`{type: "Create", ...}`)
  - snake_case field names
  - Omits null/undefined fields (Holochain Option<T> expects omission, not nil)
  - Converts BigInt timestamps to Number for MessagePack
  - Converts 32-byte author to 39-byte prefixed AgentPubKey
- ✅ Updated host functions to use storage:
  - `create`, `get`, `update`, `delete`, `query` - full entry CRUD
  - `create_link`, `get_links`, `delete_link`, `count_links` - link operations
  - `agent_info` - returns real chain head
- ⏳ Ongoing: `get_details` serialization fixes (deferred)

**Sub-tasks**:
1. **6.1** ✅ Define data types - `packages/core/src/storage/types.ts` (~350 lines)
   - Action types (Create, Update, Delete, CreateLink, DeleteLink, DNA init actions)
   - StoredEntry, StoredRecord, ChainHead, Link, RecordDetails
   - Storable versions for IndexedDB (Uint8Array → number[] conversion)
2. **6.2** ✅ Implement SourceChainStorage class - `packages/core/src/storage/source-chain-storage.ts` (~1,200 lines)
   - IndexedDB schema with 4 stores and composite indexes
   - Transaction support for atomic updates
   - Session cache for synchronous WASM access
   - Chain head tracking per cell
   - CRUD operations for actions, entries, links
3. **6.3** ✅ Add transaction support - Modified in 6.2
   - `beginTransaction()`, `commitTransaction()`, `rollbackTransaction()`
   - All chain operations within a zome call are atomic
   - Prevents partial failures from corrupting chain
4. **6.4** ✅ Create storage module exports - `packages/core/src/storage/index.ts`
5. **6.5** ✅ Add unit tests - `packages/core/src/storage/source-chain-storage.test.ts` (~100 lines)
   - Chain head operations
   - Action storage and retrieval
   - Entry storage
   - Link storage and deletion

**Key Files Created** (~1,650 lines):
- `packages/core/src/storage/types.ts` (350 lines)
- `packages/core/src/storage/source-chain-storage.ts` (1,200 lines)
- `packages/core/src/storage/index.ts` (2 lines)
- `packages/core/src/storage/source-chain-storage.test.ts` (100 lines)

**Key Files Modified** (~400 lines):
- `packages/core/src/ribosome/host-fn/action-serialization.ts` (70 lines) - Shared action converter
- `packages/core/src/ribosome/host-fn/create.ts` - Use storage
- `packages/core/src/ribosome/host-fn/get.ts` - Use storage + toHolochainAction
- `packages/core/src/ribosome/host-fn/update.ts` - Use storage
- `packages/core/src/ribosome/host-fn/delete.ts` - Use storage
- `packages/core/src/ribosome/host-fn/query.ts` - Use storage + toHolochainAction
- `packages/core/src/ribosome/host-fn/create_link.ts` - Use storage
- `packages/core/src/ribosome/host-fn/get_links.ts` - Use storage + proper Link structure
- `packages/core/src/ribosome/host-fn/delete_link.ts` - Use storage
- `packages/core/src/ribosome/host-fn/count_links.ts` - Use storage
- `packages/core/src/ribosome/host-fn/agent_info.ts` - Return real chain head
- `packages/core/src/ribosome/host-fn/stubs.ts` - Real get_details (partial)
- `packages/core/src/index.ts` - Export storage module

**Tests**:
- ✅ Unit tests for storage layer passing
- ✅ Manual testing in browser shows persistence working
- ✅ Entry CRUD operations persist and retrieve correctly
- ✅ Link operations persist and query correctly
- ✅ Chain head tracking works

**Critical Discoveries**:
1. **Action Serialization Format**: Holochain uses internally tagged enums with snake_case:
   - Must use `{type: "Create", action_seq: 5, ...}` NOT `{actionType: "Create", actionSeq: 5, ...}`
   - Must omit fields when null/undefined (Option<T> expects omission, not nil)
   - Example: `prev_action` should be omitted entirely when None, not set to null
2. **Link Structure**: Complete Link type requires all fields:
   - `target`, `timestamp`, `tag`, `create_link_hash`, `base`, `author`, `zome_index`, `link_type`
   - `link_type` is newtype struct `LinkType(u8)` - serializes as single number, not array
3. **BigInt Handling**: MessagePack doesn't support BigInt - must convert timestamps to Number
4. **Agent PubKey Format**: Must convert 32-byte keys to 39-byte prefixed format for Holochain

**Known Limitations**:
- `get_details` has serialization issues with action format (deferred to later)
- Hash computation is simplified (random) - proper Blake2b hashing deferred
- Signatures are mock - Lair integration deferred
- Transaction support works but not extensively tested with failures

---

### Step 6.5: Host Function Integration ⏳ IN PROGRESS

**Goal**: Wire up existing host functions to use the new storage layer, replacing mock implementations with real persistence.

**Dependencies**: Step 6 (Storage Infrastructure)

**Status**: ⏳ Mostly complete - Entry/link operations working, get_details deferred

**What was accomplished**:
- ✅ Wrapped all zome calls in storage transactions for atomic updates
- ✅ Updated entry operations (create, get, update, delete, query) to use SourceChainStorage
- ✅ Updated link operations (create_link, get_links, delete_link, count_links) to use storage
- ✅ Fixed action serialization across all host functions (internally tagged enum format)
- ✅ Fixed Link structure to include all required fields (base, author, zome_index, link_type)
- ✅ Updated agent_info to return real chain head from storage
- ⏳ get_details partially working (known serialization issues, deferred)

**Sub-tasks**:
1. **6.5.0** ✅ Wrap zome calls in transactions - `packages/core/src/ribosome/index.ts`
   - `beginTransaction()` before WASM execution
   - `commitTransaction()` on success
   - `rollbackTransaction()` on error
   - Ensures atomic chain updates
2. **6.5.1** ✅ Wire up entry operations - All using `SourceChainStorage.getInstance()`
   - `create.ts` - Store entry + action, update chain head
   - `get.ts` - Retrieve from cache, use toHolochainAction
   - `update.ts` - Create Update action with original references
   - `delete.ts` - Create Delete action
   - `query.ts` - Query actions from cache, use toHolochainAction
3. **6.5.2** ✅ Wire up link operations
   - `create_link.ts` - Store CreateLinkAction + Link record
   - `get_links.ts` - Query links, filter by type/tag, return proper structure
   - `delete_link.ts` - Mark link deleted, store DeleteLinkAction
   - `count_links.ts` - Count non-deleted links
4. **6.5.3** ⏳ Wire up get_details - Partial (serialization issues)
   - Uses `getDetailsFromCache()` for synchronous access
   - Returns Details with record + validation status + deletes + updates
   - Known issue: Action serialization format needs fixing
5. **6.5.4** ✅ Wire up agent_info - Returns real chain head
   - Queries `getChainHead()` from storage
   - Returns current sequence number and action hash
6. **6.5.5** ✅ Update host function signatures - Support async operations
   - Host functions can return `number | Promise<number>`
   - Pre-load chain data into session cache before WASM execution
   - Makes host functions synchronous from WASM perspective
7. **6.5.6** ⏳ Add test zome functions - For atomic operations testing
   - `create_entry_with_link` - Atomic entry + link creation
   - `create_entry_then_fail` - Test rollback behavior
8. **6.5.7** ✅ Integration testing - Manual testing in wasm-test.html
   - Create → Get round-trip verified
   - Link persistence verified
   - Update/Delete operations verified
   - Chain head tracking verified

**Files Modified**:
- `packages/core/src/ribosome/index.ts` - Transaction wrapping
- `packages/core/src/ribosome/host-fn/action-serialization.ts` - Shared serialization
- `packages/core/src/ribosome/host-fn/create.ts`
- `packages/core/src/ribosome/host-fn/get.ts`
- `packages/core/src/ribosome/host-fn/update.ts`
- `packages/core/src/ribosome/host-fn/delete.ts`
- `packages/core/src/ribosome/host-fn/query.ts`
- `packages/core/src/ribosome/host-fn/create_link.ts`
- `packages/core/src/ribosome/host-fn/get_links.ts`
- `packages/core/src/ribosome/host-fn/delete_link.ts`
- `packages/core/src/ribosome/host-fn/count_links.ts`
- `packages/core/src/ribosome/host-fn/stubs.ts`
- `packages/core/src/ribosome/host-fn/agent_info.ts`

**Tests**:
- ✅ Manual browser testing shows full persistence
- ✅ Entry CRUD verified working
- ✅ Link operations verified working
- ✅ Chain head updates correctly
- ⏳ Automated integration tests pending

**Known Issues**:
- `get_details` has action serialization format issues (will fix in future iteration)
- No automated tests for atomic rollback behavior
- Hash computation still uses random values (proper hashing deferred)

---
### Step 6.6: better integration testing

**Goal**: have automated integration tests that simulate/excersice the path of a web-page making requests of the extension, especially all the zome call tests where the a fix requires rebuilding the extension, reloading the web-page and clicking through verious setups as this is very time-consuming manually.

---
### Step 6.7: holochain validation

**Goal**: Add in holochain app validation when commiting entries


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

1. **This file** (`claude.md`) serves as the source of truth for project state
2. **Git commits** should be atomic and well-described
3. **TODO comments** in code should reference step numbers (e.g., `// TODO(Step 5.3): implement agent_info`)
4. **Each step** should be completable in isolation once dependencies are met
5. **Tests** verify step completion - all tests pass = step complete
