# v0.3.7 No-Embedding Dynamic Recall Design Notes

## Status

Implemented in the v0.3.7 dynamic recall follow-up. This document now
serves as both the original design rationale and the implementation map.
No MCP/protocol/EventLog/runtime-config schema or SQLite migration was
changed.

This note records the v0.3.7 direction after the initial benchmark and
Inspector repair slice: no-embedding recall is a core capability, not a
secondary fallback behind embedding models. Embedding-backed runs remain
important for provider stability and comparison, but the v0.3.7 design
work must first explain how Alaya recalls useful memory when no model is
available.

## Scope Lock

- Do not change MCP tool names, request schema, or response schema.
- Do not change protocol zod schemas, EventLog payload schemas, runtime
  config schemas, or SQLite migrations while this remains a design note.
- Do not add durable ontology fields before proving the existing object,
  graph, and path structures cannot support the repair.
- Treat keyword/FTS as one evidence channel only. It must not become the
  main definition of no-embedding recall quality.

## Current Code Truth

`MemoryEntry` already carries more recall signal than raw text. The
object itself includes `dimension`, `source_kind`, `formation_kind`,
`scope_class`, `domain_tags`, `evidence_refs`, `workspace_id`, `run_id`,
`surface_id`, `storage_tier`, `activation_score`, `retention_score`,
`confidence`, usage timestamps/counters, and `superseded_by`
(`packages/protocol/src/soul/memory-entry.ts`).

`PathRelation` is also already recall-relevant. Its anchors can point at
objects, object facets, obligations, risk concerns, or time concerns; its
effect vector includes `recall_bias`; its plasticity state includes
`strength`, `direction_bias`, and `stability_class`
(`packages/protocol/src/soul/path-relation.ts`).

The original MCP recall policy was narrow: for `max_results=N`, the
coarse activation window was `N * 5`, and keyword supplement size was
only `ceil(N / 2)`. v0.3.7 changes that internal policy derivation to a
wider read-side candidate window (`maxResults * 10`, capped at 1000)
without exposing a new public policy field
(`apps/core-daemon/src/mcp-memory-tool-handler.ts`).

The original core recall flow built candidates from tier memories,
deterministic filters, activation rank, and a small keyword supplement.
v0.3.7 replaces that with an internal union builder: activation,
protected/winner governance, object probes, evidence anchors, domain tag
clusters, temporal proximity, session/surface cohorts, memory-graph
one-hop expansion, PathRelation expansion, and lexical evidence all
admit candidates before scoring (`packages/core/src/recall-service.ts`).

The path read side can look up active path relations by anchor and can
compute strength for already-selected memory ids. v0.3.7 additionally
uses existing PathRelation anchor reads to pull direction-eligible
opposite-side object anchors into the recall pool. It does not create
paths or durable relations during recall
(`packages/storage/src/repos/path-relation-repo.ts`,
`apps/core-daemon/src/path-plasticity-runtime.ts`).

## Working Diagnosis

The likely failure is not "keyword ranking is weak" in isolation. The
larger failure is candidate generation:

- Query evidence is not compiled into object/path probes before recall.
- Path and graph structure mostly affect scores after candidates are
  already admitted.
- The candidate pool can be narrowed before structural support has a
  chance to bring related memories into competition.
- The final delivery budget can be confused with the pre-scoring search
  budget.
- Benchmark output does not yet explain whether a gold memory was absent
  from the candidate pool, present but under-ranked, or dropped by a
  budget/diversity decision.

In practical terms, no-embedding recall currently asks too much of the
first ranked window. If the relevant memory is not protected, already
high-activation, or captured by a tiny lexical supplement, the later
graph/path/dynamic scoring layers never get to help it. That is the
wrong shape for Alaya because Alaya's durable objects are already more
structured than plain text snippets.

