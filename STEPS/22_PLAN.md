# Step 22: Migration to holo-host GitHub Org + Rename

## Goal

1. Migrate repos from `zippy` GitHub org to `holo-host`
2. Rename `fishy` repo to `holo-web-conductor`
3. Rename all "fishy" branding throughout codebase to production names
4. Publish `@holo-host/web-conductor-client` as a real npm package
5. Extension user-facing name becomes "Holochain" with standard Holochain logo
6. Evolve solo-developer step-based process into team workflow with GitHub Projects/Issues

---

## 1. Repo Structure Decision

**Recommendation: 2 repos** (holo-web-conductor monorepo + hc-membrane)

| Option | Pros | Cons |
|--------|------|------|
| **3 repos** (client, extension, membrane) | Independent client versioning | Client has `copy-to-test` build coupling; 3 repos for 2-3 people is overhead |
| **2 repos** (conductor monorepo, membrane) | Client testable alongside extension; npm publish from monorepo is standard (Babel, React); natural TS/Rust language boundary | Client releases tied to monorepo tags (mitigated with `client-v*` tag prefix) |
| **1 monorepo** (everything) | Atomic cross-language changes | Polyglot CI complexity; separate nix flakes; Rust contributors forced into TS toolchain |

Start with 2 repos. Client extraction is trivial if release cadence diverges later.

---

## 2. Naming Map

### Repo & Org
| Old | New |
|-----|-----|
| `zippy/fishy` | `holo-host/holo-web-conductor` |
| `zippy/hc-membrane` | `holo-host/hc-membrane` |

### npm Packages
| Old | New |
|-----|-----|
| `@zippy/fishy-client` | `@holo-host/web-conductor-client` |
| `@fishy/core` | `@hwc/core` |
| `@fishy/shared` | `@hwc/shared` |
| `@fishy/lair` | `@hwc/lair` |
| `@fishy/extension` | `@hwc/extension` |
| `@fishy/e2e` | `@hwc/e2e` |
| `@fishy/test-zome` | `@hwc/test-zome` |
| root `"name": "fishy"` | `"name": "holo-web-conductor"` |

### TypeScript Identifiers
| Old | New |
|-----|-----|
| `FishyAppClient` (class) | `WebConductorAppClient` |
| `FishyHolochainAPI` (interface) | `HolochainAPI` |
| `FishyAppInfo` (type) | `WebConductorAppInfo` |
| `isFishy` (property) | `isWebConductor` |
| `waitForFishy()` (utility) | `waitForHolochain()` |
| `fishyLogFilter` (global) | `hwcLogFilter` |
| `setFishyLogFilter()` | `setHwcLogFilter()` |

### File Renames
| Old | New |
|-----|-----|
| `packages/client/src/FishyAppClient.ts` | `packages/client/src/WebConductorAppClient.ts` |
| `packages/client/src/FishyAppClient.test.ts` | `packages/client/src/WebConductorAppClient.test.ts` |
| `packages/client/src/utils/wait-for-fishy.ts` | `packages/client/src/utils/wait-for-holochain.ts` |
| `packages/client/src/utils/wait-for-fishy.test.ts` | `packages/client/src/utils/wait-for-holochain.test.ts` |

### Extension Manifest
| Old | New |
|-----|-----|
| `"name": "Fishy - Holochain in the Browser"` | `"name": "Holochain"` |
| `"default_title": "Fishy"` | `"default_title": "Holochain"` |
| No icons configured | Add `"default_icon"` with Holochain logo (16, 48, 128px) |

### Logger Prefixes
The logger uses `createLogger('Background')` etc. - these don't contain "fishy". But the global filter variable and `setFishyLogFilter` function need renaming (see TypeScript Identifiers above).

### Documentation
All `.md` files with "fishy"/"Fishy" references need updating. Historical STEPS files can be batch-updated or left as historical record with a note at the top of STEPS/index.md.

---

