# Agent Teams Guide

> For the human project manager coordinating AI agent teams on the fishy project.

---

## Quick Start

### 1. Enable experimental agent teams

Already configured in `.claude/settings.local.json`. Verify the env var is set:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

### 2. Launch a team session

```bash
# Start Claude Code normally - it reads .claude/agents/ automatically
claude

# Or specify agents explicitly
claude --agents coordinator,core,extension,testing
```

### 3. Assign work

Tell the coordinator what to do. It will delegate to domain agents:

```
Plan step 12.2 (DHT debug panel) for the extension agent and step 12.3 (test audit)
for the testing agent. These can run in parallel.
```

Or assign directly to a domain agent:

```
@core Add a new host function for get_agent_activity. Follow the template in ARCHITECTURE.md.
```

---

## Team Structure

| Agent | Domain | File Ownership | When to Use |
|-------|--------|----------------|-------------|
| **coordinator** | Cross-cutting planning, integration, verification | All files (read); delegates edits to domain agents | Starting new steps, integration testing, cross-cutting changes |
| **core** | WASM runtime, host functions, serialization, storage, network, DHT, crypto | `packages/core/`, `packages/lair/`, `packages/shared/` | Host function changes, storage work, network/cascade, DHT ops, hash/signing |
| **extension** | Browser extension, messaging, UI, offscreen/workers, Chrome/Firefox | `packages/extension/` | UI changes, message routing, offscreen/worker changes, browser compat |
| **testing** | E2E tests, client library, test vectors, DNA/hApp builds, test audit | `packages/e2e/`, `packages/client/`, `packages/test-zome/`, `fixtures/`, `*.test.ts` | Test writing, e2e setup, test audit, client library, DNA builds |

### File ownership is advisory

Agents can read any file (they need to understand cross-package types and contracts). They should only **edit** files in their owned directories. When a task requires editing across boundaries, the coordinator should break it into sub-tasks for each domain agent.

---

## Workflow

### Assigning Tasks

**Option A: Through the coordinator**
Tell the coordinator what you want done. It reads the step plans, understands the architecture, and delegates to domain agents with proper context.

```
Start step 13.1 (persistent storage + seed phrase export).
The core agent should implement the storage changes,
the extension agent should add the UI for seed phrase display/import.
```

**Option B: Direct to a domain agent**
When you know exactly which agent should do the work:

```
@testing Run the test audit from STEPS/12.3_PLAN.md.
Start with HIGH severity items in packages/core/.
```

**Option C: Parallel tasks**
Assign independent tasks to multiple agents simultaneously:

```
I want two tasks in parallel:
1. @extension Implement the DHT debug panel (step 12.2)
2. @testing Run the test quality audit (step 12.3)
These are independent - no coordination needed.
```

### Monitoring Progress

- Each agent tracks its own progress
- The coordinator can check on other agents via the shared task list
- Run `npm test` periodically to catch integration issues early
- Check git status to see what files have been modified

### Integration Checkpoints

After agents complete their work:

1. **Run full test suite**: `npm test` from repo root
2. **Check for WASM boundary violations**: Did any agent bypass `serializeToWasm()`?
3. **Verify Chrome message passing**: Any new Uint8Array data crossing Chrome boundaries?
4. **Review cross-package imports**: Do new imports resolve correctly?

---

## Cross-Cutting Invariants

These rules apply to ALL agents. They are included in every agent definition, but as PM you should verify compliance during integration.

### WASM Boundary (never bypass)

1. All data INTO WASM -> `serializeToWasm()`. The "double encoding" is intentional (ExternIO contract).
2. All data FROM WASM -> `deserializeFromWasm()`.
3. All host function returns -> `serializeResult()` (wraps in `{Ok: data}`).

### Error Diagnostic Table

When an agent reports one of these errors, the cause is known:

| Error | Cause | Fix |
|-------|-------|-----|
| `"expected byte array, got map"` | Missing ExternIO wrapper | `serializeToWasm()` not raw write |
| `"expected Ok or Err"` | Missing Result wrapper | `serializeResult()` not `serializeToWasm()` |
| `"Offset outside DataView bounds"` | Wrong encoding format | Double vs single encoding mismatch |
| `"BadSize"` / hash length mismatch | 32-byte vs 39-byte hash | `hashFrom32AndType()` or `ensureAgentPubKey()` |

If an agent is debugging one of these for more than a few minutes, intervene. The fix is in the table.

### Commit Rules

- No claude co-authored messages
- Run `npm test` before committing
- Update `SESSION.md` and `STEPS/index.md` with progress
- Use `nix develop -c` for all cargo builds and npm scripts

