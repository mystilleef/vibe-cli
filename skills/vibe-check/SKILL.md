---
name: vibe-check
description: >-
  Gets a second opinion on complex ideas, plans, and solutions from the
  vibe CLI mentor before execution. Use before risky, ambiguous,
  irreversible, or multi-step work to surface blind spots and refine the
  plan. Advises only—never halts a run.
user-invocable: true
argument-hint: "<goal and proposed plan>"
---

# Vibe check

## When to use

- Complex, risky, irreversible, ambiguous, or multi-step action.
- Plans carrying meaningful side effects or uncertain assumptions.
- High-impact architecture, remediation, migration, or release plans.

Skip trivial, reversible, single-step plans—for example, single-file
edits under test coverage, local renames, or changes reversible via
`git revert`.

## Goal

- Get a second opinion on assumptions, missing constraints,
  partial-failure risks, and plan quality before action.
- Send goal and plan to `vibe check`, weigh each mentor change on its
  merits, then hand the resulting plan back to the caller.
- The mentor advises, and the calling agent decides. No verdict halts
  the run.

## Input

- One-sentence goal.
- User requirement: acceptance criteria and fixed constraints.
- Ordered, concrete plan.
- Known risks, assumptions, uncertainties, and relevant context.
- Progress completed when resuming mid-task.

## Workflow

1. **GATE**—Guard preconditions without making changes:
   - Run `vibe schema` once per session, treating its output as
     authoritative for commands, options, outputs, and exit codes.
   - Run `vibe constitution get`, then resolve missing, stale, or
     contradictory rules before proceeding.
   - On a missing CLI or failed `vibe` command, skip to `REPORT` with
     the diagnostic.

2. **ORIENT**—Anchor goal before execution:
   - Goal: get a second opinion on plan safety, quality, and requirement
     alignment before execution.
   - Immutable state: original user requirement and completed progress.
   - Authority order: user requirement and constitution, then the
     calling agent. The mentor only advises.

3. **PLAN**—Construct compact review request:
   - `--goal`: one sentence.
   - `--plan`: ordered, concrete, execution-ready steps.
   - `--uncertainty`: material risks, assumptions, or open concerns.
   - `--prompt`: user requirement, verbatim.
   - `--context`: scope boundaries, limitations, and constraints, passed
     verbatim without file paths or unresolved references.
   - `--progress`: include when resuming after partial work.

4. **ACT**—Run `vibe check` with constructed flags:
   - Read the JSON on stdout whatever the exit code: `2` signals a
     mentor block, not an error.

5. **VERIFY**—Weigh the returned CLI JSON (`vibeGateLoop` outcome) as a
   second opinion:
   - Read the verdict as advice:
     - `proceed=true`: the mentor approves the returned `plan`.
     - `exhausted=true`: the mentor still objects after revision. Weigh
       `reason` as an open concern.
     - `feedbackFault=true` or exit `1`: no mentor input. Keep the
       submitted plan and record the diagnostic.
   - Weigh each mentor change—each difference between the returned and
     submitted `plan`—on its merits against the user requirement,
     constitution, and repository evidence, using `reason` and
     `feedback`:
     - Adopt, adjust, or reject it, recording why.
     - Treat any step absent from both plans as a new decision point.
   - Form the resulting plan from the submitted plan and each adopted or
     adjusted change.

6. **PERSIST**—Run `vibe learn` when work reveals a mistake, reusable
   success, or durable correction, including a mentor change rejected on
   a durable ground.

7. **REPORT**—Surface to the calling agent:
   - Mentor verdict, as advice, and the resulting plan.
   - Ledger: each mentor change, its disposition (adopted, adjusted,
     rejected), and reason.
   - Diagnostic on a missing CLI, feedback fault, or CLI error—no mentor
     input, so the caller keeps its submitted plan.

## Directives

- Optimize all operations for agent, token, and context efficiency.
- Check before execution, not after.
- Keep request payloads concise and grounded.
- State scope limitations and boundaries explicitly.
- Wait for `vibe` to return regardless of duration.
- Treat every verdict as a second opinion, never a command.
- **IMPORTANT:** Return the result to the caller.

## Constraints

- Never invoke separate skills for `vibe constitution` or `vibe learn`
  inside this skill.
- Never substitute `vibe check` for required user approval.
- Never halt the caller's run on a verdict, feedback fault, or CLI
  error: every outcome ends in `REPORT`.
- Never tamper with `--max-attempts` unless the user requests explicit
  bounds.
- Exclude file paths, URLs, or external references from `--context`.
- Limit execution to one `vibe check` invocation per decision point.
- Avoid retrying pending or slow calls.

## Verification

- `vibe schema` ran once before executing `vibe` commands.
- `vibe constitution get` ran before invoking `vibe check`.
- Request payload contained goal, concrete plan, and material
  uncertainties.
- Every outcome reached `REPORT`, with no halt.
- Each difference between the returned and submitted `plan` carries a
  disposition and reason in the ledger.
- The resulting plan reflects every ledger disposition.
