# v0.3.8 — Ontology Mid-Layer Recapture + Codex-Review Wiring Repair

## Status

Implementation slice on 2026-05-16. v0.3.8 covers thirteen plan items
across five ontology layers that the v0.1-v0.3.7 implementation
explicitly staged as "v0.4 future work" in
`packages/protocol/src/soul/memory-graph.ts`, `path-relation.ts`, and
`evidence-capsule.ts`, plus a second wave of codex-review wiring
repairs that close every open backlog item except #BL-044 (utilization
follow-through, deferred to v0.3.9 by user directive). No new
ontology-side SQL migration was required (storage tables already
existed); a single FTS migration (`068-evidence-capsule-fts.sql`) was
added for evidence-side lexical search.

## Scope

### Codex-review wiring repair (commits ef65f37..d548625)

- **Cohort dominance guard covers exact branch** — v0.3.7 only guarded
  the seed-cohort branch; the exact branch (query surface_id/run_id
  matches) admitted unconditionally and saturated cross-question
  recall at 82% winning admission. v0.3.8 jointly guards both branches
  via a union ratio check.
- **Mandatory share cap in fineAssess budget gate** — protected-
  dimension non-winners are capped at floor(max_entries * 2/3) so the
  remaining slots stay available for ranked non-mandatory candidates;
  excess protected entries are dropped at this boundary instead of
  re-entering the optional pool and out-ranking precise candidates.
- **PathRelation + Evidence pointer E2E proofs** — two new integration
  tests demonstrate the wiring claims earlier closeouts made without
  live proof: K=3 onCoUsage events through to a path_expansion
  candidate via real SQLite, and `soul.open_pointer` falling through
  to `EvidenceService.findByIdScoped` returning gist + excerpt.
- **Accept-path edge writer (withdrawn)** — Proposal schema does not
  carry target / supersedes / exception signals; `acceptPendingMemoryUpdate
  WithEvents` is an in-place update on the existing memory so no
  (new, old) memory pair forms. All four staged edge types continue
  to be produced at materialization time via `raw_payload.*_refs`
  caller-explicit hints plus the rule-based `ConflictDetectionService`.

### Open backlog items closed in v0.3.8

- **#BL-039 Wire real embedding provider** — `OpenAIEmbeddingClient`
  already supports a baseUrl override and bench-runner has the
  `--embedding env` flag; v0.3.8 adds the operator-facing wiring path
  (yunwu.ai `/v1/embeddings`) and runs the embedding-on archive
  alongside the disabled baseline.
- **#BL-040 95% Wilson CI in bench report** — `report.md` annotates
  R@K with the Wilson interval half-width + bounds; `diff.ts` widens
  ratio-KPI bands to `max(raw, ci_half_width)` when `evaluated_count
  < 100`; sample size label (smoke / shard_merged / full) is rendered
  on the report header.
- **#BL-041 LoCoMo dataset + bench driver** — new
  `apps/bench-runner/src/locomo/` ships dataset schema, sha256-pinned
  fetcher, runner, and CLI subcommand; archive lands under
  `docs/bench-history/public-locomo/`.
- **#BL-042 Inspector Memory Browser + cmd-K palette** — new
  `apps/inspector/web/src/pages/MemoryBrowser.tsx` page with
  filter chips, evidence-pointer drawer, and a cmd-K command palette
  (page jumps + copy-to-clipboard CLI verbs; inspector remains a
  loopback).
- **#BL-045 PathRelation counter TTL eviction** — service tracks
  `firstSeenAtMs` per pair and exposes `evictExpired()`; daemon
  schedules an unref'd setInterval (`ALAYA_PATHREL_COUNTER_TTL_MS`,
  default 24h) so sub-threshold pairs do not grow unbounded.
- **#BL-046 ConflictDetectionService rule-path toggle** — service
  accepts `ruleEnabled` (env `ALAYA_CONFLICT_RULE_ENABLED`); when
  false the LLM port becomes the sole producer of contradicts /
  incompatible_with edges.

### Ontology mid-layer recapture (v0.3.8 batch 1, commits ab4bcb7..6c78010)

Reclaims the ontology mid-layer that was a schema-only contract:

- **Distillation gap**: MemoryEntry.content was the raw turn excerpt
  (no fact extraction). After v0.3.8 it carries a distilled fact;
  raw turn lives in EvidenceCapsule.gist / .excerpt and is reached
  via `soul.open_pointer`.
- **Activation initialization**: `INITIAL_ACTIVATION_FROM_CONFIDENCE_FACTOR`
  bumped 0.5 → 0.6 so the scoring base weight has a stronger initial
  signal.
- **Content preview gate**: `createContentPreview` now serves full
  content whenever `manifestation === "full_eligible"`, regardless
  of `originPlane`. Workspace-local memories no longer get
  unconditionally truncated to 157 chars.
- **Edge producers**: the four staged MemoryGraphEdge types
  (`supersedes`, `contradicts`, `exception_to`, `incompatible_with`)
  now have producers — caller-explicit hints via `raw_payload.*_refs`
  + a rule-based `ConflictDetectionService` with optional LLM hook.
- **PathRelation propose**: `PathRelationProposalService` writes the
  first PathRelation entries once a memory pair has been co-used in
  three separate recall reports (`PATH_RELATION_PROPOSE_THRESHOLD=3`).
- **graph_expansion / path_expansion seeds gated by usage_proof**:
  seeds now require either governance attestation (winnerMemoryIds)
  or an inbound RECALLS edge before they may project their neighbors
  into the candidate pool.
