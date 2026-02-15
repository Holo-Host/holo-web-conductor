# Meta-1: Process Review

> **Type**: Recurring step - run every 2-3 major steps or when significant rework is identified

## Purpose

Periodically assess the development process to:
1. Identify patterns of wasted work
2. Update failed approaches documentation
3. Keep context files concise and effective
4. Ensure step granularity is appropriate

## When to Run

- After completing 2-3 major steps
- When you notice repeated debugging of similar issues
- When fix commits exceed 20% of recent commits
- When a step takes significantly longer than expected
- Before starting a large new feature area

## Review Checklist

### 1. Commit Analysis
```bash
# Check recent commit types
git log --oneline -30 --format="%s" | grep -E "^(feat|fix|refactor|docs|WIP):" | cut -d: -f1 | sort | uniq -c

# Target: fix commits < 15%, WIP commits = 0%
```

- [ ] Fix commit ratio acceptable?
- [ ] Any WIP commits that should have been local branches?
- [ ] Any patterns in what needed fixing?

### 2. Failed Approaches Update
- [ ] Review any debugging that took > 1 hour
- [ ] Add new entries to LESSONS_LEARNED.md if needed
- [ ] Categorize by topic (serialization, hashing, signals, etc.)

### 3. Context File Health
```bash
wc -l CLAUDE.md SESSION.md LESSONS_LEARNED.md
# Target: CLAUDE.md ~150 lines, SESSION.md ~50 lines
```

- [ ] CLAUDE.md still concise? (target ~150 lines)
- [ ] SESSION.md focused on current step only?
- [ ] No duplication between files?

### 4. Step Granularity
```bash
wc -l STEPS/*_PLAN.md | sort -n | tail -10
# Target: No plan > 400 lines
```

- [ ] Any upcoming steps need decomposition?
- [ ] Any steps that were too large in retrospect?

### 5. Documentation Accuracy
- [ ] STEPS/index.md status matches reality?
- [ ] Current step clearly identified?
- [ ] No stale information in active docs?

## Output

After review, update:
1. `LESSONS_LEARNED.md` - Add any new failed approaches
2. `STEPS/index.md` - Update step statuses
3. `CLAUDE.md` - Trim if grown too large
4. This file - Add review date to history

## Review History

| Date | Reviewer | Key Findings | Actions Taken |
|------|----------|--------------|---------------|
| 2026-01-15 | Claude | Initial process review - see meta-analysis | Created index.md, trimmed CLAUDE.md, added this meta-step |
| 2026-02-15 | Claude + Eric | Documentation failed as agent guardrail; narrative docs don't prevent agent mistakes; need invariants + symptom tables | META_2 created, CLAUDE.md updated with invariants and diagnostic table, LESSONS_LEARNED.md updated with human-vs-agent lesson |

## Common Issues to Watch For

### From Historical Analysis (2026-01-15)

1. **Serialization debugging wrong layer**
   - Symptom: Hours on encoding when problem is decoding
   - Prevention: Trace full data flow before deep-diving

2. **Re-attempting failed solutions**
   - Symptom: Same approach tried across sessions
   - Prevention: Check LESSONS_LEARNED.md before coding

3. **Protocol misunderstanding**
   - Symptom: "Invalid type" or format errors
   - Prevention: Research ../holochain/ before implementing

4. **Custom code vs library functions**
   - Symptom: Refactoring to use @holochain/client
   - Prevention: Check library first before writing utilities

5. **Massive step plans**
   - Symptom: Step takes weeks, loses momentum
   - Prevention: Decompose into sub-steps if plan > 400 lines
