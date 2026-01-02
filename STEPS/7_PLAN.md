# Step 7: Network Host Functions - Implementation Plan

**Created**: 2025-12-29
**Updated**: 2025-12-29 (after research phase)
**Status**: Ready for Implementation
**Dependencies**: Step 6.x (Storage Infrastructure) - Complete

## Overview

Step 7 adds network data retrieval to fishy, implementing a "cascade" pattern similar to Holochain's `holochain_cascade` crate. Host functions like `get` will fetch data from local storage first, then fall back to network requests.

## Research Outcome (7.0 Complete)

**See**: [7_RESEARCH.md](./7_RESEARCH.md) for full analysis.

### Chosen Approach: Offscreen Document

| Aspect | Details |
|--------|---------|
| **Why** | Standard extension API, sync XHR works, no flags needed |
| **How** | Run WASM in offscreen document, host functions use sync XHR |
| **Testing** | Unit tests with mocks (Node.js), browser tests for integration |
| **Future** | Migrate to JSPI when standardized |

**Architecture**:
```
Web Page
    ↓ postMessage
Content Script
    ↓ chrome.runtime.sendMessage
Service Worker
    ↓ chrome.runtime.sendMessage
Offscreen Document                    ← WASM executes here
    ├─ host fn calls get(hash)
    │   └─ sync XHR to gateway        ← Network access here
    └─ returns result
```

## Implementation Sub-Tasks

### 7.0 Research (COMPLETE)

- ✅ 7.0.1 Offscreen Document spike: `spikes/offscreen-test/`
- ✅ 7.0.2 JSPI spike: `spikes/jspi-test/`
- ✅ 7.0.3 SharedArrayBuffer evaluation: `spikes/shared-array-buffer-notes.md`
- ✅ 7.0.4 Research findings: `7_RESEARCH.md`
- ✅ 7.0.5 Update this plan

### 7.1 Extension Architecture Update

Move WASM execution from service worker to offscreen document.

| Task | Description | Files |
|------|-------------|-------|
| 7.1.1 | Add offscreen permission to manifest | `packages/extension/manifest.json` |
| 7.1.2 | Create offscreen document HTML | `packages/extension/src/offscreen/offscreen.html` |
| 7.1.3 | Create offscreen document script | `packages/extension/src/offscreen/offscreen.ts` |
| 7.1.4 | Move WASM execution to offscreen | `packages/extension/src/offscreen/wasm-executor.ts` |
| 7.1.5 | Update background to proxy via offscreen | `packages/extension/src/background/index.ts` |
| 7.1.6 | Test extension still works | Manual browser test |

### 7.2 Network Abstraction Layer

| Task | Description | Files |
|------|-------------|-------|
| 7.2.1 | Create NetworkService interface | `packages/core/src/network/types.ts` |
| 7.2.2 | Implement MockNetworkService | `packages/core/src/network/mock-service.ts` |
| 7.2.3 | Implement SyncXHRNetworkService | `packages/core/src/network/sync-xhr-service.ts` |
| 7.2.4 | Create NetworkCacheStorage | `packages/core/src/storage/network-cache.ts` |
| 7.2.5 | Implement Cascade class | `packages/core/src/network/cascade.ts` |
| 7.2.6 | Write unit tests | `packages/core/src/network/*.test.ts` |

### 7.3 Host Function Integration

| Task | Description | Files |
|------|-------------|-------|
| 7.3.1 | Integrate cascade into ribosome | `packages/core/src/ribosome/index.ts` |
| 7.3.2 | Update get() for cascade | `packages/core/src/ribosome/host-fn/get.ts` |
| 7.3.3 | Update get_links() for cascade | `packages/core/src/ribosome/host-fn/get_links.ts` |
| 7.3.4 | Implement must_get_action() | `packages/core/src/ribosome/host-fn/must_get_action.ts` |
| 7.3.5 | Implement must_get_entry() | `packages/core/src/ribosome/host-fn/must_get_entry.ts` |
| 7.3.6 | Write integration tests | `packages/core/src/ribosome/network-integration.test.ts` |

## Detailed Design

### Offscreen Document Architecture

```typescript
// packages/extension/src/offscreen/offscreen.ts

import { callZome } from '@anthropic/fishy-core/ribosome';
import { SyncXHRNetworkService } from '@anthropic/fishy-core/network';

// Register message handler
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  if (message.type === 'CALL_ZOME') {
    // Configure network service to use sync XHR
    const networkService = new SyncXHRNetworkService(message.gatewayUrl);

    // Execute zome call (host functions can now make sync network calls)
    callZome({
      ...message.request,
      networkService,
    }).then(result => {
      sendResponse({ success: true, result });
    }).catch(error => {
      sendResponse({ success: false, error: error.message });
    });

    return true; // Keep channel open
  }
});
```

### SyncXHRNetworkService