The same narrowness applies to env-embedding mode. The embedding
supplement passes `eligibleMemories = hotCoarseFilter.candidates`, so
cosine similarity can only re-rank objects already admitted to the HOT
coarse pool; it cannot rescue a missing gold memory either. Slice C is
therefore a prerequisite for both the no-embedding track and the
env-embedding track: candidate generation widens first, then the
embedding plane and the path/graph planes attach scores to the same
expanded pool.

## Root-Cause Hypotheses

The implementation work should prove or refute these hypotheses with
benchmark diagnostics:

1. Candidate-absent misses dominate: many gold memories are not in the
   pre-budget candidate pool at all.
2. Structural-underuse misses are common: a related memory, path, graph
   edge, evidence ref, run, or surface exists, but recall only uses it
   after the target is already admitted.
3. Budget-dropped misses are hidden: the gold memory can be found in a
   wider internal pool but is dropped before final delivery.
4. Lexical-only misses are expected: questions and memory content often
   use different phrasing or language, so text overlap is an unreliable
   primary signal.
5. Dynamic-state misses exist: path plasticity, graph support, recent
   use, and governance signals are not strong enough when embedding is
   disabled.

## Dynamic No-Embedding Strategy

The proposed direction is deterministic dynamic recall, not static
keyword recall.

### 1. Query Compilation

Compile the user query into typed probes without an LLM:

- time probes: dates, relative windows, explicit session/run hints;
- object probes: memory ids, evidence refs, path-like strings, filenames,
  command names, issue/card ids, package names;
- ontology probes: likely dimensions, scope class hints, domain tags,
  risk/obligation/time concern hints;
- lexical probes: Unicode token/character n-grams and phrase spans, used
  as weak evidence rather than the primary ranker;
- intent probes: whether the query asks for a decision, preference,
  procedure, hazard, prior fact, or unresolved issue.

The important point is that multilingual recall should lean on object
and path structure where possible. Lexical matching can help seed the
search, but it cannot be the only bridge across languages or phrasing.

### 2. Multi-Plane Candidate Generation

Build candidates as a union of planes:

- object plane: activation, retention, storage tier, dimension, scope,
  domain tags, evidence refs, run/surface/time filters;
- path plane: relations anchored on seed memories or query-derived
  anchors, respecting direction, strength, lifecycle, legitimacy, and
  `effect_vector.recall_bias`;
- graph plane: one-hop memory graph neighbors with edge-type weights;
- governance plane: protected dimensions, slot winners, supersession
  relationships, and conflict-aware candidates;
- lexical plane: FTS/chargram/text evidence, capped and clearly labeled.

This is the main change in shape: path/graph should become candidate
generators, not only score support.

### 3. Dynamic Expansion Loop

Use a bounded read-side expansion loop:

1. Seed from protected/winner memories, deterministic filters, activation
   top, and query probes.
2. Expand via memory graph edges and PathRelation anchors.
3. Re-score the enlarged pool with structural evidence attached.
4. Apply final budget and diversity only after scoring.

The loop must be capped by fan-out, candidate count, and time budget. It
must not write new paths or durable relations during recall.

### 4. Scoring Model

No-embedding scoring should combine evidence channels:

- activation/retention/freshness remain baseline object dynamics;
- object match signals cover dimension, scope, domain, evidence, run,
  surface, and time;
- graph/path support gets stronger weight when embedding is disabled;
- path `strength`, `direction_bias`, `stability_class`, legitimacy, and
  `recall_bias` become first-class rank features;
- lexical relevance remains an evidence channel, not the rank contract;
- protected/winner/governance rules keep precedence over ordinary rank;
- conflict/supersession penalties remain explicit.

The result should expose enough diagnostics to explain why a memory won,
lost, or was dropped.

## Implementation Plan For Review

The plan is split by recall stage. Each stage should be benchmarked
before moving on when feasible; the point is to find which stage unlocks
the quality gain, not to ship one large opaque rewrite.

### Slice A: Diagnostic Harness First

Goal: make every benchmark miss classifiable before tuning recall.

Changes to plan:

