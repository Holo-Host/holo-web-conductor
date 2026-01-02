# Step 11: Synchronous SQLite Storage Layer - COMPLETE

**Completion Date**: 2026-01-01
**Status**: COMPLETE

## Summary

Replaced the IndexedDB + in-memory session cache pattern with SQLite WASM using OPFS (Origin Private File System) for synchronous durable storage. This eliminates the expensive `preloadChainForCell()` pattern that loaded the entire chain into memory before every zome call.

## Problem Solved

**Before**:
- Every zome call required `preloadChainForCell()` to load ENTIRE chain into memory
- Session cache was cleared after transaction commit
- Next zome call required full reload again
- O(n) startup cost per zome call where n = chain size

**After**:
- SQLite runs in dedicated worker with OPFS persistence
- Query on-demand instead of pre-loading
- Data is durably persisted when COMMIT returns
- No migration needed (no existing production data)

## Architecture

```
Background Service Worker
    ↓ (chrome.runtime.sendMessage)
Offscreen Document
    ↓ (postMessage)
Ribosome Worker (WASM + SQLite run together here)
    ↓ (sqlite3 WASM + opfs-sahpool VFS)
OPFS (Origin Private File System)
    ↓
Actual filesystem (durable storage)
```

**Key Design Decisions**:

1. **Single Worker for WASM + SQLite**: Rather than separate workers, the ribosome worker runs both WASM execution and SQLite. This enables synchronous host function calls without cross-worker communication overhead.

2. **opfs-sahpool VFS**: Uses `FileSystemSyncAccessHandle` directly without requiring nested workers or COOP/COEP headers. Regular OPFS VFS requires nested workers which fail in Chrome extensions.

3. **Network Calls via Offscreen**: Network requests are proxied back to the offscreen document for synchronous XHR (needed because workers cannot do sync XHR). Uses SharedArrayBuffer + Atomics for synchronous signaling.

4. **Result Unwrapping**: The offscreen document unwraps `{Ok: ...}` results and decodes inner msgpack values before sending to the page, matching the holochain-client API contract.

## Files Modified

### New/Significantly Changed

| File | Purpose |
|------|---------|
| `packages/extension/src/offscreen/ribosome-worker.ts` | Main worker with SQLite + WASM + DirectSQLiteStorage |
| `packages/extension/src/offscreen/index.ts` | Offscreen document - spawns worker, proxies network, unwraps results |
| `packages/extension/vite.config.ts` | Builds ribosome-worker.ts |
| `packages/core/src/storage/sqlite-schema.ts` | SQL schema definitions |

### Key Classes

**DirectSQLiteStorage** (ribosome-worker.ts):
- Implements `StorageProvider` interface
- Synchronous SQLite operations for all chain data
- Uses `toBytes()` helper for proper Uint8Array binding

**ProxyNetworkService** (ribosome-worker.ts):
- Implements `NetworkService` interface
- Proxies network requests to offscreen for sync XHR
- Uses SharedArrayBuffer + Atomics.wait for synchronous communication

## Technical Details

### SQLite Initialization with opfs-sahpool

```typescript
const poolUtil = await sqlite3.installOpfsSAHPoolVfs({
  name: 'opfs-sahpool',
  directory: '/fishy-data',
  initialCapacity: 10,
});
db = new poolUtil.OpfsSAHPoolDb('/fishy-chain.sqlite3');
```

### toBytes() Helper for SQLite Binding

SQLite WASM's bind() requires proper Uint8Array instances. The helper converts various byte array types:

```typescript
function toBytes(value: any): Uint8Array | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (Array.isArray(value) || (typeof value === 'object' && 'length' in value)) {
    return new Uint8Array(value);
  }
  return new Uint8Array(value);
}
```

### Result Unwrapping

The holochain-client API returns unwrapped values, not `{Ok: ...}`. Fixed in offscreen/index.ts:

```typescript
if ('Ok' in result) {
  const okValue = result.Ok;
  if (okValue instanceof Uint8Array) {
    unwrappedResult = decode(okValue);
  } else {
    unwrappedResult = okValue;
  }
}
```

## Issues Resolved

1. **"Unsupported bind() argument type: object"**: SQLite couldn't bind Uint8Array objects. Fixed with `toBytes()` helper.

2. **Field name mismatches**: Type enforcement improved by making `DirectSQLiteStorage implements StorageProvider` and using proper type imports.

3. **"this.network.isAvailable is not a function"**: `ProxyNetworkService` was missing required methods. Added all `NetworkService` interface methods.

4. **Result format mismatch**: Results showed `{Ok: "[64 bytes...]"}` instead of unwrapped values. Fixed by unwrapping Ok/Err in offscreen document.

5. **OPFS not persisting**: Regular OPFS VFS requires nested workers which fail in extensions. Fixed by using `opfs-sahpool` VFS.

## Test Results

All 79 tests passing in core package, 25 in lair package.

Manual verification:
- Chain persists across browser reloads (confirmed seq=9 chain)
- Links stored and retrieved correctly
- Create/Update/Delete operations work
- get_links returns proper results

## Known Limitations

1. **Warning messages at startup**: sqlite-wasm logs warnings when trying other VFS options before falling back. These are harmless:
   ```
   OPFS syncer: Error initializing OPFS asyncer. This might hurt performance and/or capacity
   ```

2. **Network fetch not yet connected**: `ProxyNetworkService.getRecordSync()` returns null (local-only mode). Network integration is separate work.

## Verification

To verify persistence is working:

1. Load the extension in Chrome
2. Run the profiles test page (create entry, refresh page)
3. Check console for: `[Ribosome Worker] opfs-sahpool installed, opening database...`
4. Check console for: `[Ribosome Worker] Database opened: /fishy-chain.sqlite3 (OPFS persistent)`
5. After refresh, check: `[Genesis] Chain head check result: seq=N` where N > 0

## What's NOT Changed

- The ribosome host function implementations remain the same
- The storage interface (StorageProvider) remains the same
- The network interface (NetworkService) remains the same
- Test files unchanged (use in-memory storage)