## 3. Migration Phases

### Phase 1: GitHub Org Setup

1. Create empty repos: `holo-host/holo-web-conductor`, `holo-host/hc-membrane`
2. Create GitHub Team: `web-conductor-maintainers` (Admin on both repos)
3. Branch protection on `main`:
   - Require PR reviews (1 approval)
   - Require CI status checks to pass
   - Auto-delete head branches after merge
4. Create org-level **GitHub Project** board with columns: Backlog / In Progress / In Review / Done
   - Custom fields: `Component` (client | extension | core | lair | gateway), `Priority` (P0/P1/P2)

### Phase 2: Transfer Repos

**Preferred: GitHub "Transfer repository"** (Settings > Danger Zone) preserves all history, stars, issues. GitHub creates automatic redirects from old URLs.

If transfer isn't available, push to new remotes:
```bash
# holo-web-conductor (formerly fishy)
git remote set-url origin git@github.com:holo-host/holo-web-conductor.git
git push origin --all && git push origin --tags

# hc-membrane
git remote set-url origin git@github.com:holo-host/hc-membrane.git
git push origin --all && git push origin --tags
```

Note: If using transfer, the repo can be renamed during or after transfer via Settings > General > Repository name.

### Phase 3: Code Rename (holo-web-conductor repo)

This is the largest phase. Execute as a series of commits on a feature branch, merge via PR.

**Commit 1**: `chore: rename workspace packages from @fishy to @hwc`

Scope: All `package.json` files + all TypeScript import statements.

| Files | Change |
|-------|--------|
| `package.json` (root) | `"name": "fishy"` -> `"name": "holo-web-conductor"`; all `@fishy/` -> `@hwc/` in scripts |
| `packages/core/package.json` | `@fishy/core` -> `@hwc/core`; deps `@fishy/shared` -> `@hwc/shared` |
| `packages/shared/package.json` | `@fishy/shared` -> `@hwc/shared` |
| `packages/lair/package.json` | `@fishy/lair` -> `@hwc/lair`; deps `@fishy/shared` -> `@hwc/shared` |
| `packages/extension/package.json` | `@fishy/extension` -> `@hwc/extension`; all `@fishy/*` deps -> `@hwc/*` |
| `packages/e2e/package.json` | `@fishy/e2e` -> `@hwc/e2e` |
| `packages/test-zome/package.json` | `@fishy/test-zome` -> `@hwc/test-zome` |
| `packages/extension/vite.config.ts` | All `@fishy/` alias resolutions -> `@hwc/` (~24 occurrences) |
| All `.ts` source files | `import ... from '@fishy/...'` -> `import ... from '@hwc/...'` (~43 files) |
| `package-lock.json` | Regenerate via `npm install` |

**Commit 2**: `chore: rename client package to @holo-host/web-conductor-client`

| Files | Change |
|-------|--------|
| `packages/client/package.json` | name -> `@holo-host/web-conductor-client`; repo URL -> `https://github.com/holo-host/holo-web-conductor` |
| `packages/client/README.md` | All `@zippy/fishy-client` -> `@holo-host/web-conductor-client`; all "Fishy" -> "Holo Web Conductor" |
| `packages/client/vite.config.ts` | Library name if referenced |

**Commit 3**: `refactor: rename Fishy identifiers to WebConductor/Holochain`

File renames + identifier changes:

| Old File | New File |
|----------|----------|
| `packages/client/src/FishyAppClient.ts` | `packages/client/src/WebConductorAppClient.ts` |
| `packages/client/src/FishyAppClient.test.ts` | `packages/client/src/WebConductorAppClient.test.ts` |
| `packages/client/src/utils/wait-for-fishy.ts` | `packages/client/src/utils/wait-for-holochain.ts` |
| `packages/client/src/utils/wait-for-fishy.test.ts` | `packages/client/src/utils/wait-for-holochain.test.ts` |

Identifier renames (all files that reference these):

