# Vibe Check Protocol

## Setup

Run once before first use to load provider config, available commands,
and output contracts:

```sh
vibe schema
```

## When to check

Use only when the plan involves:

- irreversible operations
- external side effects:
  - API calls
  - email
  - payment
- ambiguous scope
- flagged uncertainty
- multi-step chains with partial-failure risk

Skip for simple, reversible, single-step plans.

## Session setup (once per session)

```sh
vibe constitution set --rule "<rule>" [--rule "<rule>" ...]
```

Rules apply to every check in the session. Set before the first check.

## Check

```sh
vibe check --goal "<goal>" --plan "<plan>" [--prompt "<user requirement>"] [--uncertainty "<concern>" ...]
```

`vibe check` revises and rechecks internally until approval or attempt
exhaustion; never resubmit a blocked plan.

| field           | type  | action                                               |
| --------------- | ----- | ---------------------------------------------------- |
| `proceed`       | bool  | execute iff true                                     |
| `plan`          | str   | final reviewed plan; adopt mentor changes by default |
| `reason`        | str   | rationale                                            |
| `feedback`      | str   | mentor feedback; weigh when adjudicating changes     |
| `exhausted`     | bool? | true → abort; report task cannot reach safe approval |
| `feedbackFault` | true? | true → abort; report `diagnostic`                    |

### Adjudicate on `proceed=true`

The calling agent holds final discretion; the user requirement outranks
the mentor.

- Compare the returned `plan` with the submitted plan.
- For each mentor change:
  - Adopt by default, including safety additions and neutral edits.
  - Reject or adjust only on a cited conflict with:
    - user requirement
    - constitution
    - repository evidence
  - Never reject on preference, effort, or cost.
- Treat any step absent from both plans as a new decision point.
- Record each change's disposition and cited ground.
- Execute the adopted plan.

Exit codes: `0` proceed · `2` blocked/exhausted · `1` error

## Learn

After any mistake or success:

```sh
vibe learn --observation "<one sentence>" --category "<label>" --solution "<one sentence>" --type mistake|success|preference
```
