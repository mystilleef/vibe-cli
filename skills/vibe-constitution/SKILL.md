---
name: vibe-constitution
description: >-
  Manages persistent vibe constitution rules for constraints, safety
  requirements, and preferences surviving across vibe checks. Use when a user
  states a standing rule, a task carries persistent risk boundaries, a session
  resumes with stale rules, or existing rules conflict with new directives.
user-invocable: true
argument-hint: "<rule intent, constraint, or reset reason>"
---

# Vibe constitution

## When to use

- User states a constraint, safety rule, or preference persisting across
  `vibe check` calls.
- Task includes an irreversible operation or risk boundary guiding later checks.
- Session resumes requiring rule inspection, refresh, or removal.
- Existing rules conflict with current task requirements or user direction.

Skip when no concrete rule-management need exists.

## Goal

- Maintain active vibe constitution rules aligned with user constraints.

## Input

- Rule text.
- Reset reason (for stale or conflicting rules).
- Scope notes (optional).

## Workflow

1. **GATE**—Guard preconditions; execute only for concrete rule changes:
   - Run `vibe schema` once per session; treat output as authoritative.

2. **ORIENT**—Anchor goal before execution:
   - Goal: align active constitution rules with target user constraints.
   - Immutable state: unrelated existing rules.

3. **PLAN**—Inspect current rules and declare action:
   - Run `vibe constitution get` to retrieve active rules.
   - Compare active rules against target constraints.
   - Classify required action:
     - Match: requires no mutation; skip execution.
     - Absent: requires `vibe constitution set --rule <text>`.
     - Stale or conflicting: requires `vibe constitution reset`.

4. **ACT**—Execute classified command (`vibe constitution set` or `reset`).

5. **VERIFY**—Run `vibe constitution get` to confirm active rules match target
   constraints.

6. **PERSIST**—Confirm state update in local session store.

7. **REPORT**—Emit confirmed final active constitution state.

## Directives

- Limit rules to durable constraints only.
- Phrase rules clearly for subsequent agent consumption.

## Constraints

- Exclude duplicate schema output from this skill.
- Inspect existing rules before applying mutations.
- Use `reset` to clear or replace rules; avoid stacking replacement rules via
  `set`.
- Keep rules atomic (one constraint per rule flag).
- Exclude transient task instructions.
- Avoid invoking `vibe check` or `vibe learn` inside this skill.

## Verification

- Loaded schema before executing commands.
- Inspected existing rules before applying changes.
- Verified that final rules match target constraints exactly.
- Removed stale and conflicting rules.
- Avoided `vibe check` and `vibe learn` invocations.
