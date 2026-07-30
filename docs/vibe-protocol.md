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
vibe check --goal "<goal>" --plan "<plan>" [--uncertainty "<concern>" ...]
```

| field       | type  | action                                             |
| ----------- | ----- | -------------------------------------------------- |
| `proceed`   | bool  | execute iff true                                   |
| `plan`      | str   | execute this — never your original                 |
| `exhausted` | bool? | true → abort; report task cannot be safely planned |
| `reason`    | str   | rationale                                          |
| `feedback`  | str?  | feedback to address before resubmitting            |

- If `proceed=true`, execute the returned `plan`.
- If `proceed=false` and `exhausted!=true`:
  - revise from:
    - `reason`
    - `feedback`
    - returned `plan`
  - resubmit
  - repeat until:
    - `proceed=true`
    - or `exhausted=true`
- Execute only the final approved returned `plan`.

Exit codes: `0` proceed · `2` blocked/exhausted · `1` error

## Learn

After any mistake or success:

```sh
vibe learn --observation "<one sentence>" --category "<label>" --solution "<one sentence>" --type mistake|success|preference
```
