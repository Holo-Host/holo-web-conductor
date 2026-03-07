# Development Guide

For project rules, coding standards, and architecture context, see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Quick Start

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
npm run build:extension

# Watch mode for development
npm run dev
```

### Testing
```bash
# Run all tests (includes typecheck)
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
2. Serve test pages: `./scripts/serve-test-pages.sh`
3. Open `http://localhost:8080/sandbox-test.html`
4. Click "Run All" and verify all tests pass

## Tech Stack

- **Language**: TypeScript (strict mode)
- **Build**: Vite
- **Tests**: Vitest + Playwright (e2e)
- **Package Manager**: npm (workspaces)
- **Browser**: Chrome MV3 (primary), Firefox (secondary)

## Typecheck Pipeline

Vitest uses esbuild for speed, which **strips types without checking them**. This means a test suite can pass with type errors present. The `npm run typecheck` step (which runs before tests via `npm test`) catches these. If you run vitest directly (e.g., `npx vitest run`), you bypass typechecking entirely.

```bash
# Typecheck all packages (runs tsc --noEmit for each)
npm run typecheck

# This also runs automatically as part of:
npm test
```

## Common Issues & Solutions

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

## Architecture Decisions

### Why IIFE for Scripts?
Chrome MV3 content scripts don't support ES module imports. Background workers can use modules (`type: "module"` in manifest), but for consistency and build simplicity, all scripts use IIFE.

### Why Separate Builds?
Vite's IIFE format doesn't support code splitting. We build popup normally (can split), then build background and content as separate library builds.

### Why npm Workspaces?
Simpler than pnpm/yarn for this project size. All packages are private and co-located.

## Further Reading

- [CONTRIBUTING.md](./CONTRIBUTING.md) - Project rules and coding standards
- [ARCHITECTURE.md](./ARCHITECTURE.md) - System architecture and design decisions
- [TESTING.md](./TESTING.md) - Testing guide
- [STEPS/index.md](./STEPS/index.md) - Step plans and status
