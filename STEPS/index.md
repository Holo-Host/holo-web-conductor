# Step Status Registry

> **Purpose**: Single source of truth for step completion status. Update this file when steps are completed.

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
| 10.1 | ✅ | FishyAppClient Adapter |
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
| 14 | ✅ | Fishy Client Library Package |
| 14.1 | ✅ | Package Setup & Migration |
| 14.2 | ✅ | Connection Status Interface |
| 14.3 | ✅ | Enhanced FishyAppClient |
| 14.4 | ✅ | Extension API Enhancements |
| 15 | 📋 | Robust Publish Verification |
| 16 | ⏳ | E2E Debugging Automation |
| 17 | ⏳ | hc-membrane 0.6.1 Integration |
| 19 | ⏳ | Mewsfeed E2E Integration |
| 19.1 | 📋 | get_joining_timestamp deserialization (non-blocking) |
| 19.2 | ✅ | hc-membrane kitsune DHT ops (get_details, count_links) |
| 19.3 | ❌ | Kitsune2 query-response timeout (hc-membrane) |
| 19.4 | ❌ | Published DhtOps not queryable (depends on 19.3) |
| 19.5 | 📋 | Sync XHR timeout reduction (fishy) |
| 19.6 | 📋 | get_agent_activity host function (fishy) |
| Meta-1 | 📋 | Process Review (periodic) |

**Legend**: ✅ Complete | ⏳ In Progress | 📋 Recurring | ❌ Blocked | 📋 Planned

---

## Pending Steps

### Step 9: Additional Holochain Features
- **9.1** Implement `get_agent_activity`
- **9.2** Implement `must_get*` functions
- **9.3** Implement validation callbacks

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

### Step 16: E2E Debugging Automation
**Priority**: High (developer productivity)
**Status**: In Progress

Enable Claude to run e2e tests programmatically without manual intervention:
- Playwright-based test runner with extension loading
- Environment manager wrapping e2e-test-setup.sh
- Log aggregation from gateway/conductor/extension
- Structured JSON output for programmatic parsing

See [16_PLAN.md](./16_PLAN.md)

### Step 17: hc-membrane 0.6.1 Integration
**Priority**: High (required for Holochain 0.6.1 compatibility)
**Status**: In Progress - Partial Success
**Depends On**: hc-membrane repo (separate)

See Step 19 for current mewsfeed integration work that builds on Step 17.

### Step 19: Mewsfeed E2E Integration
**Priority**: High (validates full multi-agent data flow)
**Status**: In Progress — query-response path broken
**Depends On**: hc-membrane kitsune-dht-ops branch

Multi-agent e2e test: Alice creates mew with hashtag, Bob searches for it.

**Sub-steps** (can be worked in parallel where noted):

| Sub-step | Repo | Priority | Parallelizable | Doc |
|----------|------|----------|----------------|-----|
| 19.1 | fishy | Low | Yes | [19.1_ISSUE_GET_JOINING_TIMESTAMP.md](./19.1_ISSUE_GET_JOINING_TIMESTAMP.md) |
| 19.2 | hc-membrane | Done | — | [19.2_HC_MEMBRANE_KITSUNE_DHT_OPS.md](./19.2_HC_MEMBRANE_KITSUNE_DHT_OPS.md) |
| 19.3 | hc-membrane | Critical | No (blocks 19.4) | [19.3_KITSUNE_QUERY_RESPONSE_TIMEOUT.md](./19.3_KITSUNE_QUERY_RESPONSE_TIMEOUT.md) |
| 19.4 | hc-membrane | High | No (after 19.3) | [19.4_PUBLISHED_DATA_NOT_QUERYABLE.md](./19.4_PUBLISHED_DATA_NOT_QUERYABLE.md) |
| 19.5 | fishy | Medium | Yes | [19.5_SYNC_XHR_TIMEOUT_REDUCTION.md](./19.5_SYNC_XHR_TIMEOUT_REDUCTION.md) |
| 19.6 | fishy | Medium | Yes | [19.6_GET_AGENT_ACTIVITY_HOST_FN.md](./19.6_GET_AGENT_ACTIVITY_HOST_FN.md) |

**Critical path**: 19.3 → 19.4 → re-test e2e
**Independent**: 19.1, 19.5, 19.6 can be done in parallel with each other and with the critical path

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
