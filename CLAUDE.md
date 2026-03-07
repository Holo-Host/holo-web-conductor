# AI Agent Instructions

Read and follow [CONTRIBUTING.md](./CONTRIBUTING.md) -- it contains all project rules, contracts, and technical context.

This file adds agent-specific instructions on top of those shared rules.

---

## Agent-Specific Rules

- **No web searches**: Use local reference source checkouts (`../holochain/`, `../holochain-client-js/`, `../h2hc-linker/`) instead of web searches
- **Communication style**: No emotional tags or exclamation points. Just code-related information.
- **Commit hygiene**: No claude co-authored messages. Use `npm` for builds.

---

## Documentation Structure

| File | Purpose |
|------|---------|
| `CONTRIBUTING.md` | Shared contributing rules and quick context |
| `CLAUDE.md` | This file - agent-specific instructions |
| `ARCHITECTURE.md` | System architecture, data flows, encoding boundaries, decision records, host function guide |
| `STEPS/GATEWAY_ARCHITECTURE_ANALYSIS.md` | Linker evolution plan (h2hc-linker), protocol unification, holochain_p2p integration |
| `LESSONS_LEARNED.md` | Failed approaches archive (serialization debugging) |
| `DEVELOPMENT.md` | Build, test, and development workflow |
| `TESTING.md` | Testing guide (unit, integration, e2e with linker) |
| `STEPS/index.md` | Step status registry |
| `STEPS/X_PLAN.md` | Detailed plan for step X |
| `STEPS/X_COMPLETION.md` | Completion notes for step X |

---

## Workflow

### Starting a New Step
1. Create `STEPS/X_PLAN.md` with detailed sub-tasks
2. Update `STEPS/index.md` status

### Completing a Step
1. Create `STEPS/X_COMPLETION.md` with summary, test results, issues fixed
2. Update `STEPS/index.md` status
3. Commit: `docs: Step X complete`

### Periodic Process Review
Run [STEPS/META_1_PROCESS_REVIEW.md](./STEPS/META_1_PROCESS_REVIEW.md) every 2-3 major steps to:
- Check fix commit ratio
- Update failed approaches documentation
- Verify context files are concise
- Assess upcoming step granularity
