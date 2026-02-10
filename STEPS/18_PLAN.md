# Step 18: Zome Call Serialization

## Goal

Prevent concurrent zome calls from corrupting the source chain by serializing execution. Currently, two simultaneous zome calls can interleave at `await` points within the transaction window, causing SQLite "cannot start a transaction within a transaction" errors or silent data corruption.

**Current Problem:**
- `self.onmessage` in ribosome-worker is `async` — two posted messages can interleave at `await` points
- `offscreen/index.ts:executeZomeCall()` is fire-and-forget (no serialization)
- Between `beginTransaction()` and `commitTransaction()` there are multiple `await` points: `WebAssembly.instantiate`, `sodium.ready`, `import('@msgpack/msgpack')`, integrity zome metadata init
- If Call B starts while Call A has an active SQLite transaction, `BEGIN TRANSACTION` throws
- No Holochain-style `HeadMoved` detection exists as a fallback

**Concurrency sources (not just UI):**
- **UI-initiated calls**: App JS calls zome functions via `@holochain/client` — multiple concurrent calls are common
- **Network-initiated calls**: Remote signals arrive via WebSocket → background dispatches `recv_remote_signal` as a full zome call via `executeZomeCallViaOffscreen()` (background/index.ts:2259). The WASM `recv_remote_signal` callback can call any host function including `create`, `update`, `delete`, `create_link` — so a signal arrival can commit to the source chain while a UI call is in progress.
- **Reconnect-triggered publishes**: On WebSocket reconnect, `processQueue()` retries failed publishes (offscreen/index.ts:457) — these are network-only, not zome calls, but worth noting.

**Why serialize (not optimistic concurrency):**
- Fishy is a zero-arc node — no gossip, no concurrent validation workflows
- Serialization is simple, correct, and sufficient for the workload
- Optimistic concurrency (rebase + re-sign) adds significant complexity for minimal benefit here

---

## Key Constraints

1. **Must not break existing single-call behavior** — serialization is a no-op when calls don't overlap
2. **Must preserve error propagation** — if a zome call fails, the caller gets the error, not the next queued call
3. **Must handle rollback correctly** — a failed call must release the lock so the next call can proceed
4. **Signal delivery timing** — signals emitted during a zome call should still be delivered promptly
5. **No deadlocks** — if WASM execution hangs (e.g., infinite loop), the queue must not block forever

---

## Analysis: Where to serialize

There are two places a queue could go:

| Location | Pros | Cons |
|----------|------|------|
| **Worker `onmessage`** | Closest to the problem; protects SQLite directly | Only protects worker; other message types (INIT, CONFIGURE_NETWORK) would also queue |
| **Offscreen `executeZomeCall`** | Natural chokepoint; can be selective to CALL_ZOME only | Slightly further from SQLite; adds latency from message passing |

**Choice: Worker `onmessage` with selective queueing for `CALL_ZOME`** — this is the simplest fix and directly protects the shared SQLite resource. Non-zome messages (INIT, CONFIGURE_NETWORK, SET_LOG_FILTER) can still execute immediately since they don't touch transactions.

---

## Implementation Plan

### Phase 1: Add zome call queue to worker

**Goal**: Ensure only one `CALL_ZOME` message processes at a time in the worker.

**Approach**: Promise-chain serialization. Maintain a `let zomeCallChain: Promise<void>` that each `CALL_ZOME` handler appends to.

**File**: `packages/extension/src/offscreen/ribosome-worker.ts`

Changes:
- [ ] Add a module-level `let zomeCallChain: Promise<void> = Promise.resolve()`
- [ ] In the `CALL_ZOME` case of `onmessage`, wrap the existing logic in a function that chains onto `zomeCallChain`
- [ ] Non-CALL_ZOME messages continue to execute immediately (no queueing)
- [ ] The chain catches errors per-call so one failure doesn't break the queue

Sketch:
```typescript
let zomeCallChain: Promise<void> = Promise.resolve();

// Inside onmessage, case 'CALL_ZOME':
const callPromise = zomeCallChain.then(async () => {
  // ... existing CALL_ZOME logic (storage.setCellContext, callZome, etc.)
});
zomeCallChain = callPromise.catch(() => {}); // swallow so chain continues
result = await callPromise; // propagate errors to this specific caller
```

### Phase 2: Test concurrent zome calls

**Goal**: Verify that two concurrent zome calls execute sequentially without errors.

**File**: New test in `packages/core/src/ribosome/` or `packages/extension/src/offscreen/`

Tests:
- [ ] Two concurrent `create_entry` calls both succeed and produce sequential chain actions
- [ ] A UI zome call and a signal-triggered `recv_remote_signal` (that commits) both succeed sequentially
- [ ] A failing zome call does not block the next queued call
- [ ] Chain head after two concurrent commits has `action_seq` incremented by 2
- [ ] Non-CALL_ZOME messages (e.g., SET_LOG_FILTER) are not blocked by an in-progress zome call

### Phase 3: Timeout safety valve

**Goal**: Prevent a hung WASM call from blocking the queue forever.

**File**: `packages/extension/src/offscreen/ribosome-worker.ts`

Changes:
- [ ] Wrap each queued call in a timeout (e.g., 60 seconds)
- [ ] On timeout, rollback any active transaction and reject the call
- [ ] Log a warning so the hung call is diagnosable

---

## Files Changed

| File | Change |
|------|--------|
| `packages/extension/src/offscreen/ribosome-worker.ts` | Add promise-chain serialization for CALL_ZOME |
| `packages/core/src/ribosome/zome-call-serialization.test.ts` (new) | Concurrent call tests |

---

## Success Criteria

1. Two concurrent `create_entry` zome calls both succeed — no SQLite transaction errors
2. Chain state is consistent: sequential `action_seq`, correct `prev_action` hashes
3. A failing zome call does not prevent subsequent calls from executing
4. Existing tests pass unchanged (serialization is transparent to single calls)
5. Non-zome-call worker messages are unaffected by the queue
