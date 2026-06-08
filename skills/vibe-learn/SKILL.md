---
name: vibe-learn
description: >-
  Records observed mistakes, successes, and user preferences with `vibe
  learn` after task outcomes. Use after errors, user corrections,
  explicit praise, reusable wins, or preference discoveries that should
  persist across sessions.
user-invocable: true
argument-hint: "<observed outcome>"
---

# Vibe learn

## When to use

- Task ends with an error, failed assumption, broken command, or user
  correction.
- Task produces a clear reusable success, explicit praise, or validated
  technique.
- User states a durable preference, constraint, or workflow expectation.

Skip speculative, temporary, or in-context-only observations.

## Goal

- Record observed, durable lessons in the local vibe log as an
  outcome-learning specialist.
- Append one concise, structured entry with `vibe learn` so future
  sessions can reuse the observation without relying on in-context
  recall.

## Input

- Observed outcome, correction, preference, or success.
- Optional category label from the user or inferred from the domain.
- Optional fix, prevention, or success factor.

## Workflow

1. **GATE**—Proceed only for concrete outcomes from completed work or
   explicit user feedback; skip generic, speculative, or in-context-only
   observations.
2. **ORIENT**—Goal: append one durable lesson to the vibe log. Won't
   change: existing log entries.
3. **ACT**—Run `vibe schema` once per session; classify the outcome as
   `mistake`, `success`, or `preference`; construct one `vibe learn`
   call:
   - `observation`: what happened or what the user prefers (one
     sentence).
   - `solution`: action, prevention, or success factor when needed (one
     sentence).
4. **VERIFY**—Confirm the entry has one observation, no sensitive data,
   and no duplicate matches.
5. **PERSIST**—Run `vibe learn`.
6. **REPORT**—Confirm the added entry, report an existing duplicate, or
   report the failure without retrying with guessed flags.

## Directives

- Prefer one high-signal lesson over noisy entries.
- Choose short category labels: `testing`, `release`, `tooling`,
  `preferences`, or the project name.
- Preserve user wording when recording preferences.

## Constraints

- Never call `vibe learn` before task completion.
- Never record speculation, guesses, private chain-of-thought, secrets,
  tokens, credentials, or sensitive data.
- Never batch more than one lesson per `vibe learn` call.
- Never duplicate live schema output in this skill.
- Don't call `vibe constitution` or `vibe check` from this skill.

## Verification

- `vibe schema` ran before `vibe learn` this session.
- Entry reflects an observed mistake, success, or preference.
- Entry has one concise observation and, when needed, one concise
  solution.
- Output confirms an added entry or a known duplicate.
- No sensitive data entered the vibe log.
