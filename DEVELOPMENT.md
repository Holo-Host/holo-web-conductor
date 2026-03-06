# Holo Web Conductor Development Guide

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

## Project Structure

```
holo-web-conductor/
├── packages/
│   ├── extension/     # Chrome/Firefox browser extension (MV3)
│   │   └── src/
│   │       ├── background/  # Service worker
│   │       ├── content/     # Content scripts (page bridge)
│   │       ├── offscreen/   # Offscreen document (WASM + SQLite)
│   │       └── popup/       # Extension popup UI
│   ├── core/          # Core conductor functionality
│   │   └── src/
│   │       ├── ribosome/    # Host function implementations
│   │       ├── storage/     # SQLite storage layer
│   │       ├── network/     # Linker network services
│   │       └── dht/         # DhtOp generation and publishing
│   ├── client/        # Client library (@holo-host/web-conductor-client)
│   ├── lair/          # Lair keystore (browser + Node.js, pluggable storage)
│   ├── shared/        # Shared types and utilities
│   ├── e2e/           # Playwright end-to-end tests
│   └── test-zome/     # HDK test zome (Rust/WASM)
├── CLAUDE.md          # AI agent instructions and project rules
├── ARCHITECTURE.md    # System architecture and design decisions
├── TESTING.md         # Testing guide
├── STEPS/             # Development step plans and completion notes
└── COMPATIBILITY.md   # Version compatibility with h2hc-linker
```

## Development Workflow

### Starting a New Feature
1. Check `STEPS/index.md` for current status
2. Read relevant section in `CLAUDE.md`
3. Create tests first (TDD)
4. Implement feature
5. Run tests: `npm test`
6. Test manually (for UI/extension features)
7. Commit when complete and tested

### Committing Changes
1. All unit tests pass: `npm test`
2. Manual browser testing complete (for extension changes)
3. Stage changes and commit with descriptive message
4. Push to origin

## Testing Philosophy

### Three Layers of Testing
1. **Unit Tests**: `src/**/*.test.ts` - Fast, automated (Vitest)
2. **Integration Tests**: `packages/core/vitest.integration.config.ts` - Test with real WASM
3. **E2E Tests**: `packages/e2e/` - Playwright tests against built extension with linker

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

## Tech Stack

- **Language**: TypeScript (strict mode)
- **Build**: Vite
- **Tests**: Vitest + Playwright (e2e)
- **Package Manager**: npm (workspaces)
- **Browser**: Chrome MV3 (primary), Firefox (secondary)

## Type Safety

TypeScript strict mode is enabled project-wide. The type system is a primary defense against serialization and boundary bugs -- not just a developer convenience.

### Typecheck pipeline

```bash
# Typecheck all packages (runs tsc --noEmit for each)
npm run typecheck

# This also runs automatically as part of:
npm test
```

Vitest uses esbuild for speed, which **strips types without checking them**. This means a test suite can pass with type errors present. The `npm run typecheck` step (which runs before tests via `npm test`) catches these. If you run vitest directly (e.g., `npx vitest run`), you bypass typechecking entirely.

### Rules for contributors

- **No `as any` in production code.** Define a named type instead.
- **No `as any` in test code without justification.** Use `Pick<T, ...>`, typed factory functions, or proper mocks.
- **Type return values explicitly.** Functions at WASM, network, or message boundaries must declare their return type.
- **Use `@holochain/client` types.** `EntryHash`, `ActionHash`, `AgentPubKey`, `DnaHash`, `Record`, `Action`, `CellId` -- prefer these over `Uint8Array` or custom equivalents.
- **Run `npm run typecheck` before marking work complete.** Type errors are real errors.

## Architecture Decisions

### Why IIFE for Scripts?
Chrome MV3 content scripts don't support ES module imports. Background workers can use modules (`type: "module"` in manifest), but for consistency and build simplicity, all scripts use IIFE.

### Why Separate Builds?
Vite's IIFE format doesn't support code splitting. We build popup normally (can split), then build background and content as separate library builds.

### Why npm Workspaces?
Simpler than pnpm/yarn for this project size. All packages are private and co-located.

## Resources

- **Architecture**: See [ARCHITECTURE.md](./ARCHITECTURE.md)
- **Testing Guide**: See [TESTING.md](./TESTING.md)
- **Step Plans**: See [STEPS/index.md](./STEPS/index.md)
