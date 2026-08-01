---
name: vibe-learn
description: >-
  Records observed mistakes, successes, and user preferences with `vibe learn`
  after task outcomes. Use after errors, user corrections, explicit praise,
  reusable wins, or preference discoveries persisting across sessions.
user-invocable: true
argument-hint: "<observed outcome>"
---

# Vibe learn

## When to use

- Task concludes with an error, failed assumption, broken command, or user
  correction.
- Task produces a reusable success, explicit praise, or validated technique.
- User states a durable preference, constraint, or workflow expectation.

Skip speculative, temporary, or context-only observations.

## Goal

- Record observed, durable lessons in the local vibe log.
- Append one concise, structured entry via `vibe learn` enabling future session
  reuse.

## Input

- Observed outcome, correction, preference, or success.
- Category label (optional; user-supplied or domain-inferred).
- Solution, fix, prevention, or success factor (optional).

## Workflow

1. **GATE**—Guard preconditions; execute only for concrete outcomes or explicit
   feedback:
   - Skip generic, speculative, or in-context-only observations.

2. **ORIENT**—Anchor goal before execution:
   - Goal: append one durable lesson to the vibe log.
   - Immutable state: existing log entries.

3. **PLAN**—Construct structured learning payload:
   - Run `vibe schema` once per session.
   - Classify outcome type (`mistake`, `success`, or `preference`).
   - Select short category label (`testing`, `release`, `tooling`,
     `preferences`, or project name).
   - Formulate single-sentence `--observation` and optional single-sentence
     `--solution`.

4. **ACT**—Run `vibe learn --observation <text> --category <name> [--solution <text>] [--type <type>]`.

5. **VERIFY**—Inspect CLI output JSON:
   - Confirm `added: true` or `alreadyKnown: true`.
   - Ensure payload contained no sensitive data, credentials, or private
     chain-of-thought text.

6. **PERSIST**—Confirm local database record insertion.

7. **REPORT**—Emit confirmation of added entry or existing duplicate state.

## Directives

- Prefer one high-signal lesson over noisy entries.
- Choose short category labels.
- Preserve exact user wording when recording preferences.

## Constraints

- Never invoke `vibe learn` before task completion.
- Exclude speculation, guesses, private thoughts, secrets, or sensitive data.
- Avoid batching multiple lessons per call.
- Exclude duplicate live schema output.
- Avoid calling `vibe constitution` or `vibe check` within this skill.

## Verification

- `vibe schema` ran before `vibe learn` invocation.
- Entry reflects an observed mistake, success, or preference.
- Entry contains one concise observation and optional solution.
- Output confirms entry addition or known duplicate status.
- Zero sensitive data entered the vibe store.