```typescript
// packages/core/src/network/sync-xhr-service.ts

export class SyncXHRNetworkService implements NetworkService {
  constructor(private gatewayUrl: string) {}

  /**
   * Synchronous network request using XMLHttpRequest
   * This ONLY works in DOM contexts (offscreen document), not service workers
   */
  getRecordSync(dnaHash: Uint8Array, hash: Uint8Array): NetworkRecord | null {
    const xhr = new XMLHttpRequest();
    const url = this.buildRecordUrl(dnaHash, hash);

    xhr.open('GET', url, false); // false = synchronous
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.send();

    if (xhr.status === 200) {
      return this.parseRecordResponse(xhr.responseText);
    } else if (xhr.status === 404) {
      return null;
    }

    throw new Error(`Network error: ${xhr.status}`);
  }

  // Async version for compatibility with interface
  async getRecord(dnaHash: Uint8Array, hash: Uint8Array): Promise<NetworkRecord | null> {
    return this.getRecordSync(dnaHash, hash);
  }
}
```

### Cascade Class

```typescript
// packages/core/src/network/cascade.ts

export class Cascade {
  constructor(
    private storage: SourceChainStorage,
    private networkCache: NetworkCacheStorage,
    private network: NetworkService | null, // null = offline mode
  ) {}

  /**
   * Fetch record using cascade pattern.
   * In offscreen context with SyncXHRNetworkService, this is synchronous.
   */
  fetchRecord(
    dnaHash: Uint8Array,
    agentPubKey: Uint8Array,
    hash: Uint8Array
  ): NetworkRecord | null {
    // 1. Try local source chain (session cache)
    const local = this.storage.getAction(hash);
    if (!(local instanceof Promise) && local !== null) {
      return this.actionToNetworkRecord(local);
    }

    // 2. Try network cache
    const cached = this.networkCache.getCachedRecordSync(hash);
    if (cached !== null) {
      return cached;
    }

    // 3. Fetch from network (sync XHR in offscreen document)
    if (this.network) {
      const fetched = (this.network as SyncXHRNetworkService).getRecordSync(dnaHash, hash);
      if (fetched !== null) {
        this.networkCache.cacheRecordSync(hash, fetched);
        return fetched;
      }
    }

    return null;
  }
}
```

### Updated get Host Function

```typescript
// packages/core/src/ribosome/host-fn/get.ts

export const get: HostFunctionImpl = (context, inputPtr, inputLen) => {
  const { callContext, instance, cascade } = context;
  const storage = SourceChainStorage.getInstance();

  const inputs = deserializeFromWasm(instance, inputPtr, inputLen) as GetInput[];
  const { any_dht_hash } = inputs[0];

  // Use cascade for fetching (handles local -> cache -> network)
  const record = cascade
    ? cascade.fetchRecord(callContext.cellId[0], callContext.cellId[1], any_dht_hash)
    : storage.getAction(any_dht_hash);

  if (record === null) {
    return serializeResult(instance, [null]);
  }

  // ... rest of existing logic to format Record ...
};
```

## Test Strategy

### Level 1: Unit Tests (Node.js with mocks)

```typescript
// packages/core/src/network/cascade.test.ts
describe('Cascade', () => {
  it('returns from local storage first', () => {
    const cascade = new Cascade(mockStorage, mockCache, mockNetwork);
    mockStorage.setAction(hash, action);

    const result = cascade.fetchRecord(dnaHash, agentKey, hash);
    expect(result).toBeDefined();
    expect(mockNetwork.getRecordSync).not.toHaveBeenCalled();
  });

  it('fetches from network on cache miss', () => {
    const cascade = new Cascade(mockStorage, mockCache, mockNetwork);
    mockNetwork.getRecordSync.mockReturnValue(networkRecord);

    const result = cascade.fetchRecord(dnaHash, agentKey, hash);
    expect(result).toEqual(networkRecord);
    expect(mockCache.cacheRecordSync).toHaveBeenCalled();
  });
});
```

### Level 2: Browser Tests (manual)

1. Load extension in Chrome
2. Open test page (`packages/extension/test/test-page.html`)
3. Test CALL_ZOME with network-dependent operations

### Level 3: Automated Browser Tests (future)

Consider adding Puppeteer/Playwright tests for CI.

## Critical Files

| File | Purpose | Action |
|------|---------|--------|
| `packages/extension/manifest.json` | Add offscreen permission | Modify |
| `packages/extension/src/offscreen/` | Offscreen document | Create |
| `packages/extension/src/background/index.ts` | Proxy to offscreen | Modify |
| `packages/core/src/network/types.ts` | NetworkService interface | Create |
| `packages/core/src/network/sync-xhr-service.ts` | Sync XHR implementation | Create |
| `packages/core/src/network/cascade.ts` | Cascade logic | Create |
| `packages/core/src/storage/network-cache.ts` | Network data cache | Create |
| `packages/core/src/ribosome/host-fn/get.ts` | Integrate cascade | Modify |

## Gateway Integration (Step 8)

Step 7 uses MockNetworkService for tests and prepares the architecture.
Step 8 will:

1. Add gateway URL configuration
2. Connect SyncXHRNetworkService to real hc-http-gw
3. Handle gateway authentication if needed

## Session Workflow

**Starting Step 7.1**:
1. Update SESSION.md to show Step 7 in progress
2. Begin with 7.1.1 (manifest update)
3. Test each step before moving on

**Completing Step 7**:
1. Create 7_COMPLETION.md
2. Update CLAUDE.md to mark Step 7 complete
3. Update SESSION.md for Step 8
