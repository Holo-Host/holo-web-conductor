# Step 11: Synchronous SQLite Storage Layer

## Goal

Replace the current IndexedDB + in-memory session cache pattern with SQLite WASM using OPFS (Origin Private File System) for synchronous durable storage, eliminating the expensive full-chain reload required before every transaction.

**Current Problem:**
- Before each zome call: `preloadChainForCell()` loads ENTIRE chain into memory
- Session cache is cleared after transaction commit
- Next zome call requires full reload again
- O(n) startup cost per zome call where n = chain size

**Critical Requirement:**
- Data MUST be durably persisted when transaction COMMIT returns
- Otherwise: publish could happen before persist, causing chain forks on crash

**Solution:**
- Use official `@sqlite.org/sqlite-wasm` with **opfs-sahpool VFS**
- OPFS provides synchronous durable file I/O
- Data is on disk when COMMIT returns (no async persistence step)
- Query on-demand instead of pre-loading
- No migration needed (no existing production data)

---

## Key Constraints

1. **Host functions MUST be synchronous** - Return `bigint`, cannot use `await`
2. **Persistence MUST be synchronous** - COMMIT must durably persist before returning
3. **OPFS requires dedicated worker** - Not available in service workers
4. **Chrome MV3 compatible** - Offscreen document spawns worker for OPFS access

---

## Architecture

```
Background Service Worker
    ↓ (chrome.runtime.sendMessage)
Offscreen Document
    ↓ (postMessage)
Dedicated Worker (SQLite runs here)
    ↓ (sqlite3 WASM + opfs-sahpool VFS)
OPFS (Origin Private File System)
    ↓
Actual filesystem (durable storage)
```

**Why this architecture:**
- `FileSystemSyncAccessHandle` (for sync OPFS access) only works in dedicated workers
- Service workers cannot access OPFS synchronously
- Offscreen document spawns worker, relays messages
- opfs-sahpool VFS doesn't require COOP/COEP headers

---

## Implementation Plan

### Phase 1: Infrastructure Setup ✅ COMPLETE

**Goal**: Add official SQLite WASM and create worker infrastructure.

**Completed:**
- [x] Added `@sqlite.org/sqlite-wasm` dependency to packages/core
- [x] Added `sql.js` dev dependency for testing
- [x] Created SQLite schema: `packages/core/src/storage/sqlite-schema.ts`
- [x] Updated vite.config.ts to build sqlite-worker.ts

**Files created:**
- `packages/core/src/storage/sqlite-schema.ts` - SQL schema and prepared statements

---

### Phase 2: SQLite Worker Implementation ✅ COMPLETE

**Goal**: Create dedicated worker that runs SQLite with OPFS persistence.

**Completed:**
- [x] Created `sqlite-worker.ts` - Worker with SQLite + opfs-sahpool VFS
- [x] Created `sqlite-storage.ts` - Proxy class using Atomics.wait() for sync calls
- [x] Updated storage exports in `packages/core/src/storage/index.ts`

**Files created:**
- `packages/extension/src/offscreen/sqlite-worker.ts` - Dedicated worker
- `packages/core/src/storage/sqlite-storage.ts` - SQLiteStorage class

**Architecture implemented:**
- Worker runs SQLite with OPFS for durable storage
- SharedArrayBuffer + Atomics.wait() for synchronous communication
- All public methods on SQLiteStorage are synchronous
- COMMIT blocks until data is durably persisted

---

### Phase 3: Integration - Remove Pre-loading ⏳ PENDING

**Goal**: Update ribosome to use SQLiteStorage without pre-loading.

**Files to update:**
- `packages/core/src/ribosome/index.ts` - Remove preloadChainForCell
- `packages/core/src/ribosome/host-fn/create.ts` - Remove Promise checks
- `packages/core/src/ribosome/host-fn/update.ts`
- `packages/core/src/ribosome/host-fn/delete.ts`
- `packages/core/src/ribosome/host-fn/query.ts`
- `packages/core/src/ribosome/host-fn/get.ts`
- `packages/core/src/ribosome/host-fn/create_link.ts`
- `packages/core/src/ribosome/host-fn/delete_link.ts`
- `packages/core/src/network/cascade.ts`

---

### Phase 4: Testing ✅ COMPLETE

**Goal**: Ensure all existing tests pass with new storage backend.

**Completed:**
- [x] Created SQLite schema tests using sql.js (in-memory)
- [x] All 261 tests pass (157 core + 79 extension + 25 lair)
- [x] 15 new SQLite tests added

**Files created:**
- `packages/core/src/storage/sqlite-storage.test.ts` - 15 tests for schema and operations

---

### Phase 5: Cleanup ⏳ PENDING

**Goal**: Remove old IndexedDB storage code (after Phase 3 complete).

---

## Success Criteria

1. No `preloadChainForCell()` call before transactions
2. All existing tests pass (246+ tests)
3. Host functions work with synchronous storage access
4. Data durably persisted when COMMIT returns
5. Data persists across browser restarts
6. Performance improved for large chains
