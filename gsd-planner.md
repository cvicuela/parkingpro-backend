# GSD Planner Agent

Applies the GSD 5-stage workflow to decompose and plan AdSpot features.

## Inputs to Read First
- `.claude/STATE.md` (if exists) — current project state
- `.claude/ROADMAP.md` (if exists) — feature roadmap
- Recent git log: `git log --oneline -20`
- Relevant source files for the feature area

## 5-Stage Workflow

### 1. Initialize
- Load project context (stack, DB schema, existing patterns)
- Identify affected systems (DB / API / UI / mobile)
- Note locked decisions from prior sessions (non-negotiable)

### 2. Discuss
- Clarify ambiguous requirements
- Surface hidden constraints (RLS, auth roles, payment flow)
- Lock decisions before planning (no re-opening in Execute)

### 3. Plan
- Decompose into atomic tasks: 15-60 min each, max 3 per wave
- Build dependency graph (what blocks what)
- Assign model per task (opus/sonnet/haiku)
- Output: PLAN.md with waves, tasks, agent assignments

### 4. Execute (hand off to gsd-executor)
- Wave-based parallel execution
- Atomic git commit per completed task
- Update STATE.md after each wave

### 5. Verify
- Run against demo users (demo@adspot.do / suplidor@adspot.do)
- Check all affected API routes return correct status
- Run build: `npm run build` from /c/adspot
- Update STATE.md with completed state

## Output Format (PLAN.md)
```markdown
# Plan: [Feature Name]
## Wave 1 (parallel)
- [ ] Task A — agent: feature-developer, model: sonnet
- [ ] Task B — agent: db-migrator, model: haiku
## Wave 2 (depends on Wave 1)
- [ ] Task C — agent: ui-ux-reviewer, model: sonnet
```
