# Holo Web Conductor Development Guide

## Quick Start for Continuing Development

### First Time Setup
```bash
cd /path/to/holochain/holo-web-conductor
npm install
```

### Building
```bash
# Build all packages
npm run build

# Build extension only
cd packages/extension
npm run build

# Watch mode for development
npm run dev
```

### Testing
```bash
# Run all tests
npm test

# Run extension tests only
cd packages/extension
npm test

# Watch mode
npm run test:watch
```

### Loading Extension in Browser

**Chrome**:
1. Go to `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select `packages/extension/dist/`

**Firefox**:
1. Go to `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on"
3. Select `packages/extension/dist/manifest.json`

### Testing the Extension
1. Load extension (see above)
2. Open `packages/extension/test/test-page.html`
3. Verify:
   - Extension detected
   - Connect button works
   - All API calls succeed
   - No console errors

## Project Structure

```
holo-web-conductor/
├── CLAUDE.md              # Main project plan
├── SESSION.md             # Current session state
├── DEVELOPMENT.md         # This file
├── package.json           # Root workspace config
└── packages/
    ├── extension/         # Browser extension (Step 1)
    │   ├── src/
    │   │   ├── background/    # Service worker
    │   │   ├── content/       # Content script bridge
    │   │   ├── popup/         # Extension popup UI
    │   │   └── lib/           # Shared extension code
    │   ├── test/              # Integration test page
    │   ├── dist/              # Build output (gitignored)
    │   └── vite.config.ts     # Build config
    ├── core/              # Conductor logic (Step 5+)
    ├── lair/              # Keystore (Step 2)
    └── shared/            # Shared types/utilities
```

## Development Workflow

### Starting a New Feature/Step
1. Read `SESSION.md` for current state
2. Read relevant section in `CLAUDE.md`
3. Create tests first (TDD)
4. Implement feature
5. Run tests: `npm test`
6. Test manually (for UI/extension features)
7. Update `SESSION.md` with progress
8. Commit when complete and tested

### Cross-Workstation Development
1. **Before switching**:
   - Update `SESSION.md` with current status
   - Commit WIP if needed
   - Push to git

2. **On new workstation**:
   - `git pull`
   - Read `SESSION.md`
   - Run `npm install` if needed
   - Continue from documented state

### Committing Changes
⚠️ **IMPORTANT**: User testing required before commits (see Requirements)

1. Manual testing complete ✓
2. All unit tests pass ✓
3. Update `SESSION.md` ✓
4. Stage changes: `git add .`
5. Commit with descriptive message
6. Push to origin

## Testing Philosophy

### Three Layers of Testing
1. **Unit Tests**: `src/**/*.test.ts` - Fast, automated
2. **Build Validation**: `src/build-validation.test.ts` - Catches build issues
3. **Integration Tests**: Manual browser testing - Catches runtime issues

### When to Write Tests
- **Before implementation** (TDD preferred)
- When fixing bugs (regression test)
- When adding new message types or protocols

### What to Test
- Message serialization/deserialization
- API functions and handlers
- Build output structure and format
- Cross-browser compatibility (Chrome + Firefox)

## Common Issues & Solutions

### "Unsupported engine" warnings during npm install
- **Cause**: Node version < 20.9.0
- **Solution**: Warnings are safe to ignore on Node 20.5.0+

### Content script import errors
- **Cause**: Scripts not bundled as IIFE
- **Solution**: Build config creates IIFE format (see vite.config.ts)
- **Prevention**: Build validation tests catch this

### Extension not detected on test page
- **Cause**: Extension not loaded or crashed
- **Solution**: Check `chrome://extensions/` for errors
- **Debug**: Open extension background service worker console

### Changes not appearing after rebuild
- **Cause**: Browser cached old version
- **Solution**: Click reload button on extension in `chrome://extensions/`

### E2E tests fail but unit tests pass after source changes
- **Cause**: Extension not rebuilt. Unit tests (vitest) compile TypeScript on the fly. E2E tests run against the built extension in `packages/extension/dist/`.
- **Solution**: Run `npm run build:extension`, reload extension in browser, retest.
- **Check**: Compare timestamps: `ls -la packages/extension/dist/background/index.js` vs latest source file modification times.
- **See also**: LESSONS_LEARNED.md Pattern 8

## Requirements & Constraints

From `CLAUDE.md`:

1. **Test-Driven Development**: CI must confirm no regressions
2. **User Testing Required**: Manual browser testing before commits
3. **Cross-Workstation Support**: Use SESSION.md for continuity
4. **Pragmatic Quality**: Functionality over perfection, iterate later

## Tech Stack

- **Language**: TypeScript (strict mode)
- **Build**: Vite 5.4.21
- **Tests**: Vitest 2.1.9
- **Package Manager**: npm (workspaces)
- **Browser**: Chrome MV3 (primary), Firefox (secondary)

## Architecture Decisions

### Why IIFE for Scripts?
Chrome MV3 content scripts don't support ES module imports. Background workers can use modules (`type: "module"` in manifest), but for consistency and build simplicity, all scripts use IIFE.

### Why Separate Builds?
Vite's IIFE format doesn't support code splitting. We build popup normally (can split), then build background and content as separate library builds.

### Why npm Workspaces?
Simpler than pnpm/yarn for this project size. All packages are private and co-located.

## Step-by-Step Plan

See `CLAUDE.md` for full details. Summary:

- ✅ **Step 0**: Plan refinement and scaffolding
- ⚠️ **Step 1**: Browser extension base (PENDING USER TEST)
- 📋 **Step 2**: Lair keystore implementation
- 📋 **Step 3**: Authorization mechanism
- 📋 **Step 4**: hApp context creation
- 📋 **Step 5**: WASM execution with mocks
- 📋 **Step 6**: Local chain storage
- 📋 **Step 7**: hc-http-gw extensions
- 📋 **Step 8**: Network host functions
- 📋 **Step 9**: Integration testing

## Resources

- **Holochain**: `../holochain/` (reference implementation)
- **Lair**: `../lair/` (keystore reference)
- **h2hc-linker**: `../h2hc-linker/` (Holo-to-Holochain linker)
- **Chrome Extension Docs**: https://developer.chrome.com/docs/extensions/mv3/
- **Web Crypto API**: https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API

## Contact & Session Info

- Current session documented in `SESSION.md`
- Update before switching workstations
- Include blockers and next steps
