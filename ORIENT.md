# ORIENT

## Scope and evidence

- Agent architecture guide complementing `AGENTS.md`.
- Evidence: `DESIGN.md`, `README.md`, import graph, plus gate, storage,
  installer, prune, migration, and package tests.
- `ADR` corpus absent.
- **Inferred** labels mark conclusions derived from topology rather than
  design prose.

## System shape

- Local-first _metacognitive_ `CLI`:
  - `src/cli.ts`: parses input, normalizes parameters, shapes
    `JSON`/text output, delegates.
  - `src/tools/*`: coordinates gate review, learning capture,
    constitution rules, demo, pruning, bundled-skill installation.
  - `src/utils/*`: supplies persistence, sessions, prompt/provider
    mechanics, schemas, list projections, package traversal, primitives.
- Dominant direction: `CLI` -> `tools` -> `utils`.
  - Query bridge: `llm.ts` reads constitution rules across tool
    boundary.
  - Utility _sublayers_: list and prune add readers, `DTO`s,
    _formatters_, parsers, candidate collectors, deletion handlers.
- `SQLite` memory carries review history, lessons, constitution rules,
  sessions, migration state, legacy import bookkeeping.

## Core flows

### Gate review

- `CLI` helpers build `VibeCheckInput`; `vibeGateLoop` owns execution
  attempts.
- Each attempt routes through `vibeCheckTool`:
  - `Autosession` resolution selects history and constitution scope.
  - `llm.ts` combines goal, plan, uncertainty, progress, task context,
    constitution, prior feedback, optional learning context.
  - Provider feedback enters persistent interaction history.
- Decision parsing processes mentor feedback; blocked attempts invoke
  `revisePlan` before retry.
- Final output carries reviewed plan, verdict, attempt count, exhaustion
  marker.
- Provider failure returns fallback feedback and retains closed approval
  state.

### Memory and lifecycle

- `AutosessionRecord` binds working-directory identity to interaction
  and rule ownership; resolver refreshes active and rotates expired
  records.
- Database startup applies independently committed migrations, rechecks
  concurrent winners, retries transient `SQLite` contention.
- Legacy `JSON` import runs alongside bootstrap; import markers and
  backups prevent duplicate migration work.
- Learning capture normalizes category aliases and prose, scores
  overlap, suppresses duplicates, then feeds listing, pruning, optional
  mentor context.
- Constitution updates replace ordered session rules; cap handling stays
  inside constitution tool.
- Separate list readers, `DTO` transforms, _formatters_ maintain stable
  `JSON` and text surfaces.

### Prune

- Candidate collectors supply count estimates and representative samples
  before destructive actions.
- Backup creation precedes deletion; target ordering and per-target
  failure details preserve partial-outcome visibility.
- Learning, duplicate, demo, stale-session cleanup share
  `PruneCandidateSets` selection logic.

### Bundled skills

- Bundled skills travel as recursively hashed trees rooted at `SKILL.md`
  files.
- Discovery and target reads reject symlinks and unsafe tree shapes;
  inventory classifies missing, matching, modified targets.
- Modified targets block installation without explicit replacement
  authorization; authorized replacement clears target-only files.
- Installer preflight validates target parent directory even for
  planning paths; per-skill plain copies surface partial failures
  without staging or rollback.
- Package tests exercise packed artifacts, source discovery, inventory,
  `CLI` contracts, installation behavior together.

## Provider architecture

- Settings resolution selects provider and model; one-call overrides
  pass through `DTO`s without global mutation.
- `provider.ts` centralizes spec dispatch:
  - `OpenAI`-compatible providers: `SDK` chat completions.
  - `Anthropic`: raw fetch with dedicated headers and configuration.
  - `Gemini`: `SDK` for standard endpoints, raw fetch for custom
    `baseUrl` paths.
- Preserve `Gemini` custom-endpoint path; proxy compatibility depends on
  direct `/models/{model}:generateContent` routing.
- `llm.ts` owns prompt assembly, feedback fallback, plan revision,
  gate-decision prompting, connectivity probes.
- Provider implementations receive prompts and credentials only; gate
  semantics, history, rules, learning context remain above that
  boundary.

## Central contracts

- `VibeCheckInput` / `VibeGateOutput`: review payload and verdict across
  `CLI`, gate loop, state, skills, tests.
- `AutosessionRecord`: session identity bridge for review history,
  constitution, demos, list readers.
- `LearningEntry`: memory shape across validation, storage, list
  projections, duplicate scoring, prune.
- `ProviderSettingsEntry`: settings-to-dispatch contract.
- `PruneCandidateSets`: dry-run and destructive prune planning payload.
- `SkillsInventory`: source/target hash comparison contract for list and
  installation paths.

## Boundaries and traps

- Maintain `CLI` code at edge; locate orchestration in tools,
  persistence/provider mechanics in utilities.
- Route `LLM` text through `llm.ts`; keep provider adapters isolated
  from review attempts, rules, history, learning semantics.
- Route persistence through database utilities; direct access bypasses
  migration, import, retry, backup, handle-lifecycle safeguards.
- Maintain review sequence: feedback -> verdict -> revision after block
  -> retry review.
- Restrict _autosession_ ownership to resolver; public interfaces avoid
  caller-controlled session identifiers.
- Separate list readers, `DTO` transforms, _formatters_.
- Reuse candidate collectors and backup helpers before row deletion.
- Keep recursive hash and symlink validation during skill discovery and
  target inspection.
- Maintain whole-batch modified-target blocking and per-skill failure
  reporting for deterministic outcomes.

## Evidence and uncertainty

- Confirmed: migration-backed `SQLite` memory, _autosession_-scoped
  review context, gate/revision loop, central provider dispatch, proxy
  `Gemini` routing, backup-first prune, packaged skill lifecycle.
- Inferred: layered `CLI` -> `tools` -> `utils` direction and utility
  _sublayer_ boundaries from imports and test seams.
- `DESIGN.md` anchors provider exceptions; integration tests anchor
  installation and migration guarantees.
