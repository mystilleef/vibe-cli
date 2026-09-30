# ORIENT

## Architecture shape

- Local-first _metacognitive_ `CLI`; inferred layered flow:
  `src/cli.ts` → `src/tools/` → persistence, provider, and filesystem
  helpers under `src/utils/`.
- Edge handlers normalize requests and shape results; tools coordinate
  domain policy. Utilities also provide facades and read projections;
  directory placement alone does not enforce dependency direction.
- Review bridge: `utils/llm.ts` reads active rules through
  `tools/constitution.ts`, connecting provider context to local state.
- Keep `cli.ts`, `utils/schema.ts`, and tool result types aligned.
  Read and asset surfaces separate text/JSON formatting from policy.

## Review path

`request → context assembly → feedback → history append →`
`gate verdict → [revision → retry] → final reviewed plan`

- `tools/vibeCheck.ts` and `utils/llm.ts` combine goal, plan, caller
  context, active constitution, recent guidance, and optional learning
  patterns.
- `utils/state.ts` records feedback before `tools/vibeGate.ts` requests
  a verdict. Interaction history tracks mentor guidance, not final
  approval decisions.
- Feedback faults halt gating; `utils/gateDecision.ts` defaults malformed
  verdicts to block. A blocked verdict permits one minimal revision
  through `llm.ts` before the next review; no unreviewed revision reaches
  the caller as the final plan.
- Provider adapters receive resolved credentials and prompt payloads;
  prompt construction, revision policy, and verdict interpretation stay
  above transport dispatch.

## State and lifecycle

- Directory identity binds autosessions, constitution rules, and review
  history. Access refreshes expiry; session rotation or retirement
  cascades deletion of rules and interactions. Learning entries span
  sessions independently.
- `utils/database.ts` owns normal bootstrap, migrations, legacy import,
  and connection lifecycle. Normal file connections enable `WAL` and
  foreign keys; compound state writes acquire immediate transactions
  before read-modify-write work, avoiding deferred lock-upgrade failures.
- Autosession, constitution, history, and prune writers share those
  connection invariants. `utils/sessionRows.ts` supplies parent-session
  creation for history and legacy imports.
- `utils/legacyImporter.ts` records artifact/backup provenance;
  `utils/doctorStorage.ts` consumes those records to distinguish legacy
  copies from stranded originals. Preserve provenance across changes to
  import and cleanup behavior.
- `utils/listDataReaders.ts` → typed projections → text/JSON formatters
  separates acquisition from presentation, not all reads from writes:
  ordinary readers can bootstrap storage; constitution reads also touch
  autosessions. Doctor diagnostics use a separate existing-only path.

## Learning consistency

- `tools/vibeLearn.ts` normalizes prose and category aliases before
  category-local overlap suppression; `utils/storage.ts` feeds both
  mentor context and read projections.
- `utils/learningEntryCore.ts` supplies shared row mappings, ordering,
  summaries, and overlap scoring across storage, listing, and pruning.
  Keep duplicate semantics aligned between ingestion and cleanup.
- Prune groups overlap-connected entries within each category and retains
  the newest member. Reuse its candidate groups rather than recomputing
  deletion policy in the presentation layer.

## Provider boundary

- `utils/settings.ts` and `utils/provider.ts` resolve named provider
  entries into model, credentials, and a common dispatch contract.
  Provider names select settings entries; protocol specs select adapters.
- `OpenAI`-compatible, `Anthropic`, and `Gemini` adapters translate
  authentication, thinking settings, and response shapes beneath review
  logic. Preserve custom-endpoint routing when changing transport code;
  do not move protocol-specific payloads into gate orchestration.

## Destructive-data boundary

- `tools/prune.ts` and `utils/pruneStorage.ts` separate candidate
  collection from deletion: stale learning, overlap duplicates, demo
  records, and expired sessions. Apply reuses collected identities after
  a safety backup and reports actual counts plus target-level failures.
- `tools/doctor.ts` coordinates diagnostics and maintenance through
  `DoctorExecutor`; `utils/doctorSql.ts` opens existing databases without
  normal bootstrap, migrations, or legacy import. Read-only diagnostic
  transactions share one snapshot, including committed `WAL` contents.
- Doctor preserves pre-apply findings separately from applied counts.
  Unavailable diagnostics produce null findings and failures; unhealthy
  or incomplete preflight blocks backup and maintenance. Successful
  preflight plus explicit confirmation and targets permits one backup
  before apply; later target failures do not stop unrelated targets.
- Prune and doctor share `utils/databaseBackup.ts` and
  `utils/databaseSnapshot.ts`: a read-only child snapshots SQLite into
  private staging, then exclusive hard-link publication prevents backup
  replacement. Preserve committed `WAL` data; never substitute copying
  the main database file alone. Surface cleanup failures without deleting
  completed backups.
- `utils/managedBackups.ts` shares naming and directory-shape contracts
  with the backup writer. Doctor retention spans both backup families
  and pins the current safety backup; purge re-inventories and revalidates
  candidates before unlinking.
- `utils/doctorPaths.ts` supplies containment and symlink checks for both
  legacy inventory and purge. Cleanup targets recorded safe backup copies,
  not stranded originals or arbitrary neighboring files.

## Packaged-agent boundary

- `utils/packageRoot.ts` anchors bundled skills, guide, and settings
  sources independently of the caller's directory. Target resolution
  and strict path validation protect installation boundaries.
- Inventory hashes raw asset bytes; installers consume those inventories
  rather than treating file presence as content equality.
- Skill installation blocks the entire batch on modified targets without
  replacement authorization, then reports per-skill copy failures without
  rollback. Guide installation replaces drifted content; settings
  installation preserves existing content without explicit replacement.
- Guide and settings installers share `utils/validation.ts` path checks
  and temporary-sibling atomic writes. Do not assume skill-tree copying
  shares that atomicity or overwrite policy.

## Evidence and uncertainty

- Source-derived synthesis across entry points, tool orchestration,
  storage readers/writers, provider dispatch, and asset installers;
  `README.md` corroborates review, persistence, and doctor behavior.
- No `ADR` corpus located. Layered topology and read-model separation
  describe observed organization, not enforced dependency rules.