| Old | New | Approximate file count |
|-----|-----|----------------------|
| `FishyAppClient` | `WebConductorAppClient` | ~10 files (client pkg + e2e tests + docs) |
| `FishyHolochainAPI` | `HolochainAPI` | ~5 files (client types + extension inject) |
| `FishyAppInfo` | `WebConductorAppInfo` | ~3 files |
| `isFishy` | `isWebConductor` | ~5 files (types, inject, tests) |
| `waitForFishy` | `waitForHolochain` | ~5 files |
| `fishyLogFilter` / `setFishyLogFilter` | `hwcLogFilter` / `setHwcLogFilter` | ~3 files (shared/logger.ts + extension logger) |
| `fishy-client.js` (copy-to-test output) | `web-conductor-client.js` | 2 files (client package.json script + test HTML) |
| `.claude/agents/*.md` references | Update all agent definition files | 4 files |

**Commit 4**: `feat: rename extension to Holochain with logo`

| File | Change |
|------|--------|
| `packages/extension/manifest.json` | `"name": "Holochain"`, `"default_title": "Holochain"`, add `"default_icon"` and `"icons"` entries |
| `packages/extension/src/popup/index.html` | Update title/heading from "Fishy" to "Holochain" |
| `packages/extension/src/popup/authorize.html` | Update "Fishy" references |
| `packages/extension/src/popup/permissions.html` | Update "Fishy" references |
| `packages/extension/src/popup/happs.html` | Update "Fishy" references |
| `packages/extension/src/popup/lair.html` | Update "Fishy" references |
| New: `packages/extension/icons/` | Holochain logo at 16x16, 48x48, 128x128 PNG |

Icon source: Standard Holochain logo from holochain.org or the holochain GitHub org assets. Need to verify license allows use.

**Commit 5**: `docs: update all documentation for rename`

Batch update across all documentation files:
- `CLAUDE.md` - remove "fishy" references, add team workflow
- `ARCHITECTURE.md` - product name references
- `TESTING.md` - test commands and references
- `DEVELOPMENT.md` - build commands
- `SESSION.md` - simplify for team workflow
- `AGENT_TEAMS.md` - update agent references
- `LESSONS_LEARNED.md` - historical but update product name in headers/intro
- `STEPS/index.md` - mark as historical archive, update project name
- All `STEPS/*.md` files - either batch rename or add historical note header

Decision: Historical STEPS files (completed steps) can keep "fishy" references with a note at the top of `STEPS/index.md` explaining the rename. Only active/future documentation needs full updating.

### Phase 4: CI/CD Setup

**holo-web-conductor: `.github/workflows/ci.yml`** (on push to main + PRs)
```
- checkout
- nix-installer-action + magic-nix-cache-action
- nix develop -c npm ci
- nix develop -c npm run build
- nix develop -c npm run lint
- nix develop -c npm test
- Upload extension build artifact
```

**holo-web-conductor: `.github/workflows/publish-client.yml`** (on `client-v*` tags)
```
- checkout + nix setup
- npm ci && npm run build
- npm test --workspace=packages/client
- npm publish --access public --provenance (from packages/client/)
- Uses NPM_TOKEN secret
```

**hc-membrane: `.github/workflows/ci.yml`** (on push to main + PRs)
```
- checkout + nix setup + rust-cache
- cargo fmt --check
- cargo clippy -- -D warnings
- cargo test
- cargo build --release
```

**npm setup**:
- Verify/create `@holo-host` npm org at npmjs.com
- Generate automation token, store as `NPM_TOKEN` GitHub secret
- Create `.npmrc` with `@holo-host:registry=https://registry.npmjs.org/`

### Phase 5: Process Documentation Migration

**What stays:**
- `CLAUDE.md` - works well, gets team workflow additions
- `LESSONS_LEARNED.md` - invaluable, no changes beyond product name
- `STEPS/` directory - becomes read-only historical archive

**What evolves:**

