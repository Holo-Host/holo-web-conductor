# Fishy Browser Extension

Browser extension implementation of Holochain conductor and Lair keystore.

## Step 1: Browser Extension Base ✓

The extension now has:
- ✅ Build tooling (Vite + TypeScript)
- ✅ Background service worker with message routing
- ✅ Content script that injects `window.holochain` API
- ✅ Messaging protocol for page ↔ extension communication
- ✅ Basic popup UI
- ✅ Test page for integration testing

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
6. The Fishy extension should now be loaded

### Firefox

1. Build the extension: `npm run build`
2. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`
3. Click "Load Temporary Add-on"
4. Navigate to `packages/extension/dist` and select `manifest.json`
5. The Fishy extension should now be loaded

## Testing

After loading the extension:

1. Open `packages/extension/test/test-page.html` in your browser
2. The page should detect the extension automatically
3. Click the buttons to test various functionality:
   - **Connect**: Establishes connection with extension
   - **Disconnect**: Closes connection
   - **Get App Info**: Requests app information (mock response)
   - **Call Zome**: Calls a zome function (mock response)

### Expected Behavior

- Extension detection should succeed
- Connect should return `{connected: true, url: "..."}`
- Disconnect should return `{disconnected: true}`
- App Info should return a mock response
- Zome Call should return a mock response

All messages should show in the test log on the page.

## Architecture

```
┌─────────────────┐
│   Web Page      │
│  window.        │
│  holochain      │
└────────┬────────┘
         │ window.postMessage
         ▼
┌─────────────────┐
│ Content Script  │
│  (Bridge)       │
└────────┬────────┘
         │ chrome.runtime.sendMessage
         ▼
┌─────────────────┐
│   Background    │
│ Service Worker  │
│ (Message Router)│
└─────────────────┘
```

## Files

- `src/background/index.ts` - Background service worker
- `src/content/index.ts` - Content script that injects API
- `src/popup/index.html` - Extension popup UI
- `src/popup/index.ts` - Popup logic
- `src/lib/messaging.ts` - Message protocol definitions
- `manifest.json` - Extension manifest (MV3)
- `test/test-page.html` - Integration test page

## API

Pages can access the Holochain API via `window.holochain`:

```javascript
// Check if extension is installed
if (window.holochain?.isFishy) {
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

See `claude.md` for the complete implementation plan. Step 1 establishes the foundation for:
- **Step 2**: Lair keystore implementation
- **Step 3**: Authorization mechanism
- **Step 4**: hApp context creation
- **Step 5+**: WASM execution and conductor functionality
