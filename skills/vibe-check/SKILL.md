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

## Goal

- Check assumptions, missing constraints, partial-failure risks, and
  plan quality before action as a pre-execution validation gate.
- Send the current goal and plan to `vibe check`, then follow the
  returned decision exactly.

## Input

- One-sentence goal.
- Ordered, concrete plan.
- Known risks, assumptions, uncertainty, and relevant context.
- Progress already completed when resuming mid-task.

## Workflow

1. **GATE**—Guard preconditions; make no changes:
   - Run `vibe schema` once per session; treat as authoritative for
     commands, options, outputs, and exit codes.
   - Run `vibe constitution get`; fix missing, stale, or contradictory
     rules before continuing.
2. **ORIENT**—Goal: confirm the plan before execution. Won't change: the
   original goal and any completed progress.
3. **PLAN**—Build a compact validation request:
   - `--goal`: one sentence.
   - `--plan`: ordered, concrete, execution-ready steps.
   - `--uncertainty`: one entry per material risk, assumption, or open
     concern.
   - `--context`: constraints and grounding the mentor needs; pass text
     verbatim—the mentor has no file access, tools, or external context.
   - `--progress`: include when resuming after partial work.
4. **ACT**—Run `vibe check`.
5. **VERIFY**—Handle returned state:
   - `proceed=true`: execute the returned `plan` exactly, not the
     original.
   - `proceed=false`, not exhausted: revise from `reason`, `feedback`,
     and returned `plan`; fully form the revised plan; return to step 4.
   - `exhausted=true`: halt; report that the mentor failed to approve
     the plan within the attempt limit.
6. **PERSIST**—Run `vibe learn` when work revealed a mistake, reusable
   success, or durable correction.
7. **REPORT**—Surface the mentor's decision and approved plan to the
   calling agent unchanged.

## Directives

- Check before execution, not after.
- Keep validation payloads concise but sufficiently grounded.
- Fully form each revised plan before resubmitting—no incremental or
  speculative calls.
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
- `vibe check` has blocking semantics—wait for it to return before any
  further action; never treat it as a polling mechanism.
- Calls routinely take several minutes; never pass a Bash `timeout` or
  any equivalent deadline—wait unconditionally.
- One call per decision point, hard limit—never invoke again for the
  same goal/plan pair, whether pending or already returned.
- Never retry a slow or pending call—wait; each call consumes quota,
  tokens, and budget.

## Verification

- `vibe schema` ran once before any other `vibe` command.
- `vibe constitution get` ran before each `vibe check`.
- Request included goal, concrete plan, and material uncertainty.
- Returned state received explicit handling: proceed, revise, or abort.
- Executed steps match the mentor's returned plan exactly.
- Mentor results reached the main agent unchanged.
