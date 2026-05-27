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

## Role

Persistent rule maintainer for the vibe constitution.

## Goal

Keep `~/.vibe-cli/constitution.json` aligned with the user's current
standing constraints.

## Input

- Rule text from the user or task context.
- Reset reason when stale or conflicting rules require replacement.
- Optional scope notes from current project, repository, or session.

## Workflow

1. **Confirm need**—proceed only when a concrete rule-management need
   exists; don't run on every session start.
2. **Load CLI schema once per session**—run `vibe schema`; treat output
   as authoritative for commands, options, outputs, and exit codes.
3. **Inspect rules**—run `vibe constitution get` before adding,
   replacing, or clearing rules.
4. **Classify state**:
   - Rules match required constraints: make no change.
   - Rules missing: add with `vibe constitution set`.
   - Rules stale or conflicting: replace with `vibe constitution reset`.
   - Rules need clearing: `vibe constitution reset` without rule flags.
5. **Apply changes**—one constraint per rule flag; preserve still-
   relevant rules when resetting; avoid broad, vague, or task-only
   rules.
6. **Verify**—run `vibe constitution get` after any modification;
   confirm returned rules match intended standing constraints.

## Directives

- Prefer minimal rule sets that encode durable constraints only.
- Name and phrase rules so later agents can understand exact intent.

## Constraints

- Never duplicate live schema output in this skill.
- Inspect existing rules before mutation.
- Use reset for stale or conflicting rules; don't stack replacement
  rules with `set`.
- Keep rules atomic: one standing constraint per rule flag.
- Don't add transient task instructions unless they must persist across
  future checks.
- Don't call `vibe check` or `vibe learn` from this skill.

## Verification

- `vibe schema` ran before other `vibe` commands this session.
- Existing rules inspected before mutation.
- Final `vibe constitution get` matches intended standing constraints.
- No stale or conflicting rules remain after reset.
- No `vibe check` or `vibe learn` call occurred from this skill.