`SESSION.md` simplifies to:
- Current branch + active issue number(s)
- Environment setup commands
- Remove detailed sub-task tracking (moves to GitHub Issues)

`STEPS/index.md` gets headers marking it as historical + noting the fishy->holo-web-conductor rename.

**New files (both repos):**
- `CONTRIBUTING.md` - dev setup, branch naming, PR process
- `.github/ISSUE_TEMPLATE/feature.md` and `bug.md`

**Convert in-progress STEPS to GitHub Issues:**
- Step 23 (Agent Activity) -> Issue
- Planned steps (13, 15, etc.) -> Issues in Backlog

### Phase 6: CLAUDE.md Team Workflow Update

Add to both repos' CLAUDE.md:

```markdown
## Team Workflow

### Work Tracking
- **GitHub Issues** are the source of truth for tasks
- **GitHub Project Board** shows priorities
- **SESSION.md** provides quick-resume context for AI agent sessions

### Branch Convention
- `main` - stable, CI-green
- `feature/<issue-number>-<short-desc>` - new features
- `fix/<issue-number>-<short-desc>` - bug fixes

### PR Process
1. Find or create a GitHub Issue
2. Branch from latest `main`
3. Implement with tests
4. Push, create PR linking issue (e.g., `Closes #42`)
5. CI must pass; one approval required
6. Squash merge to `main`

