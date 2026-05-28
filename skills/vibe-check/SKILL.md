---
name: vibe-check
description: >-
  Automatically validates complex ideas, plans, and solutions with the
  vibe CLI before execution. Use before risky, ambiguous, irreversible,
  or multi-step work to obtain mentor approval, revise unsafe plans, or
  abort when safe planning needs more information.
user-invocable: true
argument-hint: "<goal and proposed plan>"
---

# Vibe check

## When to use

- Complex, risky, irreversible, ambiguous, or multi-step action.
- Plans with meaningful side effects or uncertain assumptions.
- High-impact architecture, remediation, migration, or release plans.

Skip trivial, reversible, single-step plans.

## Role

Pre-execution validation gate: sends the current goal and plan to
`vibe check`, then follows the returned decision exactly.

## Goal

Prevent overconfident execution by validating assumptions, missing
constraints, partial-failure risks, and plan quality before action.

## Input

- One-sentence goal.
- Ordered, concrete plan.
- Known risks, assumptions, uncertainty, and relevant context.
- Progress already completed when resuming mid-task.

## Workflow

1. **Load CLI schema once per session**—run `vibe schema`; treat output
   as authoritative for commands, options, outputs, and exit codes.
2. **Confirm constitution before every check**—run
   `vibe constitution get`; fix missing, stale, or contradictory rules
   with `vibe constitution set` or `vibe constitution reset` before
   continuing.
3. **Build compact validation request**:
   - `--goal`: one sentence.
   - `--plan`: ordered, concrete, execution-ready.
   - `--uncertainty`: one per material risk, assumption, or open
     concern.
   - `--context`: constraints and grounding the mentor needs to judge
     the plan. Pass text verbatim—the mentor has no file access, tools,
     or external context.
   - `--progress`: include when resuming after partial work.
4. **Run** `vibe check` before execution.
5. **Handle returned state**:
   - `proceed=true`: execute the returned `plan` exactly, not the
     original.
   - `proceed=false` without exhaustion: revise from `reason`,
     `questions`, and returned `plan`; resubmit.
   - `exhausted=true`: stop; report that the mentor failed to safely
     approve the plan within the attempt limit.
6. **Record notable outcomes**—after task completion, run `vibe learn`
   when work revealed a mistake, reusable success, or durable
   correction.

## Directives

- Check before execution, not after.
- Keep validation payloads concise but sufficiently grounded.
- Continue revision loops only while the mentor returns actionable next
  steps.

## Constraints

- Never invoke separate skills for `vibe constitution` or `vibe learn`.
- Never use `vibe check` as a substitute for required user approval.
- Never ignore `proceed=false` or `exhausted=true`.
- Never execute the original plan after the mentor returns a revised
  plan.
- Never pass, lower, override, or otherwise tamper with `--max-attempts`
  unless the user explicitly requests a bounded attempt count.
- Never duplicate `vibe schema` output in this skill.
- Abort rather than guessing when the mentor exhausts attempts.
- Never pass file paths, URLs, or references to `--context`; the mentor
  can't read or resolve them.

## Verification

- `vibe schema` ran once before any other `vibe` command.
- `vibe constitution get` ran before each `vibe check`.
- Request included goal, concrete plan, and material uncertainty.
- Returned state received explicit handling: proceed, revise, or abort.
- Executed steps match the mentor's returned plan exactly.
- Mentor results reached the main agent unchanged.
