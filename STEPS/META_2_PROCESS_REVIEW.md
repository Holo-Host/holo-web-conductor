# Meta-2: Process Review — Documentation as Agent Guardrail

> **Date**: 2026-02-15
> **Trigger**: Serialization mistake recurred during branch integration despite 792-line LESSONS_LEARNED.md explicitly documenting the failed approach
> **Session**: `315a93bb-21b3-4d61-8da4-1ab77f032468`

---

## Incident Summary

During integration of `step-20-validation` into `hc-membrane` (which already had `step-18-zome-call-serialization`), the agent encountered 5 test failures in `concurrent-calls.test.ts`. Step-20's validation pipeline now calls the real WASM `validate` export on pending records, producing:

```
Deserialize("invalid type: map, expected byte array")
```

The agent's immediate reaction: "Found the issue. In `validate.ts`, the Op is double-encoded." It replaced `serializeToWasm()` with raw `wasmAllocate()` + `writeToWasmMemory()`, removing one encoding layer.

This is **Failed Solution #2** from LESSONS_LEARNED.md ("Removing Double-Encoding"), and directly contradicts the "ExternIO Deep Dive" section which states: "The Double-Encoding Pattern IS INTENTIONAL."

The agent had to re-derive the ExternIO contract from first principles by reading `holochain_wasmer_guest/src/guest.rs`, then revert its change. The actual bug turned out to be 32-byte vs 39-byte hash format in `record-converter.ts` -- a completely different layer.

---

## Analysis: Why Documentation Failed to Prevent the Mistake

### 1. Narrow trigger condition

CLAUDE.md says: "Check LESSONS_LEARNED.md before serialization work."

The agent was doing a **branch merge**. The serialization issue was an emergent consequence of merging two independently-developed features. The agent never categorized its task as "serialization work," so the trigger never fired.

### 2. Story-indexed vs. symptom-indexed knowledge

LESSONS_LEARNED.md organizes failed solutions by *what was attempted*:
- "Failed Solution #2: Removing Double-Encoding"
- "Failed Solution #5: Removing Result Wrapper"
- "Failed Solution #6: ExternIO Double-Encoding"

To use this, the agent must recognize its proposed fix matches a documented failure. But the agent doesn't think "I'm about to remove double-encoding" -- it thinks "I found a bug and I'm fixing it." What would intervene is indexing by *symptom*:
- `"expected byte array, got map"` → You removed ExternIO wrapping. Put it back.
- `"expected Ok or Err"` → You removed the Result wrapper. Put it back.

### 3. Narrative vs. invariant

792 lines of excellent historical narrative documenting why things failed. But the agent needs a 3-line invariant it can check mechanically:

```
All data INTO WASM → serializeToWasm(). Never bypass.
All data FROM WASM → deserializeFromWasm().
All host function returns → serializeResult().
```

The narrative explains *why* these invariants exist. The invariant prevents the mistake. The project had the narrative but not the invariant.

### 4. Context transfer failure

The documented failures occurred in `serialization.ts`, `background/index.ts`, and host function files. When the identical pattern appeared in `validate.ts` -- a different file, during a different activity -- the agent treated it as a novel problem. The lessons were context-bound rather than principle-bound.

### 5. Length as a barrier

792 lines is too long to function as an intervention tool. The agent would need to read and pattern-match against the entire document to realize its situation is a repeat. The 7-item serialization checklist in CLAUDE.md works better because it's short and specific, but it didn't cover this case.

---

## Root Cause: Human Documentation vs. Agent Documentation

This is fundamentally about knowledge representation. The project invested heavily in documentation optimized for **human understanding**: narratives, context, rationale, historical analysis. This is valuable -- a human reading LESSONS_LEARNED.md would deeply understand the serialization landscape.

But AI agents don't benefit from narratives the same way. They need:

| Human documentation | Agent documentation |
|---|---|
| Stories explaining *why* | Invariants stating *what* |
| Organized by solution attempted | Indexed by symptom observed |
| Comprehensive context | Short, checkable rules |
| Broad scope ("serialization work") | Precise triggers ("any code touching WASM memory") |
| Passive reference ("check before...") | Active guardrails (invariants in the rules section) |

The existing LESSONS_LEARNED.md is excellent *human* documentation. It needs a companion layer of *agent* documentation: short invariants, symptom tables, and broad trigger conditions placed in CLAUDE.md where they're always in context.

---

## Implications for Agent Teams

This finding directly affects the planned agent teams architecture:

1. **WASM boundary knowledge is cross-cutting.** The validation pipeline sits at the intersection of core/ribosome and testing. If one team writes `validate.ts` and another writes the tests, neither may carry the serialization context. The WASM boundary invariants must be in shared documentation that ALL teams read, not scoped to the "core/ribosome" team.

2. **Team boundary definitions need invariant sections.** Each `.claude/agents/*.md` file should include the invariants relevant to that team's work, not just file ownership lists. When a team touches code within 2 hops of a WASM call, it needs the ExternIO contract.

3. **Integration is the highest-risk moment.** The bug appeared when two independently-correct features were combined. Agent teams will produce more of these integration moments, not fewer. Integration-specific checklists are needed.

---

## Actions Taken

| Action | File | Description |
|--------|------|-------------|
| Add WASM boundary invariants | `CLAUDE.md` | Short, checkable rules in the critical rules section |
| Add symptom-diagnostic table | `CLAUDE.md` | Error message → cause → fix lookup |
| Broaden trigger condition | `CLAUDE.md` | "Any change touching WASM memory or encode/decode" |
| Add human-vs-agent lesson | `LESSONS_LEARNED.md` | New section on documentation design for agents |
| Update review history | `META_1_PROCESS_REVIEW.md` | Record this review |

---

## Review History Update

Added to META_1_PROCESS_REVIEW.md:

| Date | Reviewer | Key Findings | Actions Taken |
|------|----------|--------------|---------------|
| 2026-02-15 | Claude + Eric | Documentation failed as agent guardrail; narrative docs don't prevent agent mistakes; need invariants + symptom tables | META_2 created, CLAUDE.md updated with invariants and diagnostic table, LESSONS_LEARNED.md updated with human-vs-agent documentation lesson |
