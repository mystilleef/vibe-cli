# vibe check — Skill Authoring Guide

## What vibe check does

Sends a goal and plan to a second LLM (the mentor) and returns a
`proceed` decision, confidence score, revised plan, and clarifying
questions. The mentor enforces any active constitution rules automatically.
`vibe check` is the only `vibe` command that makes an LLM call.

## Role within the vibe toolset

| Tool | Role | When |
|---|---|---|
| `vibe schema` | Load live interface | Once per session, first |
| `vibe constitution set` | Establish standing rules | Before first check |
| `vibe constitution get` | Confirm active rules | Immediately before every check |
| **`vibe check`** | **Validate goal + plan** | **Before risky or complex action** |
| `vibe learn` | Record outcome | After task completes |

`vibe check` sits between constitution (setup) and learn (post-execution).
It never replaces required user approval.

## Why it matters in a skill

A skill that gates risky or complex actions behind `vibe check` prevents
overconfident execution. The mentor catches flawed assumptions, missing
constraints, and partial-failure risks before they reach the real world.

## Canonical skill structure

Every skill that uses `vibe` **must** call `vibe schema` first.

```sh
# 1. Load live interface — once per session, before any other vibe call
vibe schema

# 2. Inspect active constitution rules — always, before every check
vibe constitution get
# If rules are missing or stale, set or reset them before proceeding:
#   vibe constitution set --rule "<constraint>"
#   vibe constitution reset --rule "<new-rule>"

# 3. Run check — core gate
vibe check \
  --goal "<one sentence goal>" \
  --plan "<ordered concrete steps>" \
  --uncertainty "<concern>"          # repeatable \
  --progress "<work done so far>"    # on resume \
  --context "<relevant background>"  # when scope needs grounding \
  --max-attempts <int>               # default 10; lower for tight loops

# 4. Handle result (see Result states below)

# 5. (Optional) Record outcome after task completes
vibe learn \
  --mistake "<what happened>" \
  --category "<label>" \
  --solution "<what to do instead or what worked>" \
  --type mistake|success
```

**Invariant**: `vibe schema` runs once per session, before any other `vibe`
command. Use its output as the authoritative interface reference — do not
duplicate or cache schema details in the skill itself.

**Important**: `vibe constitution` and `vibe learn` are called here as CLI
tools directly via shell — not as skill invocations:

- `vibe constitution get` — not `/vibe-constitution` or a Skill tool call
- `vibe learn --mistake "..." --category "..." --type mistake` — not `/vibe-learn` or a Skill tool call

This skill owns its full workflow; it does not delegate to other skills.

**Session management**: session ID is derived and managed automatically by
the CLI from the working directory. No `--session` flag needed.

## Result states

All three states must be handled. Never fall through silently.

| State | Condition | Required agent action |
|---|---|---|
| **Proceed** | `proceed=true` | Execute the returned `plan` exactly — not the original |
| **Revise** | `proceed=false` and `exhausted` absent or `false` | Revise from `reason`, `questions`, and returned `plan`; resubmit |
| **Abort** | `exhausted=true` | Stop; report that safe planning requires more information |

```sh
# Pseudocode for result handling
if proceed == true:
    execute returned plan          # not the original
elif exhausted == true:
    abort; surface reason to user
else:
    revise plan from reason + questions; resubmit vibe check
```

**Critical**: always execute the mentor's returned `plan`, never the
original. The mentor may revise scope, order, or constraints.

## Harness auto-trigger patterns

`vibe check` fires **before** execution — not after. Wire it to
pre-execution gates, not completion hooks.

| Harness | Trigger mechanism | Recommended condition |
|---|---|---|
| Claude Code | `SKILL.md` trigger phrase | Before any risky, irreversible, or multi-step action |
| Cursor | `.cursorrules` + tool call | On task start when scope is complex or destructive |
| Amp | Hook on task creation | Any task flagged as risky or multi-step |
| Generic agent | Pre-tool hook / system prompt | Before first tool call on non-trivial work |

**Full lifecycle pattern**:
```
session starts
  → vibe schema (once)
    → vibe constitution set (if session rules apply)
      → [task begins]
        → vibe constitution get (confirm rules before every check)
          → empty rules (no constraints) → proceed as-is
          → rules present → mentor enforces them in check
          → rules missing/stale → vibe constitution set/reset first
        → vibe check (before each risky or complex action)
          → proceed=true  → execute returned plan
          → proceed=false → revise + resubmit
          → exhausted     → abort + surface reason
      → [task completes]
        → vibe learn (on mistake, success, or correction)
```

## Skill template

Adapt to any harness. Replace bracketed sections.

```markdown
## When to use
[one-line condition — e.g., "before any irreversible, multi-step, or
ambiguous action"]

## Workflow
1. Run `vibe schema` — treat output as live interface for this session.
2. Run `vibe constitution get` — confirm rules are active.
   - If missing or stale: run `vibe constitution set/reset` before continuing.
3. Run `vibe check --goal "..." --plan "..."`:
   - Add `--uncertainty` for each known risk or assumption.
   - Add `--progress` when resuming mid-task.
4. Handle result:
   - `proceed=true`: execute the returned `plan` exactly.
   - `proceed=false`: revise from `reason` and `questions`; resubmit.
   - `exhausted=true`: abort; surface `reason` to the user.
5. After task: run `vibe learn` to record any notable outcome.

## Constraints
- Always call `vibe schema` before any other vibe command.
- Never execute the original plan after vibe check returns a revised plan.
- Never ignore proceed=false or exhausted=true.
- Never use vibe check as a substitute for required user approval.
- Keep --goal to one sentence; keep --plan concrete and ordered.
- Reserve vibe check for complex, risky, or ambiguous work — skip trivial
  reversible actions.
- Call `vibe constitution` and `vibe learn` as CLI tools directly via shell
  — never invoke the constitution or learn skills (no `/vibe-constitution`,
  no Skill tool delegation).
```

## One-liner global prompt

Paste into the agent's system prompt or global instructions:

> Before any irreversible, multi-step, or ambiguous action, invoke the vibe-check skill and execute only the plan it returns.
