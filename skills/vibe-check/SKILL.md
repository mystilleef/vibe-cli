---
name: vibe-check
description: >-
  Validates complex ideas, plans, and solutions with the vibe CLI before
  execution. Use before risky, ambiguous, irreversible, or multi-step work to
  obtain mentor approval, revise unsafe plans, or abort when safe planning
  requires more information.
user-invocable: true
argument-hint: "<goal and proposed plan>"
---

# Vibe check

## When to use

- Complex, risky, irreversible, ambiguous, or multi-step action.
- Plans carrying meaningful side effects or uncertain assumptions.
- High-impact architecture, remediation, migration, or release plans.

Skip trivial, reversible, single-step plans — e.g. single-file edits under test
coverage, local renames, or changes reversible via `git revert`.

## Goal

- Check assumptions, missing constraints, partial-failure risks, and plan
  quality before action as a pre-execution validation gate.
- Send goal and plan to `vibe check`, then execute the returned plan exactly.

## Input

- One-sentence goal.
- Ordered, concrete plan.
- Known risks, assumptions, uncertainties, and relevant context.
- Progress completed when resuming mid-task.

## Workflow

1. **GATE**—Guard preconditions; make no changes:
   - Run `vibe schema` once per session; treat output as authoritative for
     commands, options, outputs, and exit codes.
   - Run `vibe constitution get`; resolve missing, stale, or contradictory
     rules before proceeding.

2. **ORIENT**—Anchor goal before execution:
   - Goal: confirm plan safety and quality before execution.
   - Immutable state: original user goal and completed progress.

3. **PLAN**—Construct compact validation request:
   - `--goal`: one sentence.
   - `--plan`: ordered, concrete, execution-ready steps.
   - `--uncertainty`: material risks, assumptions, or open concerns.
   - `--context`: scope boundaries, limitations, and constraints; pass text
     verbatim without file paths or unresolved references.
   - `--progress`: include when resuming after partial work.

4. **ACT**—Run `vibe check` with constructed flags.

5. **VERIFY**—Evaluate returned CLI JSON verdict (`vibeGateLoop` outcome):
   - `proceed=true`: execute the returned `plan` payload exactly (contains
     mentor-approved refinements).
   - `proceed=false` / `exhausted=true`: halt execution; report that mentor
     review exhausted attempt limits without reaching approval.
   - `feedbackFault=true`: halt execution; report feedback generation failure
     diagnostic.

6. **PERSIST**—Run `vibe learn` when work reveals a mistake, reusable success, or
   durable correction.

7. **REPORT**—Surface the mentor's verdict and approved plan to the calling
   agent unchanged.

## Directives

- Check before execution, not after.
- Keep validation payloads concise and grounded.
- State scope limitations and boundaries clearly.
- Wait for `vibe` to return regardless of duration.

## Constraints

- Never invoke separate skills for `vibe constitution` or `vibe learn` inside
  this skill.
- Never substitute `vibe check` for required user approval.
- Never ignore `proceed=false`, `feedbackFault=true`, or `exhausted=true`.
- Never execute original plan text when `vibe check` returns a revised `plan`.
- Never tamper with `--max-attempts` unless the user requests explicit bounds.
- Abort execution rather than guessing when mentor attempts run out.
- Exclude file paths, URLs, or external references from `--context`.
- Limit execution to one `vibe check` invocation per decision point.
- Avoid retrying pending or slow calls.

## Verification

- `vibe schema` ran once before executing `vibe` commands.
- `vibe constitution get` ran before invoking `vibe check`.
- Request payload contained goal, concrete plan, and material uncertainties.
- Returned verdict received explicit handling (`proceed=true` or halt).
- Executed steps match returned approved plan text.
