# vibe constitution — Skill Authoring Guide

## What constitution does

Stores named, persistent rules in `~/.vibe-check/constitution.json` that the
`vibe check` mentor reads on every subsequent call. Rules survive restarts.
Constitution is the standing behavioral contract for a session — not a
one-time prompt injection.

## Why it matters in a skill

A skill that manages constitution gives the agent a persistent, named rule
set that survives session restarts. Rules are enforced automatically by the
mentor on every `vibe check` call — the constitution skill itself never calls
`vibe check`.

## Canonical skill structure

Every skill that uses `vibe` **must** call `vibe schema` first.

```sh
# 1. Load live interface — once per session, before any other vibe call
vibe schema

# 2. Inspect existing rules (on resume, handoff, or before setting)
vibe constitution get

# 3. Set standing rules
vibe constitution set \
  --rule "<constraint>" \
  --rule "<constraint>"

# 4. Replace stale rules mid-session (omit --rule to clear all)
vibe constitution reset \
  --rule "<new-rule>"
```

**Invariant**: `vibe schema` runs once per session, before any other `vibe`
command. Use its output as the authoritative interface reference — do not
duplicate or cache schema details in the skill itself.

**Session management**: session ID is derived and managed automatically by
the CLI from the working directory. No `--session` flag needed.

## Harness auto-trigger patterns

Most harnesses fire skills automatically when a condition is met.

Trigger on a rule management need — not on session start or task creation
unconditionally.

**Concrete trigger instances:**
- User states a constraint, safety requirement, or preference that should persist
- Task involves an irreversible operation with a known risk boundary
- Session resumes and prior rules may be stale or absent
- Existing rules conflict with a new task's requirements

| Harness | Trigger mechanism | Fire when |
|---|---|---|
| Claude Code | `SKILL.md` trigger phrase | User states a rule, or task has a declared constraint |
| Cursor | `.cursorrules` + tool call | User adds a project rule or overrides a prior one |
| Amp | Hook on rule-bearing task | Task metadata includes explicit constraints |
| Generic agent | Pre-tool hook / system prompt | Agent detects a constraint that should survive across checks |

**Pattern**:
```
rule management need arises
  → harness fires skill
    → skill calls vibe schema
      → skill calls vibe constitution get (inspect existing rules)
        → rules absent or stale → vibe constitution set/reset
        → rules current → skill exits, no change needed
```

## Skill template

Adapt to any harness. Replace bracketed sections.

```markdown
## When to use
When a constraint, safety requirement, or preference arises that must
persist across multiple `vibe check` calls — or when resuming a session
where prior rules may be stale or missing.

## Workflow
1. Run `vibe schema` — treat output as live interface for this session.
2. Run `vibe constitution get` — inspect any existing rules.
3. Run `vibe constitution set --rule "<rule>"` for each standing constraint
   (safety requirements, project rules, user preferences).
4. Run `vibe constitution reset --rule "<rule>"` to replace stale rules —
   omit `--rule` to clear all.

## Constraints
- Always call `vibe schema` before any other vibe command.
- Only invoke when there is a concrete rule management need — not on every session start.
- Use `vibe constitution reset` to replace stale rules — not `set` on top.
- Keep rules atomic: one constraint per --rule flag.
- Do not call `vibe check` or `vibe learn` from this skill.
```

## One-liner global prompt

Paste into the agent's system prompt or global instructions:

> Invoke the vibe-constitution skill when a constraint, safety rule, or preference must persist across checks, or when resuming a session with potentially stale rules.
