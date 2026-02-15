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

**Methodology**: The same concurrency bug exists with `SourceChainStorage` (fake-indexeddb in Node) — `beginTransaction()` throws "Transaction already in progress" when two concurrent `callZome()` calls interleave at `await` points. This means we can:

1. **Prove the bug in vitest**: Launch two `callZome()` calls via `Promise.all()`. The second hits `beginTransaction()` while the first's transaction is active → throws. This demonstrates the real-world failure mode.

2. **Prove the fix in vitest**: Wrap `callZome()` in a `serializedCallZome()` using the same promise-chain pattern as the worker. Run the same concurrent calls → both succeed.

3. **Verify chain integrity**: After serialized concurrent calls, inspect chain head to confirm `action_seq` advanced correctly and the chain is internally consistent.

No browser or worker environment needed. The test validates the behavioral pattern, and the worker applies the identical 3-line pattern.

**File**: `packages/core/src/ribosome/concurrent-calls.test.ts` (new)

Tests:
- [ ] Two concurrent `callZome(create_test_entry)` via `Promise.all()` without serialization → one fails with "Transaction already in progress"
- [ ] Same two calls through `serializedCallZome()` wrapper → both succeed, return valid ActionHashes
- [ ] Chain head `action_seq` after two serialized concurrent creates = genesis_seq + 2
- [ ] A failing call (bad fn name) does not block the next queued call
- [ ] Three+ concurrent calls all serialize correctly (stress variant)

### Phase 3: Timeout safety valve — DEFERRED

**Goal**: Prevent a hung WASM call from blocking the queue forever.

**Status**: Deferred. `Atomics.wait()` blocks the worker thread entirely during WASM execution, which prevents `setTimeout` callbacks from firing. A timeout would only catch hangs in the async setup phase (compile, instantiate) but not the main risk (WASM infinite loops). Adding it also introduces a race condition where the caller gets a timeout error but the call may still commit. For now, the browser's own tab/worker kill mechanism handles truly hung WASM.

---

## Files Changed

| File | Change |
|------|--------|
| `packages/extension/src/offscreen/ribosome-worker.ts` | Add promise-chain serialization for CALL_ZOME |
| `packages/core/src/ribosome/concurrent-calls.test.ts` (new) | Concurrent call tests (vitest, no browser needed) |

---

## Success Criteria

1. Two concurrent `create_entry` zome calls both succeed — no SQLite transaction errors
2. Chain state is consistent: sequential `action_seq`, correct `prev_action` hashes
3. A failing zome call does not prevent subsequent calls from executing
4. Existing tests pass unchanged (serialization is transparent to single calls)
5. Non-zome-call worker messages are unaffected by the queue
