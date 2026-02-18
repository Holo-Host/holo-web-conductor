# Step Status Registry

> **Purpose**: Single source of truth for step completion status. Update this file when steps are completed.

> **Note**: Historical steps (1-21, 23-24) were developed under the original "fishy" codename. Documentation within those step files uses the old terminology (fishy, gateway, hc-membrane). The project was renamed to **holo-web-conductor** (HWC) in Step 22.

## Quick Reference

| Step | Status | Description |
|------|--------|-------------|
| 0 | ✅ | Plan Refinement |
| 1 | ✅ | Browser Extension Base |
| 2 | ✅ | Lair Keystore Implementation |
| 2.5 | ✅ | Lair UI Integration |
| 3 | ✅ | Authorization Mechanism |
| 4 | ✅ | hApp Context Creation |
| 5 | ✅ | WASM Execution with Mocked Host Functions |
| 5.5 | ✅ | HDK Test Zome |
| 5.6 | ✅ | Complete Host Functions and Data Types |
| 5.7 | ✅ | .happ Bundle Support |
| 6 | ✅ | Storage Infrastructure |
| 6.5 | ✅ | Host Function Integration |
| 6.6 | ✅ | Automated Integration Testing |
| 6.7 | ✅ | Test with profiles |
| 7 | ✅ | Network Host Functions |
| 7.2 | ✅ | Gateway Network Integration |
| 7.3 | ✅ | Type Safety |
| 8 | ✅ | DHT Publishing |
| 8.0 | ✅ | Hash Computation (Blake2b) |
| 8.1 | ✅ | DhtOp Generation |
| 8.2 | ✅ | Op Signing Protocol |
| 8.3 | ✅ | Gateway Publish Endpoint |
| 8.4 | ✅ | Publish Tracking |
| 8.5 | ✅ | Integration & Publish Workflow |
| 9.5 | ✅ | Gateway Real-Time Connection |
| 9.6 | ✅ | Kitsune2 Remote Signal Forwarding |
| 9.7 | ✅ | Signal E2E Testing |
| 10 | ✅ | Integration Testing |
| 10.1 | ✅ | WebConductorAppClient Adapter |
| 10.2 | ✅ | Remote Signal Architecture Fix |
| 11 | ✅ | Synchronous SQLite Storage Layer |
| 12 | ⏳ | Code Quality & Testing Improvements |
| 12.1 | ✅ | Unified Encoding Documentation |
| 12.2 | ⏳ | DHT Publishing Debug Panel |
| 12.3 | ⏳ | Test Audit |
| 13 | 📋 | Storage Backup & Recovery |
| 13.1 | 📋 | Persistent Storage + Seed Phrase Export |
| 13.2 | 📋 | DHT Chain Recovery |
| 13.3 | 📋 | Convenience Features (backup file, sync) |
| 14 | ✅ | HWC Client Library Package |
| 14.1 | ✅ | Package Setup & Migration |
| 14.2 | ✅ | Connection Status Interface |
| 14.3 | ✅ | Enhanced WebConductorAppClient |
| 14.4 | ✅ | Extension API Enhancements |
| 15 | 📋 | Robust Publish Verification |
| 16 | ✅ | E2E Debugging Automation (Playwright infrastructure) |
| 17 | ✅ | h2hc-linker 0.6.1 Integration (core complete, see notes) |
| 18 | ✅ | Zome Call Serialization |
| 19 | ✅ | Mewsfeed E2E (merged; blocked upstream on kitsune2 timeout) |
| 20 | ✅ | Validation Host Functions & Validate Callback |
| 21 | ✅ | Firefox Compatibility Plan (plan doc only) |
| 22 | ✅ | Migration to holo-host GitHub Org + Rename |
| 23 | ✅ | Agent Activity Network Integration |
| 24 | ✅ | Kitsune2 DHT Query Fix (resolved in 19.3/M4) |
| CI | ✅ | GitHub Actions CI for HWC and h2hc-linker |
| Meta-1 | 📋 | Process Review (periodic) |

**Legend**: ✅ Complete | ⏳ In Progress | 🔀 Pending Merge | 📋 Planned | ❌ Blocked

---

## Pending Steps

### Step 9: Additional Holochain Features (all complete)
- **9.1** ✅ `get_agent_activity` (commit ffb3ac0)
- **9.2** ✅ `must_get*` functions (Step 20)
- **9.3** ✅ Validation callbacks (Step 20)

