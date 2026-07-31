# ORIENT

## Architecture shape

- Local-first _metacognitive_ `CLI`:
  - `CLI` edge: request normalization, domain delegation, result
    shaping.
  - Tools: review, learning, constitutions, pruning, demos, asset
    installation.
  - Utilities: persistence, session identity, provider adapters, package
    traversal, validation, read projections.
- Dominant flow: `CLI` → tools → utilities → provider, filesystem,
  `SQLite`.
- Review bridge: review-context assembly reads active constitution
  rules.

## Review path

`request → input shaping → feedback → history append →`
`gate verdict → [revision → retry] → final verdict`

- Context: combines goal, plan, caller context, session rules, recent
  interactions, optional learning patterns.
- Feedback: records guidance in session history; faults halt execution
  before gate evaluation.
- Blocked verdicts: trigger one minimal plan revision before retry; all
  returned plans undergo review.
- `llm` module: owns prompts, fallback guidance, revision, decision
  parsing; adapters receive credentials and payloads.

## State and lifecycle

- _Autosession_: working-directory identity; active access refreshes
  `TTL`, expiry rotates identity.
- Sessions: bind constitution rules and interaction history; retirement
  cascades deletion of dependent state.
- `DB` bootstrap: schema evolution, concurrency-aware migrations, legacy
  import bookkeeping, handle lifecycle.
- Learning ingestion: normalizes prose/aliases, suppresses overlaps,
  supplies mentor context, projections, prune candidates.
- Learning core: shared ordering and overlap logic protect consistency
  across record, list, _dedupe_, delete.
- Read model: separates `DB` readers, typed projections, text/`JSON`
  formatters.

## Provider boundary

- Resolution: maps provider/model choices to a unified dispatch
  contract.
- Adapters: `OpenAI`-compatible, `Anthropic`, `Gemini`; isolates
  protocol quirks below the review layer.
- `Gemini`: preserves custom-endpoint direct routing; proxy
  compatibility depends on model-content path.
- Thinking translation: adapter-specific; unified settings prevent
  provider leakage.

## Destructive-data boundary

- Candidate collection: targets stale records, duplicates, demo records,
  expired sessions before mutation.
- Pruning: reuses candidate sets, backs up `DB`, reports target-level
  outcomes.
- _Deduplication_: category-local, retains newest record, uses shared
  overlap scores.

## Packaged-agent boundary

- Bundled assets: resolve skills and guide content from package root,
  not caller-relative paths.
- Inventory: raw-byte hash comparison; rejects symlinks and unsafe tree
  shapes.
- Skill replacement: whole-batch modified-target blocking, per-skill
  failure reporting, no rollback.
- Guide replacement: validates path components, writes temporary sibling
  file, renames atomically.

## Extension rules

<!-- prettier-ignore -->
| Concern | Owner | Rules |
| --- | --- | --- |
| `CLI` surface | `CLI` edge | Parse requests & outputs,<br>no domain policy |
| Review | Gate + `llm` | Feedback → verdict →<br>revision after block → retry |
| Session | _Autosession_ | Directory identity<br>for rules and history |
| State | `DB` helpers | Migrations, retries,<br>backups, invariants |
| Providers | Adapters | Auth, thinking, response<br>parsing per adapter |
| Learning | Core | Normalization, ordering,<br>category, overlap semantics |
| Read model | Readers | Data projection separate<br>from presentation |
| Assets | Installers | Hash comparison and<br>strict symlink validation |

## Evidence and uncertainty

- Confirmed: session review context, feedback-first gating, provider
  dispatch, migration memory, backup-first pruning, asset lifecycle.
- Inferred: layered dependency topology and decoupled read models.
- Omitted: `ADR` corpus absent; claims limited to design notes and
  implementation.
