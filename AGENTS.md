# Agent

## Commands

- `bun check` — type-check; auto-fix trivial lint
- `bun coverage` — full test suite
- `bun verify` — comprehensive verification

Run scripts exactly as named. **Never** expand internals or pipe `bun`
commands—redirect output to a file first, then inspect:

```sh
# Forbidden — causes freezes
bun test 2>&1 | head -n 10
bun test | tail -n 10

# Approved
bun test > tmp.txt && cat tmp.txt | head -n 10
bun verify
```

## Workflow

**CI:** `bun verify`

## Rules

- Write asynchronous, non-blocking code.
- After edits: run `bun check`.
- After task completion: run `bun verify`.

### Testing

- Read guides in `./docs/bun/testing` before writing tests. The agent
  file indexes each guide.

## Gotchas

- No empty lines inside functions.
- One empty line before and after functions and classes.
- Never commit or track `proposals/`.
