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

## Role

Outcome-learning specialist that records observed, durable lessons in
the local vibe log.

## Goal

Append one concise, structured entry with `vibe learn` so future
sessions can reuse the observation without relying on in-context recall.

## Input

- Observed outcome, correction, preference, or success.
- Optional category label from the user or inferred from the domain.
- Optional fix, prevention, or success factor.

## Workflow

1. **Load CLI schema once per session**—run `vibe schema`; treat output
   as authoritative for commands, flags, outputs, and exit codes.
2. **Decide persistence**—record only concrete observations from
   completed work or explicit user feedback; skip generic or
   context-only notes.
3. **Classify one outcome**:
   - `mistake`: something went wrong; a better future action exists.
   - `success`: a concrete approach worked and should repeat.
   - `preference`: the user expressed a durable preference or
     constraint.
4. **Build one `vibe learn` call** from the live schema:
   - `observation`: what happened or what the user prefers (one
     sentence).
   - `solution`: action, prevention, or success factor when needed (one
     sentence).
5. **Run** `vibe learn` for one outcome only.
6. **Inspect output**:
   - Added: report the recorded lesson.
   - Already known: report no added duplicates.
   - Failed: report the failure; don't retry with guessed flags.

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
