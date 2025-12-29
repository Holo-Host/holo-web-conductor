# SharedArrayBuffer Approach - Evaluation

## Concept

Use SharedArrayBuffer with Atomics.wait() to block a worker thread while waiting
for network data from the main thread.

```
Main Thread                    Worker Thread
    |                              |
    |  <-- SharedArrayBuffer -->   |
    |                              |
    |                          WASM executes
    |                          host_fn calls get()
    |                          Atomics.wait() BLOCKS
    |  <-- notifies need data
    |
    | fetches from network
    |
    |  --> writes to buffer
    |  Atomics.notify()
    |                          Atomics.wait() RETURNS
    |                          host_fn returns data
    |                          WASM continues
```

## Requirements

1. **SharedArrayBuffer** requires Cross-Origin Isolation (COOP/COEP headers):
   - `Cross-Origin-Opener-Policy: same-origin`
   - `Cross-Origin-Embedder-Policy: require-corp`

2. **Browser Extensions**: These headers apply to extension pages, but:
   - Extension content scripts run in web page context
   - Service workers don't have these headers by default
   - Would need to serve extension pages with proper headers

## Chrome Extension Specifics

For extensions, you can set headers in manifest.json via `content_security_policy`,
but COOP/COEP are response headers, not CSP directives.

Options:
1. Use extension pages (popup, options) that naturally have isolation
2. Use offscreen documents (may inherit isolation)
3. Use a separate local server to serve WASM worker pages

## Complexity Assessment

**HIGH COMPLEXITY**:
- Need to manage SharedArrayBuffer between threads
- Need to handle partial data, timeouts, errors
- Need COOP/COEP setup
- Thread synchronization is error-prone
- Debugging is difficult

## Recommendation

**NOT RECOMMENDED** for fishy extension.

The offscreen document approach is simpler and achieves the same goal
(synchronous network access from WASM host functions) without the
complexity of thread synchronization and cross-origin isolation.

## References

- [MDN: SharedArrayBuffer](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)
- [Chrome: Cross-Origin Isolation](https://web.dev/cross-origin-isolation-guide/)