- Extend LongMemEval output with an additive diagnostic sidecar.
- Record per question: gold memory ids, whether any gold id entered the
  internal pool, source plane(s), structural expansion sources,
  pre-budget rank, final rank, budget/drop reason, degradation reason,
  and embedding/provider mode.
- Do not store raw memory text, raw user turns, provider keys, or secret
  refs.
- Keep KPI schema stable; sidecar is additive evidence.

Expected result:

- A 100-question disabled run should classify misses into
  `candidate_absent`, `under_ranked`, `budget_dropped`,
  `structural_gap`, and `lexical_gap`.
- An env-embedding run additionally classifies provider status as
  `provider_returned`, `provider_pending`, or `provider_failed` per
  query — consumed by Slice G's dual-track KPI.
- If the sidecar shows most misses are candidate-absent, continue to
  Slice B/C before scoring changes.

### Slice B: Query Probe Compiler

Goal: turn a user query into structured probes without an LLM.

Implementation shape:

- Add an internal query compiler in core or daemon-owned recall support.
- Produce a typed query evidence object for internal use only; do not add
  a public protocol field.
- Extract:
  - dates and time windows;
  - object ids, evidence refs, path-like strings, command names, package
    names, task/card ids, and file paths;
  - likely dimensions such as preference, procedure, decision, hazard,
    fact, or episode;
  - likely scope/domain tags where deterministic local rules are safe;
  - Unicode lexical spans and character n-grams as weak evidence.
- Preserve multilingual support by treating Unicode spans and structural
  markers as first-class inputs instead of relying on English stopwords.

Expected result:

- The compiler can explain which probes it emitted for each benchmark
  query.
- Probe extraction is deterministic and has no provider dependency.

### Slice C: Multi-Plane Candidate Generation

Goal: make objects, graph edges, and paths able to pull memories into
the pool.

Implementation shape:

- Replace the current single coarse candidate path with a candidate
  union builder.
- Candidate planes (ordered: activation → content-derived structural →
  usage-derived structural → lexical):
  - activation plane: existing protected + activation-ranked memories;
  - object plane: dimension/scope/domain/evidence/run/surface/time
    matches from query probes;
  - content-derived structural planes — available at seed time, no usage
    history required, the load-bearing channels on a single-turn bench:
    - evidence_anchor plane: objects sharing `evidence_refs` with seed
      memories or query-derived evidence probes;
    - domain_tag_cluster plane: objects sharing one or more
      `domain_tags` with seed memories or probe-emitted tags;
    - temporal_proximity plane: objects whose `created_at` falls inside
      an episodic window around the query (when the query carries a
      time probe) or around the seed cohort;
    - session_surface_cohort plane: objects from the same `run_id` /
      `surface_id` cohort, weighted by cohort recency;
  - graph plane: bounded one-hop memory graph neighbors from seed
    candidates. NOTE: empty until usage produces RECALLS edges — relies
    on Slice E weighting and Slice C-multi/live evidence to prove value;
  - path plane: PathRelation anchors and opposite-side object anchors,
    respecting lifecycle, direction, strength, stability, legitimacy,
    and `effect_vector.recall_bias`. NOTE: empty on a fresh per-question
    workspace — relies on Slice E and Slice C-multi/live to develop;
  - lexical plane: FTS/chargram candidates as weak evidence.
- Keep each candidate's provenance: `activation`, `object_probe`,
  `evidence_anchor`, `domain_tag_cluster`, `temporal_proximity`,
  `session_surface_cohort`, `graph_expansion`, `path_expansion`, or
  `lexical`. Sidecar records both `plane_first_admitted` and
  `plane_winning_admission` per gold memory.
- Apply fan-out and count caps per plane. The initial default should
  favor recall quality over latency during benchmark diagnosis, then tune
  down after evidence.

Expected result:

- A memory can enter the candidate pool because it is structurally close
  to a seed memory, not only because it has high activation or text
  overlap.
