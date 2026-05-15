# v0.3.8 — Ontology Mid-Layer Recapture (originally v0.4 staged)

## Status

Implementation slice on 2026-05-16. v0.3.8 takes the seven changes that
the v0.1-v0.3.7 implementation explicitly staged as "v0.4 future work"
in `packages/protocol/src/soul/memory-graph.ts`, `path-relation.ts`,
and `evidence-capsule.ts`, and lands all of them in v0.3.x. No new
SQL migrations required for the ontology side (storage tables already
existed); a single FTS migration (`068-evidence-capsule-fts.sql`) was
added for evidence-side lexical search.

## Scope

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
- `ALAYA_CONFLICT_LLM_PROVIDER_URL` — openai-compatible base URL.
  Required to enable LLM pair classifier inside
  ConflictDetectionService.
- `ALAYA_CONFLICT_LLM_API_KEY` — bearer token for the LLM provider.
  Required to enable LLM pair classifier.
- `ALAYA_CONFLICT_LLM_MODEL` — model id. Default `gpt-5.4-mini`.
- `ALAYA_CONFLICT_LLM_TIMEOUT_MS` — request timeout. Default `8000`.

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
  (caller-explicit) + `packages/core/src/conflict-detection-service.ts`
  (rule-based + optional LLM).
- PathRelation propose: `packages/core/src/path-relation-proposal-service.ts`.
- Evidence FTS:
  `packages/storage/src/migrations/068-evidence-capsule-fts.sql`,
  `packages/storage/src/repos/evidence-capsule-repo.ts`,
  `packages/storage/src/repos/memory-entry-repo.ts`
  (`findByEvidenceRefs`).

See [`reports/v0.3.8-closeout.md`](./reports/v0.3.8-closeout.md) for
the implementation summary, bench evidence, and verification commands.