---

## Integration Protocol

Integration is the highest-risk moment (per META_2_PROCESS_REVIEW.md). When multiple agents have completed work:

### Step 1: Verify each agent's work independently
```bash
npm test  # All packages pass?
```

### Step 2: Check for boundary violations
```bash
# Did anyone bypass serializeToWasm?
grep -r "wasmAllocate\|writeToWasmMemory" packages/ --include="*.ts" -l
# These should ONLY appear in serialization.ts itself
```

### Step 3: Check for Chrome message passing issues
```bash
# Any new Uint8Array data sent across Chrome boundaries without normalization?
grep -r "chrome.runtime.sendMessage\|chrome.tabs.sendMessage" packages/extension/ --include="*.ts" -l
# Verify each call site normalizes Uint8Array data
```

### Step 4: Run e2e if applicable
```bash
# Start environment
scripts/e2e-test-setup.sh start --happ=ziptest --gateway=membrane
# Run tests
cd packages/e2e && npx playwright test
```

---

## Pilot Task: Step 12.2 + Step 12.3

The first parallel task to validate the team workflow.

### Assignment

**Extension agent** -> Step 12.2: DHT Publishing Debug Panel
- Add debug button to each hApp card in popup
- Show publish status (pending/in-flight/failed)
- "Retry Failed" and "Republish All" buttons
- Files: `popup/happs.ts`, `popup/popup.css`, `lib/messaging.ts`, `background/index.ts`, `offscreen/index.ts`, `offscreen/ribosome-worker.ts`
- Also needs: `packages/core/src/dht/publish-tracker.ts` (coordinate with core agent or handle the minimal change)

**Testing agent** -> Step 12.3: Test Quality Audit
- Fix tautological tests (HIGH severity first)
- Add test vectors from `../holochain/` reference
- Files: `*.test.ts` across packages
- See `STEPS/12.3_PLAN.md` for full audit

### Why these are independent
- 12.2 adds new UI + message handlers (extension domain)
- 12.3 fixes existing tests (testing domain, *.test.ts files)
- No file overlap except potentially `publish-tracker.ts` (12.2 adds methods, 12.3 might add test vectors for it)

### Success criteria
- Both tasks complete without test regressions
- `npm test` passes after both agents' changes are integrated
- No WASM boundary violations introduced

---

## When to Intervene

1. **Agent is debugging a known error** (see diagnostic table) for more than a few turns. Tell it the fix directly.
2. **Agent is re-attempting a documented failed approach** from `LESSONS_LEARNED.md`. Point it to the specific section.
3. **Agent is editing files outside its ownership** without coordinator approval. Redirect to the correct agent.
4. **Integration test failures** after merging agent work. Use the coordinator to diagnose.
5. **Agent is doing web searches** when the answer is in `../holochain/` or project docs. Redirect to local sources.

---

## Troubleshooting

### Agent doesn't know about project conventions
Agent definitions include key invariants, but for deeper context, point agents to:
- `CLAUDE.md` - Core rules
- `ARCHITECTURE.md` - System architecture, encoding boundaries, host function guide
- `LESSONS_LEARNED.md` - Failed approaches (especially serialization)

### Tests fail after integration
1. Check which package fails: `npm test` shows per-package results
2. If serialization error: check the diagnostic table above
3. If Chrome messaging error: check Uint8Array normalization
4. If import resolution error: check cross-package dependency paths

### E2E environment won't start
```bash
scripts/e2e-test-setup.sh status  # Check what's running
scripts/e2e-test-setup.sh clean   # Full reset
scripts/e2e-test-setup.sh start --happ=ziptest --gateway=membrane
```

Prerequisites: `nix develop -c` shell, extension built (`npm run build` in `packages/extension/`)

### Agent team communication breaks down
Experimental teams feature has known limitations:
- No session resumption with in-process teammates
- Task status can lag
- One team per session

Fallback: Use subagent mode (main session delegates via Task tool). Agent definitions still work as subagents.

---

## Reference Documents

| Document | Purpose |
|----------|---------|
| `CLAUDE.md` | Core rules, WASM invariants, error table |
| `ARCHITECTURE.md` | System architecture, data flows, encoding boundaries, host function guide |
| `LESSONS_LEARNED.md` | Failed approaches archive + human-vs-agent documentation lesson |
| `STEPS/META_2_PROCESS_REVIEW.md` | Why invariants > narratives for agent guardrails |
| `STEPS/index.md` | Step registry with status |
| `SESSION.md` | Current focus and integration state |
| `.claude/agents/*.md` | Agent definitions (coordinator, core, extension, testing) |
