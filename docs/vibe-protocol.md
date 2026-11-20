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
| `proceed`       | bool  | mentor verdict; advice, never a halt                 |
| `plan`          | str   | final reviewed plan; weigh each change on its merits |
| `reason`        | str   | rationale                                            |
| `feedback`      | str   | mentor feedback; weigh when adjudicating changes     |
| `exhausted`     | bool? | true → mentor still objects; weigh `reason`          |
| `feedbackFault` | true? | true → no mentor input; report `diagnostic`          |

### Adjudicate every outcome

The mentor gives a second opinion; the calling agent decides, and no
verdict halts the run.

- Compare the returned `plan` with the submitted plan.
- Weigh each mentor change on its merits against the user requirement,
  constitution, and repository evidence, then adopt, adjust, or reject
  it.
- On `feedbackFault`, keep the submitted plan.
- Treat any step absent from both plans as a new decision point.
- Record each change's disposition and reason.
- Execute the resulting plan.

Exit codes: `0` proceed · `2` blocked/exhausted (JSON still prints) ·
`1` error

## Learn

After any mistake or success:

```sh
vibe learn --observation "<one sentence>" --category "<label>" --solution "<one sentence>" --type mistake|success|preference
```
