# Autosession — Implementation Proposal

## Goal

Replace the manual `--session` flag with an automatic, canonical session ID
derived from the working directory and a 4-hour inactivity TTL. Agents and
sub-agents get the correct session ID with zero configuration.

---

## New module: `src/utils/autosession.ts`

### Exports

```ts
getSessionId(): string
resetSession(): void   // internal use / testing only — not exposed as a CLI command
```

### Logic: `getSessionId()`

1. Hash `process.cwd()` with SHA-256; take the first 12 hex chars as `cwdKey`
2. Read `~/.vibe-check/sessions/<cwdKey>.json`
3. If the file exists and `lastAccessedAt` is within 4 hours of now → return `id`, update `lastAccessedAt`
4. Otherwise → generate a new `crypto.randomUUID()`, write a fresh session file, return the new `id`

### Session file schema

```json
{
  "id": "uuid-v4",
  "createdAt": 1700000000000,
  "lastAccessedAt": 1700000000000
}
```

Stored at: `~/.vibe-check/sessions/<cwdKey>.json`

### TTL

- **4 hours** of inactivity triggers a new session
- Every `getSessionId()` call touches `lastAccessedAt` — active tasks never expire
- No explicit renewal needed

### `resetSession()`

Deletes the session file for the current `cwd`. Internal only — not exposed
as a CLI command. The TTL handles natural rotation; `resetSession()` exists
only for testing.

---

## New command: `vibe session`

Prints the current session ID for the working directory.

```sh
$ vibe session
{"session":"a3f9c1d82b44"}
```

Useful for debugging, verifying sub-agent consistency, and confirming TTL
behavior. Calls `getSessionId()` — has the same side effect of touching
`lastAccessedAt` and extending the TTL.

---

## Changes

### `cli.ts`

- Remove `--session` option from: `check`, `learn`, `constitution set`,
  `constitution get`, `constitution reset`
- No replacement flag — session ID is sourced entirely from `autosession`

### `src/tools/vibeGate.ts` / `src/tools/vibeCheck.ts`

- Remove `sessionId` from input interfaces
- Call `getSessionId()` internally where `sessionId` was previously passed

### `src/tools/constitution.ts` CLI actions

- Replace `opts.session` with `getSessionId()` in all three subcommands

### `src/tools/vibeLearn.ts`

- Drop `sessionId` field from `VibeLearnInput` entirely
- `vibe learn` is session-agnostic; the field was accepted but never used

### `src/utils/state.ts`

- `getHistorySummary()` and `addToHistory()` signatures unchanged
- Callers pass `getSessionId()` instead of `opts.session`

---

## Sub-agent behavior

Sub-agents spawned within the same task share `cwd` → same `cwdKey` →
same session file → same session ID. No coordination required. The only
exception is a sub-agent that explicitly changes directory, which is
correct — a different `cwd` is a different work context.

---

## What gets removed

- `--session` flag from all commands
- `sessionId` field from `VibeLearnInput`
- All session-related CLI option parsing in `cli.ts`

---

## Files touched

| File | Change |
|---|---|
| `src/utils/autosession.ts` | New |
| `src/utils/state.ts` | Callers updated |
| `src/tools/vibeCheck.ts` | Remove sessionId from interface |
| `src/tools/vibeGate.ts` | Call getSessionId() internally |
| `src/tools/vibeLearn.ts` | Drop sessionId field |
| `src/tools/constitution.ts` | Use getSessionId() |
| `src/cli.ts` | Remove --session flags, add vibe session command, wire autosession |
