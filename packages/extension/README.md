# Holochain Web Conductor Browser Extension

Browser extension implementation of Holochain conductor and Lair keystore.

## Step 1: Browser Extension Base ✅ COMPLETE

The extension now has:
- ✅ Build tooling (Vite + TypeScript with IIFE output)
- ✅ Background service worker with message routing
- ✅ Content script that injects `window.holochain` API (via separate inject script)
- ✅ Messaging protocol for page ↔ extension communication (postMessage bridge)
- ✅ Basic popup UI
- ✅ Test page for integration testing
- ✅ 34 automated tests (18 messaging + 16 build validation)
- ✅ Browser tested and working

## Development

### Build

```bash
npm run build
```

This builds the extension to the `dist/` folder.

### Watch Mode

```bash
npm run dev
```

Rebuilds on file changes.

### Test

```bash
npm test
```

Runs unit tests with Vitest.

## Loading the Extension

### Chrome/Chromium

1. Build the extension: `npm run build`
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" (toggle in top right)
4. Click "Load unpacked"
5. Select the `packages/extension/dist` directory
6. The extension should now be loaded

### Firefox

1. Build the extension: `npm run build`
2. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`
3. Click "Load Temporary Add-on"
4. Navigate to `packages/extension/dist` and select `manifest.json`
5. The extension should now be loaded

## Testing

After loading the extension:

1. Serve test pages: `./scripts/serve-test-pages.sh` (from repo root)
2. Open `http://localhost:8080/sandbox-test.html`
3. Click "Run All" to exercise all extension APIs and host functions
4. All tests should show green checks

See also `happ-test.html` (WebConductorAppClient integration) and `authorization-test.html` (permission popup flow).

## Architecture

```
┌─────────────────┐
│   Web Page      │
│  (Page Context) │
└────────┬────────┘
         │
    ┌────▼─────┐
    │  inject/ │  Injected script defines window.holochain
    │  index.js│  (web_accessible_resource)
    └────┬─────┘
         │ window.postMessage
         ▼
┌─────────────────┐
│ Content Script  │  Isolated world, bridges messages
│   (Bridge)      │
└────────┬────────┘
         │ chrome.runtime.sendMessage
         ▼
┌─────────────────┐
│   Background    │  Service worker, routes to handlers
│ Service Worker  │
│ (Message Router)│
└─────────────────┘
```

**Key architectural decisions**:
- Separate inject script to avoid CSP violations
- postMessage bridge for page ↔ content script communication
- IIFE format for all scripts (content + inject) for compatibility

## Files

- `src/background/index.ts` - Background service worker
- `src/content/index.ts` - Content script bridge (postMessage ↔ runtime.sendMessage)
- `src/inject/index.ts` - Injected script that defines window.holochain
- `src/popup/index.html` - Extension popup UI
- `src/popup/index.ts` - Popup logic
- `src/lib/messaging.ts` - Message protocol definitions
- `src/lib/messaging.test.ts` - Message protocol tests (18 tests)
- `src/build-validation.test.ts` - Build validation tests (16 tests)
- `manifest.json` - Extension manifest (MV3)
- `test/sandbox-test.html` - Extension API test page (all host functions)
- `test/happ-test.html` - WebConductorAppClient integration test page
- `test/authorization-test.html` - Permission popup flow test page
- `vite.config.ts` - Build configuration

## API

Pages can access the Holochain API via `window.holochain`:

```javascript
// Check if extension is installed
if (window.holochain?.isWebConductor) {
  // Connect to extension
  const result = await window.holochain.connect();

  // Call a zome function
  const response = await window.holochain.callZome({
    cell_id: [dnaHash, agentPubKey],
    zome_name: "my_zome",
    fn_name: "my_function",
    payload: { data: "..." },
    provenance: agentPubKey
  });

  // Get app info
  const info = await window.holochain.appInfo("my-app");

  // Disconnect
  await window.holochain.disconnect();
}
```

## Next Steps

See `CLAUDE.md` for the complete implementation plan. Step 1 establishes the foundation for:
- **Step 2**: Lair keystore implementation
- **Step 3**: Authorization mechanism
- **Step 4**: hApp context creation
- **Step 5+**: WASM execution and conductor functionality
