# Current Session

**Last Updated**: 2026-02-12
**Current Step**: Step 21 (Firefox Compatibility) — planned, starting implementation
**Parallel**: Step 19 remains blocked on Step 19.2

---

## Active Work

### Step 21: Firefox Compatibility

**Goal**: Make the fishy extension fully compatible with Firefox in addition to Chrome, with a dual-build system producing separate browser-specific outputs.

**Status**: Starting implementation

**Uses git worktree**: `../fishy-step21/` — fishy worktree (branch `step-21-firefox`)

#### Core Challenge

Firefox lacks `chrome.offscreen`, `SharedArrayBuffer` (for regular extensions), and `chrome.runtime.getContexts()`. The synchronous WASM execution chain must be replaced with a Firefox-compatible alternative.

**Solution**: Firefox Workers CAN do synchronous XMLHttpRequest directly. The ribosome worker makes network calls and signs data directly, without SharedArrayBuffer coordination.

#### Implementation Phases

1. Browser abstraction layer (`browser-api.ts`)
2. Dual manifest + build system (Chrome/Firefox variants)
3. Executor interface (abstract offscreen management)
4. Firefox worker architecture (direct sync XHR + key preloading)
5. Serialization boundary audit
6. SQLite / OPFS verification
7. E2E testing on Firefox
8. WebSocket + signals on Firefox

See [STEPS/21_PLAN.md](./STEPS/21_PLAN.md) for full plan.

#### Critical Risk to Verify Early

Do Workers in Firefox extension context inherit `host_permissions` for cross-origin XHR? If not, fallback to running WASM in the background event page.

---

### Step 19: Mewsfeed E2E Test (BLOCKED)

**Status**: BLOCKED on Step 19.2 (hc-membrane kitsune DHT ops)

See previous session notes in git history for full Step 19 context.

---

## Quick Links

- [Step Registry](./STEPS/index.md) — All step statuses
- [Step 21 Plan](./STEPS/21_PLAN.md) — Firefox compatibility plan
- [Step 19.2](./STEPS/19.2_HC_MEMBRANE_KITSUNE_DHT_OPS.md) — hc-membrane kitsune DHT ops (blocking 19)
- [Failed Approaches](./LESSONS_LEARNED.md)
