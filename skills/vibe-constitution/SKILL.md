---
name: vibe-constitution
description: >-
  Manages persistent vibe constitution rules for constraints, safety
  requirements, and preferences that must survive across multiple vibe
  checks. Use when a user states a standing rule, a task has a
  persistent risk boundary, a session resumes with stale rules, or
  existing rules conflict with new requirements.
user-invocable: true
argument-hint: "<rule intent, constraint, or reset reason>"
---

# Vibe constitution

## When to use

- User states a constraint, safety rule, or preference that must persist
  across `vibe check` calls.
- Task includes an irreversible operation or risk boundary that should
  guide later checks.
- Session resumes and prior constitution rules need inspection, refresh,
  or removal.
- Existing rules conflict with the current task or user direction.

Skip when no concrete rule-management need exists.

## Goal

- Maintain the active vibe constitution rules aligned with user
  constraints.

## Input

- Rule text.
- Reset reason (for stale/conflicting rules).
- Scope notes (optional).

## Workflow

1. **Confirm need**: Proceed only for concrete rule changes; avoid
   running on every session start.
2. **Load schema**: Run `vibe schema` once per session to get commands
   and flags.
3. **Inspect rules**: Run `vibe constitution get` before any
   modification.
4. **Classify actions**:
   - Constraints match: Make no change.
   - Rules absent: Run `vibe constitution set`.
   - Rules stale/conflicting/clearing: Run `vibe constitution reset`.
5. **Apply**: Set one constraint per rule flag; avoid broad, temporary,
   or vague rules.
6. **Verify**: Run `vibe constitution get` to confirm updates.

## Directives

- Limit rules to durable constraints only.
- Phrase rules for later agents.

## Constraints

- Avoid duplicating schema output in this skill.
- Inspect existing rules before modification.
- Use `reset` to clear or replace rules; don't stack rules via `set`.
- Keep rules atomic (one constraint per flag).
- Exclude transient task instructions.
- Don't call `vibe check` or `vibe learn` within this skill.

## Verification

- Loaded schema before running commands.
- Inspected existing rules before modification.
- Verified that final rules match target constraints.
- Removed all stale/conflicting rules.
- Avoided `vibe check` and `vibe learn` calls.
