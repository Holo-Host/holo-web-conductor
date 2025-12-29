# Step 7.0: Network Sync/Async Research Findings

**Date**: 2025-12-29
**Status**: Complete
**Spikes Created**: `spikes/offscreen-test/`, `spikes/jspi-test/`

## Problem Statement

WASM host functions in browsers must be synchronous, but network calls are async.
If a zome computes `hash = some_calculation()` then calls `get(hash)`, we cannot
know `hash` in advance to preload the data.

**We need a way to make synchronous network calls from WASM host functions.**

## Approaches Evaluated

### 1. Offscreen Document + Sync XHR

**Verdict: RECOMMENDED**

Chrome's offscreen document API creates a hidden DOM environment for extensions.
Unlike service workers, offscreen documents support synchronous XMLHttpRequest.

| Aspect | Assessment |
|--------|------------|
| Availability | Standard extension API, Chrome 109+ |
| Flags required | None |
| Node.js testing | Not directly (browser-only) |
| Complexity | Medium - messaging between contexts |
| Reliability | High - documented, stable API |

**How it works**:
```
Service Worker
    ↓ chrome.runtime.sendMessage({ type: 'CALL_ZOME', ... })
Offscreen Document
    ↓ runs WASM
    ↓ host function needs network data
    ↓ sync XHR to gateway
    ↓ returns data to WASM
    ↓ WASM continues
    ↓ returns result
Service Worker
    ↓ responds to content script
```

**Spike**: `spikes/offscreen-test/` - Load as unpacked extension in Chrome to test.

### 2. JSPI (JavaScript Promise Integration)

**Verdict: FUTURE OPTION**

JSPI is a WebAssembly standard that allows async host functions. It's at Stage 3
in W3C standardization but requires a Chrome flag.

| Aspect | Assessment |
|--------|------------|
| Availability | Chrome M126+ with flag |
| Flags required | `chrome://flags/#enable-experimental-webassembly-jspi` |
| Node.js testing | Not available (no Node.js support) |
| Complexity | Low - clean API design |
| Reliability | Medium - experimental, API recently changed |

**API**:
```javascript
// Wrap async host function
const suspendingGetValue = new WebAssembly.Suspending(async () => {
  const response = await fetch('...');
  return response.json();
});

// Wrap WASM export
const promisingFn = WebAssembly.promising(instance.exports.myFn);

// Call returns Promise
const result = await promisingFn();
```

**Issues**:
- Requires users to enable a Chrome flag (bad UX)
- Not available in Node.js (breaks automated tests)
- API changed in 2024, may change again before standardization

**Spike**: `spikes/jspi-test/jspi-browser-test.html` - Open in Chrome with flag enabled.

### 3. SharedArrayBuffer + Atomics.wait

**Verdict: NOT RECOMMENDED**

Use SharedArrayBuffer with Atomics.wait() to block a worker thread while the
main thread fetches network data.

| Aspect | Assessment |
|--------|------------|
| Availability | Requires COOP/COEP headers |
| Flags required | None, but complex setup |
| Node.js testing | Yes (with flags) |
| Complexity | HIGH - thread synchronization |
| Reliability | Low - error-prone |

**Issues**:
- Requires Cross-Origin Isolation headers (COOP/COEP)
- Thread synchronization is complex and error-prone
- Debugging is difficult
- Much more code than alternatives

**Notes**: `spikes/shared-array-buffer-notes.md`

## Recommendation

**Use Offscreen Document approach for Step 7.**

### Rationale

1. **Works today** - No experimental flags, standard extension API
2. **Reliable** - Offscreen documents are documented and stable
3. **Simpler than SharedArrayBuffer** - No thread synchronization
4. **Natural migration path** - When JSPI becomes standard (no flag), we can migrate

### Architecture with Offscreen Document

```
Web Page (content script)
    ↓ window.postMessage
Content Script
    ↓ chrome.runtime.sendMessage
Service Worker (background.js)
    ↓ chrome.runtime.sendMessage
Offscreen Document                    ← WASM runs HERE
    ├─ Loads WASM module
    ├─ Executes zome function
    ├─ Host function calls get(hash)
    │   └─ Sync XHR to gateway ←──────── NETWORK HERE
    ├─ Returns result
    ↓ chrome.runtime.sendMessage
Service Worker
    ↓ responds
Content Script
    ↓ window.postMessage
Web Page
```

### Testing Strategy

1. **Unit tests** (Node.js): Mock NetworkService, no actual network calls
2. **Integration tests** (Browser): Manual testing with loaded extension
3. **Automated browser tests** (Future): Consider Puppeteer/Playwright

### Migration to JSPI (Future)

When JSPI is standardized and enabled by default:
1. Replace offscreen document with direct JSPI in service worker
2. Simpler architecture (no offscreen document needed)
3. Keep NetworkService interface unchanged

## Files Created

| File | Purpose |
|------|---------|
| `spikes/offscreen-test/manifest.json` | Extension manifest |
| `spikes/offscreen-test/background.js` | Service worker |
| `spikes/offscreen-test/offscreen.html` | Offscreen document |
| `spikes/offscreen-test/offscreen.js` | WASM + sync XHR test |
| `spikes/offscreen-test/README.md` | Test instructions |
| `spikes/jspi-test/jspi-availability.ts` | Node.js JSPI check |
| `spikes/jspi-test/jspi-browser-test.html` | Browser JSPI test |
| `spikes/shared-array-buffer-notes.md` | SAB evaluation |

## Next Steps

1. Update STEP7_PLAN.md with offscreen document architecture
2. Modify extension to use offscreen document for WASM execution
3. Implement NetworkService with sync XHR
4. Test with profiles WASM

## References

- [Chrome Offscreen API](https://developer.chrome.com/docs/extensions/reference/api/offscreen)
- [JSPI V8 Blog](https://v8.dev/blog/jspi)
- [JSPI New API](https://v8.dev/blog/jspi-newapi)
