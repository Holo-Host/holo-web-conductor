# Step 22: Migration to holo-host GitHub Org

## Goal

Migrate fishy and hc-membrane repos from `zippy` GitHub org to `holo-host`. Publish `@holo-host/fishy-client` as a real npm package. Evolve the solo-developer step-based process into a team workflow with GitHub Projects/Issues for 2-3 contributors (humans + agents).

---

## 1. Repo Structure Decision

**Recommendation: 2 repos** (fishy monorepo + hc-membrane)

| Option | Pros | Cons |
|--------|------|------|
| **3 repos** (client, extension, membrane) | Independent client versioning | Client has a `copy-to-test` build coupling to extension; 3 repos to coordinate for 2-3 people is overhead |
| **2 repos** (fishy monorepo, membrane) | Client stays testable alongside extension; npm publish from monorepo is standard practice (Babel, React do this); matches natural TS/Rust language boundary | Client releases tied to monorepo tags (mitigated with `client-v*` tag prefix) |
| **1 monorepo** (everything) | Atomic cross-language changes | Polyglot CI complexity; separate nix flakes; Rust contributors forced into TS toolchain and vice versa |

The client is fully decoupled (zero `@fishy/*` imports, peer-depends only on `@holochain/client`) so extraction is trivial *if needed later*. Start with 2 repos, split client out only if release cadence diverges significantly.

---

## 2. Migration Phases

### Phase 1: GitHub Org Setup

1. Create empty repos: `holo-host/fishy`, `holo-host/hc-membrane`
2. Create GitHub Team: `fishy-maintainers` (Admin on both repos)
3. Branch protection on `main`:
   - Require PR reviews (1 approval)
   - Require CI status checks to pass
   - Auto-delete head branches after merge
4. Create org-level **GitHub Project** board with columns: Backlog / In Progress / In Review / Done
   - Custom fields: `Component` (client | extension | core | lair | gateway), `Priority` (P0/P1/P2)

### Phase 2: Transfer Repos

**Preferred: GitHub "Transfer repository"** (Settings > Danger Zone) preserves all history, stars, issues. GitHub creates automatic redirects from `zippy/*` URLs.

If transfer isn't available, push to new remotes:
```bash
# fishy
git remote set-url origin git@github.com:holo-host/fishy.git
git push origin --all && git push origin --tags

# hc-membrane
git remote set-url origin git@github.com:holo-host/hc-membrane.git
git push origin --all && git push origin --tags
```

### Phase 3: Code Changes (fishy repo)

**Commit 1**: `chore: rename npm scope to @holo-host`

| File | Change |
|------|--------|
| `packages/client/package.json` | `@zippy/fishy-client` -> `@holo-host/fishy-client`; repo URL -> `https://github.com/holo-host/fishy` |
| `packages/client/README.md` | All `@zippy/fishy-client` references (6 locations) |
| `packages/client/src/index.ts` | Doc comments (2 locations) |
| `packages/client/src/FishyAppClient.ts` | Doc comment (1 location) |
| `package-lock.json` | Regenerate via `npm install` |

Note: The repo URL currently points to `anthropics/fishy` (stale) - fix to `holo-host/fishy`.

**Internal `@fishy/*` package names stay unchanged.** They are private workspace packages, never published, and renaming them would touch dozens of import statements for zero functional benefit.

**Commit 2**: `docs: update references for org migration`
- Update `@zippy` references in `STEPS/14_PLAN.md` and `STEPS/14_COMPLETION.md` (historical docs)

### Phase 4: CI/CD Setup

**fishy: `.github/workflows/ci.yml`** (on push to main + PRs)
```
- checkout
- nix-installer-action + magic-nix-cache-action
- nix develop -c npm ci
- nix develop -c npm run build
- nix develop -c npm run lint
- nix develop -c npm test
- Upload extension build artifact
```

**fishy: `.github/workflows/publish-client.yml`** (on `client-v*` tags)
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
- `LESSONS_LEARNED.md` - invaluable, no changes
- `STEPS/` directory - becomes read-only historical archive

**What evolves:**

`SESSION.md` simplifies to:
- Current branch + active issue number(s)
- Environment setup commands
- Remove detailed sub-task tracking (moves to GitHub Issues)