- On the single-turn LongMemEval harness, content-derived structural
  planes (evidence_anchor / domain_tag_cluster / temporal_proximity /
  session_surface_cohort) carry the structural verdict; PathRelation
  and graph planes are observed-but-not-load-bearing.
- Sidecar can show the plane that first admitted each gold memory and
  the plane it eventually won (or lost) from.

### Slice C-multi: Multi-Turn Bench Harness Variant

Goal: expose PathRelation / RECALLS-edge / plasticity effects on
LongMemEval material, so Slice E has a verification surface that does
not depend on `alaya-live` traces.

Implementation shape:

- Reuse LongMemEval-S question text and seed flow, but run inside a
  single workspace per question for `N` rounds (default `N = 3`).
- Each round: `soul.recall` → score → `soul.report_context_usage` with
  `usage_status = used` on the gold pointer (when present in the
  delivered set). The RECALLS cross-link side-effect already exists in
  `apps/core-daemon/src/mcp-memory-tool-handler.ts:1139 crossLinkRecalledMemories`
  and feeds path-plasticity development.
- KPI extensions: `r_at_5_round_1`, `r_at_5_round_2`, `r_at_5_round_N`;
  `plasticity_strength_p50/p95`; `recalls_edge_density`.
- Persist as a separate archive under
  `docs/bench-history/public-multiturn/<slug>/` with its own
  `latest-baseline.json` and its own threshold table — single-turn
  numbers do not compare to multi-turn numbers and must not pollute the
  same trend line.
- Inspector trend view should render `public-multiturn` alongside
  `public` and `live` once the first baseline is committed.

Expected result:

- Round-curve KPIs show whether usage-derived structural signals are
  measurable on LongMemEval material at all.
- Provides the load-bearing evidence for Slice E weighting decisions;
  without this surface, all PathRelation / plasticity weight tuning
  would have to be done blind or live-only.

### Slice D: Score After Expansion, Budget At Delivery

Goal: stop final delivery limits from hiding relevant candidates before
they compete.

Implementation shape:

- Separate internal scoring pool size from final `max_results`.
- Score the full expanded pool first.
- Rebuild budget state after ranking.
- Slice final delivery only at the MCP handler/result boundary.
- Keep protected and slot-winner behavior privileged.
- Preserve token and entry budget diagnostics so over-budget candidates
  can be explained rather than silently disappearing.

Expected result:

- `max_results=10` no longer means "only 10 candidates can meaningfully
  compete."
- Benchmark sidecar can distinguish `under_ranked` from
  `budget_dropped`.

### Slice E: No-Embedding Dynamic Scoring

Goal: make structural evidence stronger when no embedding supplement is
available.

Implementation shape:

- Add internal scoring features for:
  - object probe match;
  - path strength, direction eligibility, stability, legitimacy, and
    recall bias;
  - graph edge type and weighted support;
  - recent usage and successful prior recall usage;
  - lexical evidence as one weak channel;
  - conflict and supersession penalties.
- Use a no-embedding scoring profile that reallocates semantic-supplement
  weight toward object/path/graph evidence.
- Avoid making path plasticity alone overpower strong conflicting object
  or governance evidence.

Verification — three tracks, not one:

- Single-turn LongMemEval-S (Slice F bench): PathRelation / plasticity
  signal is near-zero here. The acceptance bar is **no regression**
  against the same run without Slice E enabled. Quality gain on this
  surface is expected to come from Slice C content-derived planes, not
  from this slice.
- Multi-turn (Slice C-multi `docs/bench-history/public-multiturn/`):
  R@5 at round 3 must beat R@5 at round 1 by a measurable margin, and
  plasticity_strength_p50 must rise across rounds. This is the
  load-bearing verification for Slice E weight tuning.
- live/strict-real (`docs/bench-history/live/`): Inspector trend line
  shows PathRelation density and plasticity behavior on real attached-
  agent sessions. Not a hard gate; advisory direction only.

Expected result:

- Structurally connected candidates can outrank high-activation but
  unrelated candidates **once usage history exists**.
