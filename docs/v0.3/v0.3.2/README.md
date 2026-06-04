# v0.3.2 Patch — Internal Memory Quality

v0.3.2 closes the read/write integrated memory-quality work as a
patch-internal release. It adapts two current research directions to
Alaya's existing ontology and governance model:

- **Decouple before aggregation.** Inspired by xMemory's retrieval
  argument, Alaya should isolate reusable facts, updates, and
  distinguishing evidence before grouping or summarizing them.
- **Schema-grounded write path.** Reliable factual memory should move
  interpretation pressure from recall-time inference to write-time
  extraction, validation, and governance.

These ideas must not bypass Alaya's invariant that LLMs and connected
agents propose while Alaya decides. Garden output remains candidate
signal input until governance accepts it.

## Version Boundary

v0.3.2 remained patch-internal. It did not touch:

- MCP tool names, descriptions, request schemas, or response schemas;
- EventLog payload schemas;
- runtime control-plane config schemas;
- storage migrations.

The schema-aware extraction metadata lives inside the existing
`CandidateMemorySignal.raw_payload` JSON object. If a later release
promotes any of that internal convention to MCP, EventLog, config, or
protocol schema, that future work must cite invariant §25 and rerun the
SemVer snapshot path.

## Slices

| Slice | Card | Size | Prereq | Status |
|---|---|---:|---|---|
| 1 | Recall evidence-pack baseline | M | v0.3.1 closeout | done |
| 2 | Schema-aware Garden extraction contract | M | slice 1 | done |
| 3 | Proposal validation and no-silent-write hardening | M | slice 2 | done |
| 4 | Read/write integration evaluation fixtures | M | slices 1-3 | done |
| 5 | Closeout and SemVer decision | S | slices 1-4 | done |

## Slice 1 — Recall Evidence-Pack Baseline

### Scope

- Define an internal evidence-pack model for recall evaluation:
  selected memory object ids, source channels, score factors, evidence
  pointers, token estimate, and whether the delivered item was later
  reported as used.
- Add deterministic fixtures for exact fact lookup, current-state
  update, negative query, relation query, broad thematic recall, and
  Chinese preference / constraint recall.
- Measure evidence density and redundancy before any write-path change.

### Acceptance

- `packages/core/src/recall-evidence-pack.ts` builds internal evidence
  packs from `RecallService` results or daemon-shaped recall results.
- `recall-evidence-pack.test.ts` runs deterministic fixtures for the
  exact/current/negative/relation/theme/Chinese cases.
- Metrics stay fixture-level: selected count, expected-hit coverage,
  evidence density, redundancy, and token footprint.

## Slice 2 — Schema-Aware Garden Extraction Contract

### Scope

- Design the extraction pipeline as object detection -> field detection
  -> field-value extraction -> validation -> candidate signal.
- Keep the durable boundary unchanged: extracted values are candidate
  signals, not memory entries.
- Add validation gates for fields that must never be inferred.

### Acceptance

- `packages/soul/src/garden/schema-grounding.ts` owns the internal
  raw-payload convention:
  `schema_grounding`, `detected_object`, `field_candidates`, and
  `validation_result`.
- `LocalHeuristics`, `OfficialApiGardenProvider`, daemon
  `POST_TURN_EXTRACT`, and host-worker `garden.complete_task` inputs all
  normalize candidate signals through that helper.
- Invalid / incomplete schema-grounded signals are marked deferred by
  validation and cannot silently become memory entries.

## Slice 3 — Proposal Validation And No-Silent-Write Hardening

### Scope

- Tighten proposal validation for schema-aware candidate signals.
- Ensure every accepted write remains EventLog-first and audit-before-
  broadcast.
- Preserve trust-state attribution from recall delivery through usage
  report into any later path-plasticity or extraction side effect.

### Acceptance

- `SignalService` defers invalid schema-grounded signals before
  post-triage materialization can run.
- `MaterializationRouter` rechecks schema-grounded signals and routes
  invalid field/value payloads to `deferred`, creating no memory or
  claim objects.
- Existing proposal/storage retry, stale-baseline, out-of-scope anchor,
  and workspace-scope tests stay green.

## Slice 4 — Read/Write Integration Evaluation Fixtures

### Scope

- Compare baseline recall against schema-aware write-path output on the
  same fixture set.
- Report separately:
  latency, token footprint, object-level extraction accuracy, factual
  answer accuracy, redundancy, and evidence coverage.

### Acceptance

- `memory-quality-fixtures.test.ts` compares baseline recall with the
  schema-aware candidate-signal write path on the same fixture set.
- The integration fixture covers exact fact, current state, negative
  query, relation query, broad thematic recall, and Chinese
  preference/constraint recall.
- No quality claim is made beyond the recorded fixture evidence.
- Embedding remains recall supplement only.
- No model-generated control-plane hint becomes durable truth.

## Slice 5 — Closeout And SemVer Decision

### Scope

- Decide whether v0.3.2 remained patch-internal or must be promoted to a
  minor release based on actual changed public surfaces.
- Update release notes, runtime status, code map, and closeout report
  only after implementation evidence exists.

### Closeout

Closeout result (2026-05-13): v0.3.2 closed as a patch-internal memory
quality release. Workspace packages were bumped `0.3.1` -> `0.3.2`.
See `release-notes.md` and `reports/v0.3.2-closeout.md`.

### Required Verification

```bash
rtk pnpm exec vitest run --project @do-soul/alaya-core -- recall-evidence-pack signal-service
rtk pnpm exec vitest run --project @do-soul/alaya-soul -- schema-grounding garden-extraction-golden garden-extraction-parser-parity local-heuristics materialization-router
rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -- memory-quality-fixtures post-turn-extract-task garden-mcp-tools mcp-memory-tool-handler agent-use-protocol trustworthy-loop-trace
rtk pnpm exec vitest run --project @do-soul/alaya-storage -- signal-repo proposal-repo memory-entry-repo
rtk pnpm build
rtk pnpm test
rtk pnpm run hygiene:unused
rtk git diff --check
```