`STEPS/index.md` gets a header marking it as historical; new work tracked in GitHub Project board.

**New files (both repos):**
- `CONTRIBUTING.md` - dev setup, branch naming, PR process
- `.github/ISSUE_TEMPLATE/feature.md` and `bug.md`

**Convert in-progress STEPS to GitHub Issues:**
- Step 16 (E2E Automation) -> Issue with remaining validation checklist
- Step 17 (hc-membrane 0.6.1 Integration) -> Issue with active-status diagnosis tasks
- Planned steps (13, 15) -> Issues in Backlog

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

Update reference sources to include `hc-membrane` alongside `hc-http-gw-fork`:
```markdown
3. Gateway: `../hc-membrane` (primary) or `../hc-http-gw-fork` (legacy)
```

### Phase 7: Multi-Agent Collaboration Setup (optional)

Claude Code has an experimental **agent teams** feature:
- One session acts as "team lead", assigns work to teammate sessions
- Teammates work independently with direct peer-to-peer messaging
- Shared task list with dependency management

Enable with:
```json
// .claude/settings.json
{ "env": { "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1" } }
```

Best for: parallel code reviews, investigating competing hypotheses, cross-layer work (e.g., one agent on extension frontend, another on core backend).

**Limitation**: Requires tmux or iTerm2; session resumption doesn't work with in-process teammates.

For a 2-3 person team, the simpler approach is:
- Shared `CLAUDE.md` conventions (committed to git)
- `.claude/rules/` directory for modular path-specific rules if needed
- Each contributor (human or agent) works on their own branch tied to a GitHub Issue
- PRs provide the coordination point

### Phase 8: Publish and Verify

1. Tag `client-v0.1.0`, verify CI publishes `@holo-host/fishy-client` to npm
2. Test: `npm install @holo-host/fishy-client` in a fresh project
3. Verify CI passes on both repos
4. Verify GitHub Project board has all active issues

---

## 3. Execution Order Summary

```
1. Pre-flight: tag snapshots, verify tests pass
2. GitHub org setup (repos, teams, protection, project board)
3. Transfer repos (or push to new remotes)
4. Code changes: npm scope rename + regenerate lockfile
5. CI/CD: create workflow files, npm token, .npmrc
6. Process docs: CONTRIBUTING.md, issue templates, CLAUDE.md updates
7. Convert STEPS to GitHub Issues
8. Publish verification: tag + npm publish test
9. Cleanup: archive old org repos if using push method
```

---

## 4. Files Modified/Created Summary

**Modified (fishy):**
- `packages/client/package.json` - scope + repo URL
- `packages/client/README.md` - scope references
- `packages/client/src/index.ts` - doc comments
- `packages/client/src/FishyAppClient.ts` - doc comment
- `package-lock.json` - regenerated
- `CLAUDE.md` - team workflow section
- `SESSION.md` - simplified
- `STEPS/index.md` - historical archive header
- `STEPS/14_PLAN.md`, `STEPS/14_COMPLETION.md` - scope references

**Created (fishy):**
- `.github/workflows/ci.yml`
- `.github/workflows/publish-client.yml`
- `.github/ISSUE_TEMPLATE/feature.md`
- `.github/ISSUE_TEMPLATE/bug.md`
- `.npmrc`
- `CONTRIBUTING.md`

**Created (hc-membrane):**
- `.github/workflows/ci.yml`
- `.github/ISSUE_TEMPLATE/feature.md`
- `.github/ISSUE_TEMPLATE/bug.md`
- `CONTRIBUTING.md`

**Modified (hc-membrane):**
- `CLAUDE.md` - team workflow section

**NOT changed:**
- Internal `@fishy/*` package names (private workspace packages)
- `flake.nix` in either repo
- `Cargo.toml` in hc-membrane
- TypeScript import statements using `@fishy/*`

## 5. Verification

- `nix develop -c npm test` passes after scope rename
- `nix develop -c npm run build:extension` produces valid extension
- CI workflows run green on both repos
- `npm install @holo-host/fishy-client` works from npm registry
- GitHub Project board populated with converted STEPS issues