- The score factors remain explainable in diagnostics.
- Single-turn bench shows no regression; multi-turn bench shows a
  measurable round-curve improvement.

### Slice F: Benchmark-Driven Iteration

Goal: use benchmark runs as the primary quality test, not as a final
afterthought.

Run sequence:

1. Disabled 100 baseline with sidecar.
2. Implement one candidate-generation slice.
3. Disabled 100 comparison; classify changed misses and regressions.
4. Continue only if the sidecar shows the next bottleneck.
5. Disabled 500 full run once the 100-question stage clears the target.
6. Multi-turn 100 baseline (Slice C-multi) once Slice C lands; full
   multi-turn run only after the round curve is stable across two
   consecutive harness changes.
7. Env-embedding staged run for provider stability (gated by Slice G,
   not by no-embedding quality).

Release floor:

- Disabled/no-embedding LongMemEval-S 500 must beat the v0.3.6 60.2%
  R@5 baseline.
- Target floor remains R@5 >= 65% for full disabled 500.
- Disabled 100 should reach a higher stage target before a full run is
  trusted; current planning target is R@5 >= 70%.
- Multi-turn variant carries its own threshold table (not yet defined —
  see Open Design Questions); does not gate the single-turn release.
- If direct benchmark evidence shows a different bottleneck than this
  document predicts, update the plan before implementation continues.

Current v0.3.7 evidence:

- The earlier disabled-100 archive at
  `docs/bench-history/public/2026-05-15T100511Z-af4a721/` reported
  R@1 = 49.0%, R@5 = 70.0%, R@10 = 73.0%, p95 = 127ms with sidecar
  classification 70 `hit_at_5` / 2 `under_ranked` / 22 `budget_dropped`
  / 6 `candidate_absent`. **That run included
  LongMemEval-question-shape heuristics in `packages/core` that were
  later removed**; its R@5 is retracted as a current-code claim and is
  recorded here only as a historical sidecar reference.
- Honest-baseline disabled-100 (heuristic-removed build) and the first
  `public-multiturn` round-curve are produced by Phase A and Phase B
  of the follow-up plan
  (`/home/tdwhere/.claude/plans/500-100-500-federated-sundae.md`).
  Results will be linked from
  `docs/v0.3/v0.3.7/reports/v0.3.7-closeout.md` once those runs land.
- Interpretation: v0.3.7's evidence chain (sidecar, miss
  classification, plane provenance) is in place; the no-embedding
  ranking work continues on top of an honest baseline rather than a
  heuristic-inflated one. FTS rank is kept separate from
  structural/content evidence as a permanent architectural invariant,
  not a one-off heuristic.

### Slice G: Embedding-Mode Engineering Stability

Goal: separate "embedding provider failed" from "no-embedding quality
regression" with explicit numbers, so env-embedding runs become a
reliable comparison surface instead of a noisy theatre.

Scope:

- Stability is engineering work (timeouts, sharding, telemetry,
  provider matrix). It is not algorithm work. Slice G does not change
  recall-ranking and does not depend on Slices C/D/E landing first.

Implementation shape:

- Provider-state telemetry — three rates per env-embedding run, emitted
  through the Slice A sidecar (no new event log surface):
  - `provider_returned_rate`: fraction of recalls where the embedding
    provider produced a vector inside the recall window;
  - `provider_pending_rate`: fraction degraded with
    `query_embedding_pending` (timeout window expired without a result);
  - `provider_failed_rate`: fraction degraded with
    `query_embedding_failed`, `provider_unavailable`, or
    `local_vector_lookup_failed`.
- KPI dual-track in `kpi.json` for env-embedding runs:
  - `r_at_5_overall` — current KPI semantics; includes silently-degraded
    queries;
  - `r_at_5_with_embedding_returned` — restricted to the
    `provider_returned` subset. This is the honest "embedding actually
    helped recall" number and the only one that should be compared
    against the no-embedding R@5.