### Step 12.2: DHT Publishing Debug Panel
See [12.2_PLAN.md](./12.2_PLAN.md)

### Step 12.3: Test Audit
See [12.3_PLAN.md](./12.3_PLAN.md)

### Step 13: Storage Backup & Recovery
**Priority**: High (data loss risk mitigation)

Protect against data loss from extension uninstall or browser cache clear:
- **13.1** Request persistent storage, implement seed phrase export/import
- **13.2** DHT-based chain recovery for published data
- **13.3** Manual backup file, chrome.storage.sync bootstrap

See [13_PLAN.md](./13_PLAN.md)

### Step 15: Robust Publish Verification
**Priority**: Medium (reliability improvement)

Ensure publishing only proceeds when network connectivity is verified:
- Add peer count to WebSocket protocol (gateway sends connected peer count in ping/pong)
- Wait for at least one peer connection before allowing publish attempts
- Provide UI feedback when waiting for peers
- Replace current 2-second delay heuristic with actual peer verification

**Background**: Currently auto-retry on reconnect uses a 2-second delay to hope agent registration propagates. This should verify actual peer connectivity instead.

### Step 16: E2E Debugging Automation (complete)
**Status**: Complete

Playwright-based e2e test infrastructure in `packages/e2e/`:
- `src/environment.ts` - EnvironmentManager wrapping e2e-test-setup.sh
- `src/browser-context.ts` - Playwright persistent context with extension loading
- `src/log-collector.ts` - Multi-source log aggregation
- `src/test-runner.ts` - Test execution orchestration
- `tests/ziptest.test.ts`, `tests/mewsfeed.test.ts` - E2E test suites
- `playwright.config.cjs` - Chromium extension project with JSON reporter

See [16_PLAN.md](./16_PLAN.md) for original design.

### Step 17: h2hc-linker 0.6.1 Integration (complete)
**Status**: Complete (all changes committed to hc-membrane branch)

Integrated HWC extension with h2hc-linker (kitsune2 0.4.x + iroh transport).
Core functionality works: agent registration, preflight exchange, publishing, get_links, cross-agent profile visibility.

**Known upstream issue**: Kitsune2 query-response path broken -- blocks all real multi-node operation (see Step 24).

### Step 18: Zome Call Serialization (complete)
Promise-chain serialization in ribosome worker for CALL_ZOME messages.
See [18_PLAN.md](./18_PLAN.md)

### Step 24: Kitsune2 DHT Query Fix (resolved)
**Status**: Complete — resolved as part of M4 milestone (kitsune-dht-ops branch, merged to main).
See [19.3_KITSUNE_QUERY_RESPONSE_TIMEOUT.md](./19.3_KITSUNE_QUERY_RESPONSE_TIMEOUT.md) for investigation details and test coverage.

### Step 22: Migration to holo-host GitHub Org + Full Rename (complete)
**Status**: Complete

Full rename from fishy to holo-web-conductor (HWC):
- Package names: `@fishy/*` -> `@hwc/*`, `@zippy/fishy-client` -> `@holo-host/web-conductor-client`
- Source code: all fishy/gateway references renamed to hwc/linker
- Extension: user-facing name "Holochain" with placeholder icons
- Documentation: updated throughout
- E2E: env vars renamed `HC_MEMBRANE_*` -> `H2HC_LINKER_*`

See [22_PLAN.md](./22_PLAN.md)

---

## Recurring Steps

### Meta-1: Process Review
**Frequency**: Every 2-3 major steps or when significant rework is identified

**Checklist**:
- [ ] Review recent commits for fix/WIP ratio
- [ ] Check if FAILED_APPROACHES.md needs new entries
- [ ] Verify CLAUDE.md is still concise (~150 lines)
- [ ] Assess step granularity of upcoming work
- [ ] Update this index if steps were added/modified

See [META_1_PROCESS_REVIEW.md](./META_1_PROCESS_REVIEW.md)

---

## Documentation Files

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Core rules and quick context (~150 lines) |
| `SESSION.md` | Current step focus only |
| `LESSONS_LEARNED.md` | Failed approaches archive |
| `STEPS/index.md` | This file - step registry |
| `STEPS/X_PLAN.md` | Detailed plan for step X |
| `STEPS/X_COMPLETION.md` | Completion notes for step X |
