# ORIENT

## Scope

- Agent-facing architecture guide for repository changes.
- Complements AGENTS.md; policy and process rules stay there.
- Evidence: DESIGN.md, README storage/layout notes, source import graph,
  selected tests.

## Architectural stance

- Layered CLI with a thin edge:
  - `src/cli.ts` parses user input, normalizes params, emits JSON/text,
    then delegates.
  - `src/tools/*` owns use-case orchestration: gate review, learning
    capture, constitution rules, demo, pruning.
  - `src/utils/*` owns persistence, provider calls, settings validation,
    list readers/`formatters`, and low-level primitives.
- Local-first `metacognitive` system:
  - `LLM` calls review plans, decide go/no-go, and revise blocked plans.
  - SQLite memory feeds future reviews via check history, learning
    summaries, and active constitution rules.
- Source graph primarily flows `CLI -> tools -> utils`; list-data and
  prune paths add utility `sublayers` for readers, formatting, parsing,
  and candidate deletion.

## Core flows

- Gate review:
  - CLI/helper layer builds `VibeCheckInput`.
  - `vibeGateLoop` calls `vibeGateTool` per attempt.
  - `vibeCheckTool` resolves `autosession`, fetches history, requests
    mentor feedback, then records feedback.
  - `getGateDecision` converts feedback into go/no-go JSON; blocked
    attempts call `revisePlan` before the next review.
- Learning capture:
  - Validation requires observation/category plus solution for
    mistake/success entries.
  - Normalizers collapse observation/solution to one sentence and
    `canonicalize` category aliases.
  - Overlap scoring suppresses duplicates before storage; output returns
    category counts and recent examples.
- Constitution rules:
  - `Autosession` resolution supplies the session id.
  - Database rows store ordered, capped rules; reset/update replace the
    whole session rule set.
- Prune/list data:
  - Readers collect database/settings state; `formatters` and `DTO`
    transforms shape output.
  - Candidate collection, count computation, representative samples,
    backup-backed deletion, and target ordering converge in prune
    storage helpers.

## State model

- `sessions`: workdir-hash `autosession` records; resolver refreshes
  activity and rotates expired records.
- `interactions`: feedback history per `autosession`; state utilities
  keep recent rows.
- `learning_entries`: local mistake/preference/success memories; demo
  rows carry cleanup markers.
- `constitution_rules`: ordered rules per `autosession`;
  replace-on-write preserves cap and order.
- `schema_migrations` plus `legacy_imports`: migration ledger and legacy
  JSON import bookkeeping.
- Database access funnels through `withDatabase`/`getVibeDatabase`;
  default access uses a process singleton, explicit options open scoped
  handles.

## Provider architecture

- Settings resolution chooses provider entry and model; overrides travel
  through `DTOs`, not global mutation.
- Spec dispatch stays central in `provider.ts`:
  - OpenAI-compatible path uses SDK chat completions.
  - Anthropic path uses raw fetch plus header builder.
  - Gemini default path uses SDK; Gemini custom `baseUrl` path uses raw
    fetch to avoid SDK `hardcoded` version path.
- Prompt assembly stays in `llm.ts`; provider implementations receive
  system prompt plus user content only.
- `llm.ts` composes constitution, interaction history, and optional
  learning history before provider dispatch.

## Central abstractions

- **`VibeCheckInput`**: Common payload through CLI helpers, gate loop,
  mentor feedback, and state history.
- **`VibeGateOutput`**: Gate verdict contract across CLI, skills, and
  tests.
- **`LearningEntry`**: Shared memory shape across storage, list, prune,
  and duplicate logic.
- **`ProviderSettingsEntry`**: Provider dispatch contract across
  settings, provider, schema, and list surfaces.
- **`AutosessionRecord`**: Session identity bridge for constitution,
  history, demos, and list readers.
- **`PruneCandidateSets`**: Shared dry-run/destructive prune planning
  payload.

## Boundaries and traps

- Keep edge-layer changes in CLI/helpers; don't move prompt, storage, or
  provider logic upward.
- Keep tool modules orchestration-only; direct SQL belongs in
  storage/database/prune/state/constitution utilities.
- Route all `LLM` text through `llm.ts`; provider layer must not inspect
  gate semantics, constitution, learning history, or attempts.
- Route all persistent writes through database utilities; bypassing them
  skips migrations, legacy import, session caps, backup logic, or
  singleton handle control.
- Preserve gate ordering: mentor feedback -> go/no-go JSON -> revision
  only after block -> final reviewed plan.
- Preserve `autosession` ownership inside resolver; public surfaces
  avoid caller-supplied session ids.
- Keep list readers, `DTO` transforms, and pretty `formatters`
  separated; tests rely on deterministic seams.
- Keep Gemini custom-endpoint branch; deleting it breaks proxy
  compatibility documented in DESIGN.
- Before destructive prune paths, reuse candidate collectors and backup
  helper; never delete rows from CLI/tool code.

## Evidence and uncertainty

- No `ADR` directory found; DESIGN supplies provider exceptions, README
  supplies storage/layout intent, tests encode public boundary
  expectations.
- Inferred: layered pattern and CLI -> tools -> utils boundary from
  import graph.
- Confirmed: provider customization, `autosession`-scoped memory,
  gate/revision loop, migration-backed SQLite storage, backup-backed
  prune path.
