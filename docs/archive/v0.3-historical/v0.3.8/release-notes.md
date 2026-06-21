# v0.3.8 Release Notes

v0.3.8 reclaims the ontology mid-layer that v0.1–v0.3.7 staged as
"v0.4 future work" (distillation, EvidenceCapsule production, four
staged MemoryGraphEdge producers, PathRelation propose) and then
closes a second wave of wiring repair surfaced by an external
adversarial review. Six open backlog items close in this release.
The only deferred follow-up is `#BL-044` (recall utilization
follow-through), targeted at v0.3.9 by user directive.

No MCP tool name / request schema / response schema changes. One
additive schema field (`SoulOpenPointerContentSchema.gist|.excerpt`,
both optional). One new SQL migration (`068-evidence-capsule-fts.sql`
— FTS5 only). Workspace packages bumped `0.3.7` → `0.3.8`.

## Added

### Ontology mid-layer

- `EvidenceCapsule` is now a first-class persisted object in the
  candidate signal → materialization path. `MemoryEntry.content` is a
  distilled fact (caller-supplied or rule-based 2-sentence fallback
  capped at 280 chars across Latin + CJK terminators); the raw turn
  lives in `EvidenceCapsule.gist / .excerpt`.
- `soul.open_pointer` falls through to `EvidenceService.findByIdScoped`
  when the memory lookup misses, so attached agents can dereference
  `evidence_refs[i]` to raw turn material through the same MCP entry
  point used for memory pointers.
- `068-evidence-capsule-fts.sql` adds an FTS5 virtual table + insert /
  update / delete triggers mirroring memory-FTS. Recall's lexical plane
  now consults evidence FTS in addition to memory FTS; matches resolve
  back to owning memories via `MemoryEntry.evidence_refs` (JSON
  `LIKE ? ESCAPE '\\'` with `%"<id>"%`).
- The four staged `MemoryGraphEdgeType` values (`supersedes`,
  `contradicts`, `exception_to`, `incompatible_with`) now have
  writers: caller-explicit hints via `raw_payload.{supersedes,
  exception_to, contradicts, incompatible_with}_refs` produce the
  corresponding edges at materialization time, and a new
  `ConflictDetectionService` (env-gated) runs rule-based + optional
  LLM detection inside the same materialization pass.
- `PathRelationProposalService` writes the first PathRelation entries
  once a memory pair has been co-used K=3 times in separate recall
  reports; `PathPlasticityService` then has real paths to evolve.
- `INITIAL_ACTIVATION_FROM_CONFIDENCE_FACTOR` bumped 0.5 → 0.6 on the
  tier-promotion path so freshly promoted memories carry a stronger
  scoring base weight.

### Wiring repair (codex-review response)

- Cohort dominance guard now covers both the exact and seed branches
  jointly. v0.3.7 only guarded the seed branch, which let the exact
  branch saturate cross-question recall at 82% winning admission;
  v0.3.8 computes the union and admits / skips both branches together.
- Mandatory share cap in `fineAssess`: winner-attested entries always
  bypass budget; protected-dimension non-winners are capped at
  `floor(max_entries * 2/3)` so 1/3 of the budget stays available for
  ranked non-mandatory candidates. Excess protected entries drop at
  this boundary instead of re-entering the optional pool.
- New integration tests give live proof for two claims earlier
  closeouts made without it: PathRelation `onCoUsage` → durable
  PathRelation row → recall `path_expansion` candidate; and `open_pointer`
  → `evidenceService.findByIdScoped` returning gist + excerpt.

### Bench infrastructure

- `packages/eval/src/wilson-ci.ts` computes the 95% Wilson interval.
  `report.md` annotates R@K with the half-width + explicit lo / hi
  bounds and adds a sample-size label (smoke / shard_merged / full)
  on the header line. `diff.ts` widens ratio-KPI regression bands to
  `max(raw, ci_half_width)` when `evaluated_count < 100` so a
  noise-level delta on a small run does not trip the fail / warn
  alarm.
