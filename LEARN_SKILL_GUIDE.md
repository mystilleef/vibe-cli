# vibe learn — Skill Authoring Guide

## What vibe learn does

Appends a structured entry to `~/.vibe-check/vibe-log.json` — a mistake,
success, or preference observed during a task. No LLM call. Pure local write.
The log persists across sessions.

## Why it matters in a skill

A skill that calls `vibe learn` after notable outcomes builds a persistent,
structured record of what the agent observed — independent of any specific
workflow. Mistakes, successes, and preferences accumulate across sessions,
giving the agent an organizational memory it can draw on without relying on
in-context recall.

## Canonical skill structure

Every skill that uses `vibe` **must** call `vibe schema` first.

```sh
# 1. Load live interface — once per session, before any other vibe call
vibe schema

# 2. Record a mistake
vibe learn \
  --mistake "what went wrong" \
  --category "<label>" \
  --solution "what to do instead" \
  --type mistake

# 3. Record a success
vibe learn \
  --mistake "what was attempted" \
  --category "<label>" \
  --solution "what made it work" \
  --type success

# 4. Record a preference
vibe learn \
  --mistake "what the user prefers" \
  --category "<label>" \
  --type preference
```

**Invariant**: `vibe schema` runs once per session, before any other `vibe`
command. Use its output as the authoritative interface reference — do not
duplicate or cache schema details in the skill itself.

**Note**: `--mistake` is the observation field for all types regardless of
its name. Ignore the literal name — always pass what was observed or
attempted, not a judgment about failure.

**Type guide**:

| Type | `--mistake` holds | `--solution` holds | Required |
|---|---|---|---|
| `mistake` | What went wrong | What to do instead | Yes |
| `success` | What was attempted | What made it work | Yes |
| `preference` | What the user prefers | _(not applicable)_ | No |

## Harness auto-trigger patterns

`vibe learn` fires **after** a task completes — not before. Wire it to
post-task or outcome hooks, not pre-execution gates.

| Harness | Trigger mechanism | Recommended condition |
|---|---|---|
| Claude Code | `SKILL.md` trigger phrase | After task completion, error, or user correction |
| Cursor | `.cursorrules` + tool call | On task close or user feedback |
| Amp | Hook on task completion | Any task that ended with an error or explicit praise |
| Generic agent | Post-tool hook / system prompt | After any notable outcome |

**Pattern**:
```
task completes (success, failure, or correction)
  → harness fires skill
    → skill calls vibe schema
      → skill calls vibe learn with appropriate type
        → entry written to ~/.vibe-check/vibe-log.json
```

## Skill template

Adapt to any harness. Replace bracketed sections.

```markdown
## When to use
[one-line condition — e.g., "after any task that ends in error, correction, or explicit success"]

## Workflow
1. Run `vibe schema` — treat output as live interface for this session.
2. Identify outcome type: mistake, success, or preference.
3. Run `vibe learn`:
   - Mistake: `--type mistake --mistake "<what went wrong>" --category "<label>" --solution "<what to do instead>"`
   - Success: `--type success --mistake "<what was attempted>" --category "<label>" --solution "<what made it work>"`
   - Preference: `--type preference --mistake "<what the user prefers>" --category "<label>"`
4. Confirm `added: true` in output — if `alreadyKnown: true`, skip duplicate entry.

## Constraints
- Always call `vibe schema` before any other vibe command.
- One outcome per `vibe learn` call — do not batch multiple events.
- Keep `--mistake` and `--solution` to one sentence each.
- Never call `vibe learn` speculatively — only on observed outcomes.
- Check `alreadyKnown` in output before re-recording similar events.
- Do not call `vibe check` or `vibe constitution` from this skill.
```

## One-liner global prompt

Paste into the agent's system prompt or global instructions:

> After any task that ends in error, user correction, or clear success, invoke the vibe-learn skill to record the outcome.
