# Step 29: Meta-Analysis — Code Quality, Tech Debt, and Process Improvements

**Status**: PLANNED
**Priority**: High (accumulated debt from Steps 1-28)
**Dependencies**: None (independent sub-tasks)

## Problem Statement

Meta-analysis of the commit history (449 commits) reveals:
- **106 fix commits vs 80 feature commits** (3.3x fix-to-feature ratio in last 100)
- Repeated rework cycles (serialization loop: 6 failed approaches across sessions)
- Platform-specific bugs discovered post-merge (Chrome vs Firefox)
- Connection state machine required 6+ fixes in one week
- 25+ core modules with zero test coverage
- Multiple mega-files (2,829 and 1,883 lines) blocking testability

---

## Sub-Tasks

### 29.1 — Formalize Connection State Machine
**Priority**: High
**Files**: `packages/extension/src/background/index.ts`, `packages/core/src/network/connection-monitor.ts`

Problem: `peerCount`, `wsHealthy`, `authenticated` are set/cleared in 3+ places with race conditions between async health check and disconnect handler. Caused 6+ fix commits (6c68e09, d739a76, 59bac7c, f8396de, 748499f, e8e1606).

Tasks:
- [ ] Define explicit states: DISCONNECTED, CONNECTING, CONNECTED, AUTHENTICATED
- [ ] Define valid transitions and invariants (e.g., peerCount must be null in DISCONNECTED)
- [ ] Create single authoritative state store
- [ ] Remove redundant state updates scattered across background/index.ts
- [ ] Add tests for state transitions

---

### 29.2 — Split Mega-Files
**Priority**: High
**Files**: `packages/extension/src/background/index.ts` (2,829 lines), `packages/extension/src/offscreen/ribosome-worker.ts` (1,883 lines)

Problem: These files mix multiple responsibilities, making isolated testing impossible.

Tasks:
- [ ] Extract message routing from background/index.ts into dedicated handler
- [ ] Extract Lair operations into lair-manager module
- [ ] Extract conductor lifecycle into conductor-controller module
- [ ] Extract auth management into auth-manager module
- [ ] Split ribosome-worker.ts: WASM execution, SQLite interface, network requests, signing
- [ ] Verify all existing tests still pass after extraction

---

### 29.3 — Add Typecheck to CI
**Status**: ✅ ALREADY DONE
**Priority**: High

No work needed. `npm test` already runs `npm run typecheck` as its first step (package.json line 15), and CI runs `npm test` (.github/workflows/ci.yml line 59). Typecheck passes clean as of 2026-04-01.

---

### 29.4 — Fix Skipped Tests and Expand Coverage
**Priority**: High
**Files**: `packages/lair/src/client.test.ts`, `packages/extension/src/lib/lair-lock.test.ts`, `packages/core/src/ribosome/integration.test.ts`

Problem: 6 skipped test suites (exportSeedByTag, importSeed, LairLock, CRUD host functions, Link operations). 4 TODO items for "Insufficient data" serialization bug. 25+ core modules have zero test coverage.

Tasks:
- [ ] Investigate and fix skipped Lair tests (client.test.ts:290, 349)
- [ ] Investigate and fix LairLock test (lair-lock.test.ts:35)
- [ ] Fix "Insufficient data" serialization bug in integration.test.ts (lines 186, 397, 549, 849)
- [ ] Unskip CRUD and Link host function test suites
- [ ] Add tests for `packages/core/src/ribosome/index.ts` (611 lines, zero coverage)
- [ ] Add tests for `packages/core/src/ribosome/host-fn/call.ts` (217 lines, zero coverage)

---

### 29.5 — Platform Compatibility Checklist
**Priority**: Medium
**Files**: `CONTRIBUTING.md`

Problem: 4+ commits fixing Firefox-specific issues discovered post-implementation. No documented checklist of known platform divergences.

Tasks:
- [ ] Add "Platform Compatibility" section to CONTRIBUTING.md with known divergences:
  - Background page lifecycle (Chrome persistent, Firefox suspends)
  - Manifest differences (version_name unsupported in Firefox)
  - Dialog APIs (confirm() unavailable in Firefox extension context)
  - Storage persistence requirements
  - XMLHttpRequest sync behavior differences
- [ ] Document which files need parallel changes (firefox-direct-executor.ts vs chrome offscreen)

---

### 29.6 — Automate Build Freshness Check
**Priority**: Medium
**Files**: `package.json`, `scripts/`

Problem: Pattern 8 in LESSONS_LEARNED.md documents wasted hours debugging when dist/ was stale. Currently a manual checklist.

Tasks:
- [ ] Create script that compares source vs dist timestamps
- [ ] Integrate into e2e test pretest hook
- [ ] Warn (or fail) if dist/ is older than source changes

---

### 29.7 — Sanitize innerHTML in Extension Popup
**Priority**: Medium (security)
**Files**: `packages/extension/src/popup/lair.ts`, `packages/extension/src/popup/site.ts`

Problem: `innerHTML` used with potentially unsanitized data at lair.ts:414,750 and site.ts:42.

Tasks:
- [ ] Audit all innerHTML usage in popup code
- [ ] Replace with textContent or createElement where possible
- [ ] Add escaping for any remaining dynamic HTML

---

### 29.8 — Consistent Error Handling Strategy
**Priority**: Medium
**Files**: `packages/core/src/network/cascade.ts`, `packages/core/src/network/websocket-service.ts`, host function files

Problem: Inconsistent error handling — some paths swallow errors silently (logger.ts:76 `.catch(() => {})`), some log, some rethrow. No consistent strategy.

Tasks:
- [ ] Define error handling contract: when to propagate, when to log, when to swallow
- [ ] Audit and fix swallowed errors in critical paths
- [ ] Standardize cascade error handling (currently conditionally propagates based on two flags)

---

### 29.9 — Fix @msgpack/msgpack Version Mismatch
**Priority**: Low
**Files**: `packages/core/package.json`, `packages/client/package.json`

Problem: core uses `^3.0.0`, client uses `^2.8.0 || ^3.0.0`. Different versions have different APIs and serialization behavior.

Tasks:
- [ ] Align all packages to same @msgpack/msgpack version
- [ ] Verify serialization behavior is consistent across packages

---

### 29.10 — Improve CONTRIBUTING.md for AI Instruction Clarity
**Priority**: Low
**Files**: `CONTRIBUTING.md`, `CLAUDE.md`

Problem: Instructions exist but don't prevent repeated mistakes. Serialization loop happened 3+ times. Platform bugs discovered post-merge.

Tasks:
- [ ] Add "STOP gates" — sections that must be checked before touching specific areas (serialization, platform code, state management)
- [ ] Link LESSONS_LEARNED.md from code comments in serialization.ts
- [ ] Add pre-merge checklist template covering typecheck, platform compat, edge cases
- [ ] Remove WIP commits guidance (require branches for incomplete work)

---

## Execution Order

Recommended sequence (dependencies noted):

1. **29.3** (typecheck in CI) — quick win, catches issues in all other sub-tasks
2. **29.1** (state machine) — highest bug density area
3. **29.2** (split mega-files) — enables better testing for 29.4
4. **29.4** (fix tests) — benefits from 29.2 and 29.3
5. **29.7** (innerHTML security) — independent, small scope
6. **29.5** (platform checklist) — documentation, low risk
7. **29.6** (build freshness) — scripting, independent
8. **29.8** (error handling) — broad scope, benefits from earlier refactoring
9. **29.9** (msgpack version) — low priority, low risk
10. **29.10** (instruction clarity) — incorporate learnings from all above