- `apps/bench-runner/src/locomo/` ships dataset schema (LoCoMo
  conversations + dia_id evidence), sha256-pinned fetcher mirroring
  the LongMemEval pattern, and a runner that proposes every session
  turn into a per-conversation workspace then drives `soul.recall`
  per QA. Archives land under `docs/bench-history/public-locomo/`.
  The pinned checksum is committed at
  `docs/bench-history/datasets/locomo10.meta.json` (sha
  79fa87e9…ea698ff4, 10 conversations, 1986 QA, 5882 turns).
- `alaya-bench-runner fetch-locomo` and `alaya-bench-runner locomo`
  CLI subcommands.

### Inspector

- `apps/inspector/web/src/pages/MemoryBrowser.tsx` (route
  `/memory-browser`) renders the workspace's durable memories with
  dimension / scope / has-conflict filter chips. Selecting a row
  opens a right-side drawer showing the distilled memory content
  plus the evidence_refs list; clicking an evidence ref calls the
  new `/api/pointers/:workspaceId/:objectId` route, which forwards to
  the daemon evidence read, and renders the resolved EvidenceCapsule
  gist + excerpt.
- `apps/inspector/web/src/components/CommandPalette.tsx` adds a cmd-K
  / ctrl-K command palette spanning page jumps plus the five
  `attach / detach / status / inspect / review` CLI verbs.
  Inspector remains a tooling loopback (invariants §21a); the
  palette copies the CLI command to clipboard rather than invoking
  it.

### Operator env vars

- `ALAYA_CONFLICT_DETECTION_ENABLED` — opt in to
  `ConflictDetectionService` (off by default).
- `ALAYA_CONFLICT_RULE_ENABLED` — when `false`, the LLM port becomes
  the sole producer of contradicts / incompatible_with edges. Default
  `true`.
- `ALAYA_CONFLICT_LLM_PROVIDER_URL` / `_API_KEY` / `_MODEL` /
  `_TIMEOUT_MS` — LLM pair classifier hook (unchanged from prior
  v0.3.8 batch).
- `ALAYA_PATHREL_COUNTER_TTL_MS` — TTL milliseconds for the
  PathRelationProposalService in-process pair counters. Default
  86400000 (24h).
- `ALAYA_ENABLE_EMBEDDING_SUPPLEMENT` + `OPENAI_EMBEDDING_PROVIDER_URL`
  + `OPENAI_EMBEDDING_MODEL` + `ALAYA_OPENAI_SECRET_REF` — recall-time
  embedding supplement wiring. yunwu.ai `/v1/embeddings` recipe
  (text-embedding-3-small, 1536-d) documented in
  `docs/archive/v0.3-historical/v0.3.8/README.md`.

## Resolved backlog

- `#BL-039` — Wire real embedding provider into recall path
- `#BL-040` — 95% Wilson CI in bench report + ci-aware bands
- `#BL-041` — LoCoMo cross-stack comparison
- `#BL-042` — Inspector Memory Browser + cmd-K palette
- `#BL-045` — PathRelationProposalService counter eviction port
- `#BL-046` — ConflictDetectionService rule-path disable toggle

Deferred:

- `#BL-044` — Recall utilization follow-through, scheduled v0.3.9 by
  user directive.

## Known follow-ups

- Cross-question accumulation is not yet observable on
  LongMemEval-shaped workloads because the questions are topically
  independent and PathRelation propose fires at K=3 co-usage. The
  architecture is in place; demonstrating it needs a workload where
  consecutive queries share concepts.
- `graph_expansion` and `path_expansion` planes still contribute few
  winning admissions on disabled bench surfaces because the
  `usage_proof` gate is strict and PathRelations only enter after 3
  co-usage events.

## Verification commands

```bash
rtk pnpm build
rtk pnpm test
rtk node apps/bench-runner/bin/alaya-bench-runner.mjs longmemeval \
  --variant s --limit 500 --embedding disabled --history-root docs/bench-history
rtk node apps/bench-runner/bin/alaya-bench-runner.mjs longmemeval \
  --variant s --limit 500 --embedding env --history-root docs/bench-history
rtk node apps/bench-runner/bin/alaya-bench-runner.mjs longmemeval-crossquestion \
  --variant s --limit 100 --embedding disabled --history-root docs/bench-history
rtk node apps/bench-runner/bin/alaya-bench-runner.mjs fetch-locomo
rtk node apps/bench-runner/bin/alaya-bench-runner.mjs locomo \
  --embedding disabled --history-root docs/bench-history
```