- Shard runner single-daemon contract — encode the existing anchor at
  `apps/bench-runner/src/longmemeval/runner.ts:188 longmemeval-sequential`
  as a vitest case: starting a second `startBenchDaemon` in the same
  process must throw or no-op. Today the constraint lives only as a
  comment plus the `run-full-public-bench.sh` shard wrapper; the test
  prevents an accidental concurrent-daemon regression.
- Timeout contract — document
  `embedding-recall-service.ts:DEFAULT_QUERY_TIMEOUT_MS = 2500` as the
  bench/runtime SLA. Changes to this value require an explicit
  before/after `provider_pending_rate` comparison in the PR; lowering
  it for production must not regress bench stability.
- Recall-window wait policy — when `preparedQuery.getSnapshot()` is
  `pending` at merge time, `querySupplementIfReady` already awaits
  `waitForSnapshot(queryTimeoutMs)`. Plan does not extend the window
  further; instead, runs that exceed the budget are surfaced as
  `provider_pending` in sidecar rather than hidden as silent
  no-embedding fallbacks.

Provider matrix for v0.3.7 ship:

- **Yunwu (`yunwu.ai`) — named ship target.** Provider URL via
  `OPENAI_EMBEDDING_PROVIDER_URL`, model defaults to
  `text-embedding-3-small`, key file at
  `~/.config/alaya/secrets/official-garden` (existing local convention,
  see `project_local_alaya_env` in memory). Bench-time env wiring is
  `set -a; . .do-it/bench-env/alaya-api.env; set +a`; the env file is
  not checked in.
- OpenAI official and other openai-compatible providers remain
  supported by code (`embedding-recall-service.ts:631 OpenAIEmbeddingClient`)
  but are out of scope for the v0.3.7 stability contract — their
  numbers are operator-visible but not gated.

Expected result:

- An env-embedding LongMemEval-S 500 run produces both
  `r_at_5_overall` and `r_at_5_with_embedding_returned`, plus the three
  provider-state rates.
- A regression in either `provider_pending_rate` or
  `provider_failed_rate` is detectable in `findings.md` independent of
  recall quality.
- The shard-runner contract is enforced by a test, not just by a
  comment.

## Path Map

```text
MCP soul.recall request
-> daemon internal recall policy/window derivation
-> query probe compiler (Slice B)
-> multi-plane candidate union builder (Slice C)
   activation
   + object_probe
   + evidence_anchor / domain_tag_cluster / temporal_proximity /
     session_surface_cohort      [content-derived, no-history-required]
   + graph_expansion / path_expansion   [usage-history-dependent]
   + lexical
-> evidence attachment (graph support, path strength, plasticity)
-> embedding similarity hint (env mode only — re-rank, no new admissions)
-> expanded-pool scoring (Slice D)
-> budget/drop annotation
-> MCP delivery slice
-> LongMemEval KPI + diagnostic sidecar (Slice A)
   single-turn  -> docs/bench-history/public/
   multi-turn   -> docs/bench-history/public-multiturn/      (Slice C-multi)
   live trace   -> docs/bench-history/live/                  (advisory)
   env-embedding -> dual-track KPI + provider state rates    (Slice G)
```

## Failure-Mode Forecast

- candidate explosion: graph/path/content-cluster expansion can add too
  many memories; mitigate with per-plane caps and sidecar counts.
- false structural proximity: a path or content cluster can be nearby
  but irrelevant; mitigate by direction, lifecycle, legitimacy,
  recall_bias, plane provenance, and score explainability.
- lexical regression: improving structure must not break exact lookup;
  keep lexical plane and direct object probes.
- benchmark overfitting: optimize by miss class, not by hand-picking
  question strings.
- multi-turn artifact: a too-aggressive RECALLS cross-link cap or
  plasticity bump could make round 2/3 trivially boost the gold; verify
  Slice C-multi rounds use the production code path, not a test-only
  shortcut.