- **Cohort dominance guard**: `session_surface_cohort` is skipped when
  the seed-cohort ratio exceeds 50% of the tier pool.
- **Budget widening**: chat/analyze/build/govern default `max_entries`
  and `max_total_tokens` widened so budget-dropped misses (the
  dominant miss class in v0.3.7) are reduced at delivery.
- **Evidence FTS**: `068-evidence-capsule-fts.sql` plus recall lexical
  plane consults evidence FTS and resolves matches back to owning
  memories via `MemoryEntry.evidence_refs`.

## Non-goals

- No MCP tool name, request schema, or response schema changes (the
  one schema change is additive: `SoulOpenPointerContentSchema` gains
  optional `gist` / `excerpt` fields, never required).
- No protocol zod schema refactor.
- No runtime config schema change.
- Storage migration `068` is the only new SQL; all other ontology
  storage already existed.

## Operator-facing env vars

- `ALAYA_CONFLICT_DETECTION_ENABLED` — `1` / `true` to opt in to the
  rule-based + (optional) LLM `ConflictDetectionService`. Default: off.
  Off-state cost is zero (the service is not instantiated); on-state
  cost is O(workspace_size) per memory materialization.
- `ALAYA_CONFLICT_RULE_ENABLED` — `0` / `false` disables the rule
  path inside `ConflictDetectionService` so the LLM port becomes the
  sole producer. Default: `true`. Has no effect when
  `ALAYA_CONFLICT_DETECTION_ENABLED` is off.
- `ALAYA_CONFLICT_LLM_PROVIDER_URL` — openai-compatible base URL.
  Required to enable LLM pair classifier inside
  ConflictDetectionService.
- `ALAYA_CONFLICT_LLM_API_KEY` — bearer token for the LLM provider.
  Required to enable LLM pair classifier.
- `ALAYA_CONFLICT_LLM_MODEL` — model id. Default `gpt-5.4-mini`.
- `ALAYA_CONFLICT_LLM_TIMEOUT_MS` — request timeout. Default `8000`.
- `ALAYA_PATHREL_COUNTER_TTL_MS` — TTL milliseconds for
  PathRelationProposalService in-process pair counters. Default
  86400000 (24h). Daemon sweeps expired counters once per interval.
- `ALAYA_ENABLE_EMBEDDING_SUPPLEMENT` — `true` enables the recall-time
  embedding supplement slot. Provider config flows through
  `ALAYA_OPENAI_SECRET_REF`, `OPENAI_EMBEDDING_PROVIDER_URL`, and
  `OPENAI_EMBEDDING_MODEL`. For yunwu.ai the recipe is
  `OPENAI_EMBEDDING_PROVIDER_URL=https://yunwu.ai/v1` and
  `OPENAI_EMBEDDING_MODEL=text-embedding-3-small` (1536-d vectors).

When the LLM env vars are not set, conflict detection falls back to
rule-based only (workspace tag-overlap + token-overlap Jaccard
thresholds). When `ALAYA_CONFLICT_DETECTION_ENABLED` is off, neither
the rule path nor the LLM path runs and no contradicts /
incompatible_with edges are produced by the service. Caller-explicit
edge hints via `raw_payload.{supersedes,exception_to,contradicts,
incompatible_with}_refs` are unaffected — they always run in
materialization-router.

## Implementation pointers

- Distillation: `packages/soul/src/garden/materialization-router.ts`
  (`buildDistilledFact`, `ruleDistillFromRaw`).
- Open pointer: `apps/core-daemon/src/mcp-memory-tool-handler.ts`
  (`openPointer`).
- Activation factor: `packages/core/src/dynamics-constants-runtime.ts`.
- Cohort guard / usage_proof seed gate / preview: 
  `packages/core/src/recall-service.ts`,
  `packages/core/src/recall-service-helpers.ts`.
- Budget widening: `packages/core/src/task-surface-builder.ts`.
- Edge producers: `packages/soul/src/garden/materialization-router.ts`
  (caller-explicit) + `packages/core/src/governance/conflict-detection-service.ts`
  (rule-based + optional LLM).
- PathRelation propose: `packages/core/src/path-graph/path-relation-proposal-service.ts`.
- Evidence FTS:
  `packages/storage/src/migrations/068-evidence-capsule-fts.sql`,
  `packages/storage/src/repos/evidence-capsule-repo.ts`,
  `packages/storage/src/repos/memory-entry-repo.ts`
  (`findByEvidenceRefs`).
- Codex-review wiring repair: `packages/core/src/recall-service.ts`
  (cohort + mandatory cap), `packages/core/src/path-graph/path-relation-proposal-service.ts`
  (TTL eviction), `packages/core/src/governance/conflict-detection-service.ts`
  (rule toggle), `packages/eval/src/wilson-ci.ts` (CI helper).
- LoCoMo bench: `apps/bench-runner/src/locomo/` +
  `docs/bench-history/datasets/locomo10.meta.json` (pinned sha256).
- Inspector Memory Browser: `apps/inspector/web/src/pages/MemoryBrowser.tsx`,
  `apps/inspector/web/src/components/CommandPalette.tsx`,
  `apps/inspector/src/routes/memory-entries.ts`.

See [`reports/v0.3.8-closeout.md`](./reports/v0.3.8-closeout.md) for
the implementation summary, bench evidence, and verification commands.