### AI Agent Sessions
1. Read `SESSION.md` for current context
2. Read linked GitHub Issue for requirements
3. Check `LESSONS_LEARNED.md` if working on serialization/WASM
4. Branch, implement, push, create PR
5. Update `SESSION.md` before ending session
```

### Phase 7: Multi-Agent Collaboration Setup (optional)

Claude Code has an experimental **agent teams** feature:
- One session acts as "team lead", assigns work to teammate sessions
- Teammates work independently with direct peer-to-peer messaging
- Shared task list with dependency management

For a 2-3 person team, the simpler approach is likely sufficient:
- Shared `CLAUDE.md` conventions (committed to git)
- `.claude/rules/` directory for modular path-specific rules
- Each contributor works on their own branch tied to a GitHub Issue
- PRs provide the coordination point

### Phase 8: Publish and Verify

1. Tag `client-v0.1.0`, verify CI publishes `@holo-host/web-conductor-client` to npm
2. Test: `npm install @holo-host/web-conductor-client` in a fresh project
3. Verify CI passes on both repos
4. Verify GitHub Project board has all active issues
5. Verify extension shows "Holochain" name and logo in Chrome

---

## 4. Execution Order Summary

```
1. Pre-flight: tag snapshots, verify tests pass
2. GitHub org setup (repos, teams, protection, project board)
3. Transfer/push repos to new org
4. Rename repo to holo-web-conductor (if using transfer, do via Settings)
5. Code rename branch:
   a. @fishy/* -> @hwc/* (workspace packages + imports)
   b. @zippy/fishy-client -> @holo-host/web-conductor-client
   c. FishyAppClient -> WebConductorAppClient + all identifier renames + file renames
   d. Extension manifest: name "Holochain" + logo
   e. Documentation updates
6. PR, review, merge rename branch
7. CI/CD: create workflow files, npm token, .npmrc
8. Process docs: CONTRIBUTING.md, issue templates, CLAUDE.md updates
9. Convert STEPS to GitHub Issues
10. Publish verification: tag + npm publish test
11. Cleanup: archive old org repos, update external references
```

---

## 5. Files Modified/Created Summary

### Source Code Changes (~90 files)

**Package scope rename (@fishy -> @hwc):**
- 7 `package.json` files (root + 6 packages)
- `packages/extension/vite.config.ts` (~24 alias occurrences)
- ~35 `.ts` source files with `import ... from '@fishy/...'`
- `package-lock.json` (regenerated)

**Client package rename:**
- `packages/client/package.json` - name + repo URL
- `packages/client/README.md` - ~17 occurrences
- `packages/client/src/index.ts` - exports + doc comments
- `packages/client/vite.config.ts` - library name

**TypeScript identifier renames:**
- `packages/client/src/FishyAppClient.ts` -> `WebConductorAppClient.ts` (file + class)
- `packages/client/src/FishyAppClient.test.ts` -> `WebConductorAppClient.test.ts`
- `packages/client/src/utils/wait-for-fishy.ts` -> `wait-for-holochain.ts`
- `packages/client/src/utils/wait-for-fishy.test.ts` -> `wait-for-holochain.test.ts`
- `packages/client/src/types.ts` - `FishyHolochainAPI`, `FishyAppInfo`, `isFishy`
- `packages/client/src/connection/monitor.ts` - `FishyAppClient` references
- `packages/client/src/connection/types.ts` - type references
- `packages/shared/src/logger.ts` - `fishyLogFilter`, `setFishyLogFilter`
- `packages/extension/src/inject/index.ts` - `isFishy`, window API setup
- `packages/extension/src/lib/logger.ts` - log filter references
- `packages/extension/src/background/index.ts` - identifier references
- `packages/extension/src/offscreen/*.ts` - identifier references
- `packages/extension/src/content/index.ts` - inject references

**Extension branding:**
- `packages/extension/manifest.json` - name, title, icons
- `packages/extension/src/popup/*.html` (5 files) - UI text
- New: `packages/extension/icons/` - Holochain logo PNGs (16, 48, 128)

**Agent definitions:**
- `.claude/agents/coordinator.md`
- `.claude/agents/core.md`
- `.claude/agents/extension.md`
- `.claude/agents/testing.md`

### Documentation Updates (~20 files)

- `CLAUDE.md` - product name + team workflow section
- `ARCHITECTURE.md` - product name
- `TESTING.md` - product name + commands
- `DEVELOPMENT.md` - product name + commands
- `SESSION.md` - simplified
- `AGENT_TEAMS.md` - product name
- `STEPS/index.md` - historical archive header
- Active STEPS files that reference current code patterns

Historical STEPS files (completed steps) - leave as-is with a note in `STEPS/index.md` that they use the old "fishy" codename.

### New Files (holo-web-conductor)
- `.github/workflows/ci.yml`
- `.github/workflows/publish-client.yml`
- `.github/ISSUE_TEMPLATE/feature.md`
- `.github/ISSUE_TEMPLATE/bug.md`
- `.npmrc`
- `CONTRIBUTING.md`
- `packages/extension/icons/holochain-16.png`
- `packages/extension/icons/holochain-48.png`
- `packages/extension/icons/holochain-128.png`

### New Files (hc-membrane)
- `.github/workflows/ci.yml`
- `.github/ISSUE_TEMPLATE/feature.md`
- `.github/ISSUE_TEMPLATE/bug.md`
- `CONTRIBUTING.md`

### Modified (hc-membrane)
- `CLAUDE.md` - team workflow section + update cross-references from "fishy" to "holo-web-conductor"

### NOT changed
- `flake.nix` in either repo (check for references, but likely none in nix config)
- `rust-toolchain.toml`

---

## 6. Test App Modifications (ziptest + mewsfeed)

Both e2e test apps (`ziptest` and `mewsfeed-fishy`) depend on `@zippy/fishy-client` and use "fishy"/"gateway" terminology. Each needs a new branch with updated imports and terminology to work with the renamed client and linker.

### 6a. ziptest repo

**Current state**: `ziptest` at `../ziptest/`
- `ui/src/fishy/index.ts` imports from `@zippy/fishy-client` (npm linked, not in package.json)
- `ui/src/App.svelte` uses `FishyAppClient`, `waitForFishy`, `gatewayUrl: GATEWAY_URL`
- `ui/src/Controller.svelte` uses `FishyAppClient`, "gateway" status UI
- `ui/vite.config.ts` defines `__GATEWAY_URL__` env variable
- `ui/package.json` has `"build:fishy": "vite build"` script

**New branch**: `holo-web-conductor` (or `hwc`)

| File | Changes |
|------|---------|
| `ui/src/fishy/` directory | Rename to `ui/src/holochain/` |
| `ui/src/holochain/index.ts` (was `fishy/index.ts`) | `@zippy/fishy-client` -> `@holo-host/web-conductor-client`; `FishyAppClient` -> `WebConductorAppClient`; `waitForFishy` -> `waitForHolochain`; `isFishyAvailable` -> `isWebConductorAvailable`; `FishyAppClientOptions` -> `WebConductorAppClientOptions` |
| `ui/src/App.svelte` | Import path `./fishy` -> `./holochain`; `FishyAppClient` -> `WebConductorAppClient`; `waitForFishy` -> `waitForHolochain`; `gatewayUrl: GATEWAY_URL` -> `linkerUrl: LINKER_URL`; "Fishy browser extension" text -> "Holochain extension"; "gateway is running" -> "linker is running" |
| `ui/src/Controller.svelte` | Import path `./fishy` -> `./holochain`; `FishyAppClient` -> `WebConductorAppClient`; `fishyClient` variable -> `hwcClient`; "gateway status" -> "linker status"; "gateway reachable/unreachable" -> "linker reachable/unreachable" |
| `ui/vite.config.ts` | `__GATEWAY_URL__` -> `__LINKER_URL__` |
| `ui/package.json` | Add `"@holo-host/web-conductor-client": "file:../../holo-web-conductor/packages/client"` to dependencies (or use published npm version); rename `"build:fishy"` -> `"build:hwc"` or remove (it's identical to `"build"`) |

**Decision: file: link vs npm dependency**
- During development: Use `"file:../../holo-web-conductor/packages/client"` for instant iteration
- For release: Switch to `"@holo-host/web-conductor-client": "^0.1.0"` (published npm package)
- The branch should use file: link initially, with a note to switch before any release

### 6b. mewsfeed-fishy repo

**Current state**: `mewsfeed-fishy` at `../mewsfeed-fishy/`
- Fork/branch of mewsfeed with fishy extension support added
- `ui/package.json` has `"@zippy/fishy-client": "file:../../fishy/packages/client"`
- `ui/src/fishy/index.ts` imports from `@zippy/fishy-client`
- `ui/src/utils/client.ts` uses `FishyAppClient`, `waitForFishy`, `gatewayUrl: GATEWAY_URL`
- `ui/src/App.vue` imports `ZeroArcProfilesClient` from `@/fishy`

**New branch**: `holo-web-conductor` (or rename the whole repo to `mewsfeed-hwc`)

| File | Changes |
|------|---------|
| `ui/src/fishy/` directory | Rename to `ui/src/holochain/` |
| `ui/src/holochain/index.ts` (was `fishy/index.ts`) | `@zippy/fishy-client` -> `@holo-host/web-conductor-client`; same identifier renames as ziptest |
| `ui/src/utils/client.ts` | `FishyAppClient` -> `WebConductorAppClient`; `waitForFishy` -> `waitForHolochain`; `fishyClient` -> `hwcClient`; `gatewayUrl: GATEWAY_URL` -> `linkerUrl: LINKER_URL`; "fishy extension" comments -> "holochain extension" |
| `ui/src/App.vue` | Import path `@/fishy` -> `@/holochain`; "fishy" comments -> "web conductor" |
| `ui/package.json` | `"@zippy/fishy-client": "file:../../fishy/packages/client"` -> `"@holo-host/web-conductor-client": "file:../../holo-web-conductor/packages/client"` |
| `ui/vite.config.ts` (if `__GATEWAY_URL__` exists) | `__GATEWAY_URL__` -> `__LINKER_URL__` |

### 6c. E2E test fixtures (in holo-web-conductor repo)

The e2e tests in holo-web-conductor reference the test apps and their behavior:

| File | Changes |
|------|---------|
| `packages/e2e/tests/fixtures.ts` | `gatewayUrl` fixture -> `linkerUrl`; `TEST_PAGE_URL` with `e2e-gateway-test.html` -> `e2e-linker-test.html` (if that HTML file exists); `fishy-e2e` sandbox dir -> `hwc-e2e` |
| `packages/e2e/tests/mewsfeed.test.ts` | "fishy extension" in test text -> "holochain extension"; `gatewayUrl` -> `linkerUrl`; "gateway" log checks -> "linker"; `fishy-e2e` path -> `hwc-e2e` |
| `packages/e2e/tests/ziptest.test.ts` | Similar changes if any fishy/gateway references exist |

### 6d. Coordination & Execution Order

The test app branches must be created **after** the holo-web-conductor client rename lands, so the file: links resolve correctly.

```
1. Land holo-web-conductor rename (Phases 3a commits 1-6)
2. Land h2hc-linker rename (Phase 3b)
3. Create ziptest `holo-web-conductor` branch with client + terminology updates
4. Create mewsfeed `holo-web-conductor` branch with same updates
5. Verify e2e tests pass with both test apps on new branches
6. Later: when @holo-host/web-conductor-client is published to npm,
   update test apps to use npm dependency instead of file: link
```

---

## 7. Verification

- `nix develop -c npm test` passes after all renames (holo-web-conductor)
- `nix develop -c cargo test` passes after rename (h2hc-linker)
- `nix develop -c npm run build:extension` produces valid extension
- Extension loads in Chrome showing "Holochain" name and logo
- All `@hwc/*` workspace imports resolve correctly
- CI workflows run green on both repos
- `npm install @holo-host/web-conductor-client` works from npm registry
- `window.holochain.isWebConductor === true` in browser
- `waitForHolochain()` utility works in client apps
- `WebConductorAppClient.connect({ linkerUrl: '...' })` works
- E2E tests pass with `H2HC_LINKER_DIR` env var and `h2hc-linker` binary
- ziptest builds and runs on `holo-web-conductor` branch
- mewsfeed builds and runs on `holo-web-conductor` branch
- GitHub Project board populated with converted issues
- No remaining references to "fishy" in active source code (STEPS historical docs excluded)
- No remaining references to "gateway" in source code
- `grep -r "hc-membrane" packages/ scripts/` returns zero results in both repos

---

## 8. Risk Mitigation

**Largest risk**: The ~120-file rename in Phase 3a could introduce subtle breakage.

Mitigations:
1. Pre-flight tag allows instant rollback
2. Execute rename on feature branch with full test suite before merge
3. Use IDE/tooling for mechanical renames (TypeScript rename symbol) rather than find-and-replace
4. Run `npm test` after each commit in the rename sequence
5. The rename is purely cosmetic - no logic changes - so failures are limited to import resolution and string matching

**Cross-repo coordination risk**: The e2e setup script must match the h2hc-linker binary name. Test apps must use new client API.

Mitigations:
1. Land h2hc-linker rename first (Rust side)
2. Then update holo-web-conductor's e2e-test-setup.sh to look for new binary name
3. Create test app branches only after conductor rename lands
4. Verify e2e with both test apps before declaring complete

**npm publishing risk**: Publishing under a new scope means the old `@zippy/fishy-client` becomes orphaned.

Mitigations:
1. Simply leave unpublished - it's at v0.1.0 and was never published to npm
2. Test apps use file: links during development, switch to npm dep for release

**Gateway terminology completeness risk**: With 763+ occurrences across 114+ files, some might be missed.

Mitigations:
1. After rename, run `grep -ri "gateway\|hc-membrane\|fishy" packages/ scripts/ src/` in all repos
2. Verify zero results in source code (documentation exclusions are fine)
3. Include this grep as a verification step in the PR checklist