- provider-state masking: hiding `provider_pending` / `provider_failed`
  inside `r_at_5_overall` makes env-embedding regressions invisible;
  Slice G's dual KPI exists specifically to prevent this.
- contract drift: keep all new policy/probe/diagnostic structures
  internal or additive sidecars until a later version explicitly changes
  public surfaces.

## Confirmed Test And Benchmark Work

These test/benchmark repairs are confirmed for v0.3.7 even while the
exact no-embedding algorithm is still being designed:

- Add a LongMemEval diagnostic sidecar that records, without raw memory
  text or secrets: gold memory presence, candidate-pool status, lexical
  rank when available, structural expansion sources, pre-budget rank,
  final rank, budget drop reason, and embedding/provider status.
- Run staged LongMemEval-S disabled/no-embedding diagnosis before full
  release runs. The small stage classifies misses; the full stage proves
  the final floor.
- Build the multi-turn variant harness (Slice C-multi) once Slice C
  candidate planes are in place; persist results under
  `docs/bench-history/public-multiturn/` with its own
  `latest-baseline.json`.
- Wire env-embedding stability per Slice G: dual-track KPI in
  `kpi.json`, three provider-state rates in the sidecar, a vitest case
  that enforces the shard-runner single-daemon contract, and a
  documented timeout SLA. Provider failures are reported as
  provider-blocked and must not be mixed into no-embedding quality
  numbers.
- Add targeted tests for path/graph read-side expansion, candidate
  generation before budget, final delivery slicing after scoring,
  multilingual/non-English query probes, secret-free benchmark
  sidecars, multi-turn round-curve recording, and concurrent-daemon
  rejection in the bench runner.

The main quality verdict should come from direct benchmark runs. Unit
tests are still useful to lock contracts and prevent obvious regressions,
but they do not prove no-embedding recall quality by themselves.

## Open Design Questions

The main unresolved design question is no longer whether no-embedding
recall matters. That is settled for v0.3.7. The remaining questions:

- **Recall-local vs durable ontology boundary.** Where to draw the line
  between recall-local dynamic expansion and durable ontology evolution.
  The recommended v0.3.7 answer is conservative: implement read-side
  dynamic expansion first, using existing MemoryEntry, memory graph, and
  PathRelation structures. Escalate to ontology or migration work only
  if diagnostics prove the existing structures cannot represent the
  missing evidence.
- **Multi-turn threshold baseline.** PathRelation density develops only
  with usage history, so single-turn LongMemEval thresholds cannot be
  reused for the Slice C-multi archive at
  `docs/bench-history/public-multiturn/`. Whether that archive needs its
  own entries in `packages/eval/src/thresholds.ts`, or whether a
  separate `MultiTurnThresholdTable` should live next to it, is open —
  decide before the first multi-turn baseline is committed.

## Acceptance Direction

The design should be considered ready for implementation only when the
next plan can name:

- the exact candidate-generation stages;
- the score factors each stage contributes;
- the diagnostics emitted for each LongMemEval question — at minimum
  the following grep-stable sidecar fields:
  - miss classification: `candidate_absent`, `under_ranked`,
    `budget_dropped`, `structural_gap`, `lexical_gap`;
  - provider status (env-embedding only): `provider_returned`,
    `provider_pending`, `provider_failed`;
  - admission provenance: `plane_first_admitted`,
    `plane_winning_admission`, drawn from the Slice C plane set
    (`activation` / `object_probe` / `evidence_anchor` /
    `domain_tag_cluster` / `temporal_proximity` /
    `session_surface_cohort` / `graph_expansion` / `path_expansion` /
    `lexical`);
- the no-embedding benchmark gates (single-turn floors + multi-turn
  threshold-table decision per Open Design Questions);
- the code paths that stay untouched to preserve public contracts.

## Approval Checkpoint Outcome

The implementation followed the approved order: diagnostic sidecar first,
then deterministic query probes, candidate union, scoring, daemon wiring,
and benchmark/Inspector reporting. The tracked implementation summary is
`reports/v0.3.7-closeout.md`.
