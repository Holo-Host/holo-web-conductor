# Offscreen Document WASM + Sync XHR Test

This spike tests whether Chrome's offscreen document API can run WASM with
synchronous XHR host functions.

## Why This Matters

Browser extension service workers cannot make synchronous HTTP requests,
and WASM host functions must be synchronous. Offscreen documents are regular
DOM environments where sync XHR works.

## How to Test

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked" and select this directory (`spikes/offscreen-test/`)
4. Click the extension icon in the toolbar
5. Open the service worker console (click "Inspect views: service worker")
6. Check the console for test results

## Expected Results

If successful, you should see:
```
[Background] Test response: {
  syncXHR: { success: true, data: { test: "sync" } },
  wasm: { success: true, result: 42, message: "WASM called sync XHR host function successfully" },
  viable: true,
  summary: "Offscreen document CAN run WASM with sync XHR host functions"
}
```

## What This Tests

1. **Sync XHR**: Can we make synchronous HTTP requests from the offscreen document?
2. **WASM + Sync Host**: Can a WASM module call a host function that makes sync XHR?

## Files

- `manifest.json` - Extension manifest with offscreen permission
- `background.js` - Service worker that creates offscreen document
- `offscreen.html` - The offscreen document
- `offscreen.js` - WASM + sync XHR test code

## Integration Path

If this spike succeeds, the fishy extension architecture would be:

```
Content Script (web page)
      ↓ postMessage
Service Worker (background)
      ↓ chrome.runtime.sendMessage
Offscreen Document
      ↓ runs WASM with sync XHR host functions
      ↓ makes network calls during zome execution
```
