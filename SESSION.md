# Current Session

**Last Updated**: 2026-02-17
**Current Work**: Retro complete; agent definitions updated with e2e pre-flight checklist

---

## Retro: Stale Build Investigation (2026-02-17)

**Incident**: Session spent bulk of time on byte-level serialization investigation when the e2e ziptest showed errors after RecordEntry format fix (057dd2f). All analysis confirmed the code was correct. Root cause: extension was not rebuilt after source changes.

**Pattern added**: LESSONS_LEARNED.md Pattern 8 -- "Investigating Code When the Problem Is a Stale Build"

**Files updated**:
- `LESSONS_LEARNED.md` -- New Pattern 8 with mandatory pre-flight checklist
- `CLAUDE.md` -- Added "E2E / Runtime Debugging Pre-Flight" section
- `.claude/agents/coordinator.md` -- Added pre-flight checklist
- `.claude/agents/core.md` -- Added pre-flight checklist
- `.claude/agents/extension.md` -- Added pre-flight checklist
- `.claude/agents/testing.md` -- Added pre-flight checklist

**Key lesson**: "Check simple stuff first" does not work as an agent guardrail. A concrete, ordered checklist with specific commands (compare timestamps, rebuild if stale, only then investigate) does work.

---

## Agent Teams - Active

**Status**: Infrastructure complete, ready for pilot task

### What was created
- Agent definitions: `.claude/agents/{coordinator,core,extension,testing}.md`
- Human PM guide: `AGENT_TEAMS.md`
- Experimental teams enabled in `.claude/settings.local.json`

### Team structure

| Agent | Domain | File Ownership |
|-------|--------|----------------|
| **coordinator** (opus) | Plans work, delegates, integrates, verifies | All (read), integration tests |
| **core** (sonnet) | WASM runtime, host functions, serialization, storage, network, DHT | `packages/core/`, `packages/lair/`, `packages/shared/` |
| **extension** (sonnet) | Browser extension, messaging, UI, Chrome/Firefox | `packages/extension/` |
| **testing** (sonnet) | E2E tests, client library, test vectors, DNA/hApp builds | `packages/e2e/`, `packages/client/`, `packages/test-zome/`, `fixtures/` |

### Pilot task: Step 12.2 + 12.3 in parallel

| Task | Agent | Description |
|------|-------|-------------|
| Step 12.2 | extension + core | DHT debug panel in extension UI |
| Step 12.3 | testing | Test quality audit across all packages |

See `AGENT_TEAMS.md` for full workflow guide.

---

## Branch Integration - Complete

All feature branches merged into hc-membrane:

| Branch | Status |
|--------|--------|
| step-18-zome-call-serialization | Merged |
| step-20-validation | Merged |
| step-19-mewsfeed-e2e | Merged |
| step-21-firefox | Merged (plan doc only) |

---

## Step Status

- **Step 18** (zome call serialization): Merged
- **Step 19** (mewsfeed e2e): Merged, blocked on kitsune2 timeout upstream
- **Step 20** (validation pipeline): Merged
- **Step 21** (Firefox plan): Merged (plan doc only)
- **Step 12.2** (DHT debug panel): Planned, ready for pilot
- **Step 12.3** (test audit): Planned, ready for pilot

---

## Process Reviews

- [META_1: Process Review](./STEPS/META_1_PROCESS_REVIEW.md) - Fix commit ratios, documentation review
- [META_2: Agent Guardrails](./STEPS/META_2_PROCESS_REVIEW.md) - Why documentation fails as agent guardrails, invariant-based design

---

## Quick Links

- [Step Registry](./STEPS/index.md) - All step statuses
- [Agent Teams Guide](./AGENT_TEAMS.md) - Human PM workflow
- [Architecture](./ARCHITECTURE.md) - System architecture and decisions
- [Failed Approaches](./LESSONS_LEARNED.md)
