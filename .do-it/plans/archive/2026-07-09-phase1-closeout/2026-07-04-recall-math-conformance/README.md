# Recall 全生命周期算法一致性计划（2026-07-04）

> Supersedes: `.do-it/plans/archive/2026-07-04-legacy-main-current/recall-core-optimization-complete-2026-07-02.md`
> Source of truth: current `main` checkout plus the live files in this directory.
> Execution cards: `tasks.md`.

## 0. Card Metadata

| Field | Value |
| --- | --- |
| Card ID | `2026-07-04-recall-math-conformance` |
| Tier | Heavy |
| Size | Multi-slice, cross-package |
| Target | Rewrite recall from stale linear-axis tuning into one integrated lifecycle algorithm plan |
| Owner | Next implementation agent / phase controller |
| Primary surfaces | `packages/core`, `apps/core-daemon`, `apps/bench-runner`, `.do-it/bench-runs` |
| Verification gate | `rtk pnpm build`, targeted `rtk pnpm exec vitest run`, review protocol, cache-only LongMemEval-S recall proof |

## 1. Goal

The goal is not to add another ranking branch beside RRF. The goal is a single recall model where:

- `R_obj` is the object relevance base, cold-start fallback, and seed ignition.
- Flood / path potential is a verified-fuel refinement over that base, not an RRF replacement.
- Evidence is support depth, not another additive stream.
- Governance is boundary, cap, and down-weighting, not a reward term.
- Temporal signal belongs in time/facet slicing and decay, not `+T` scoring.

Target shape:

```text
cold start:
  S(o) = R_obj(o)

warm / fuel-present:
  S(o) = omega(o) * [ R_obj(o) + lambda * Flood(q,o) ] * [ 1 + beta * E_direct(o) ]

Flood(q,o) = Slice(q,o) * A_path(q,o) * B_evidence(o), with governance caps
```

`R_obj` remains the proven base. Flood is integrated into the same model as a bounded, facet-conditioned refinement. Do not build a long-lived "RRF vs flood" parallel scaffold.

## 2. Confirmed Decisions

| Decision | Locked Result |
| --- | --- |
| Plan boundary | Full memory lifecycle: extraction/cache, materialization, fuel derivation, recall, delivery, usage feedback, retention/governance, benchmark proof |
| Algorithm mainline | Flood-potential mainline; layered gating is only the production compatibility shell |
| Cold start | If verified fuel is absent, fall back to `R_obj`; path/evidence/governance report `inactive:no_fuel` diagnostics |
| DeepSeek cache | Reuse the existing cache as benchmark/warm-substrate input; do not re-extract or add online LLM calls |
| Missing fuel | Prefer deterministic derivation from cached/materialized substrate; do not introduce a new online LLM dependency |
| Integration style | Single model integration; no long-term compatibility branch or patch-style bypass |
| Embedding parity | Align benchmark and production resolved policy to embedding fusion weight 12 |
| Bench/MCP parity | Move toward one shared recall execution core; side effects must be explicit modes |
| Feedback lifecycle | Include real gaps: retention scanner/consumption, `superseded_by` source, accept/reject karma |
| Benchmark gate | LongMemEval-S recall-only, cache-only, no chat, no QA, no live reconciliation |
| Plan file shape | Rewrite only this `README.md` and `tasks.md` |

## 3. Current Truth And Stale Items

The old plan text mixed live issues with stale findings. The next implementer must verify again before editing, but the current planning baseline is:

- The DeepSeek extraction cache exists at `.do-it/bench-runs/seeds/longmemeval-s-extraction-cache/deepseek-v4-flash-nonthinking/cache`.
- Its manifest reports `coverage=1`, `cached_turns=96084`, model `deepseek-v4-flash`, and a pinned `system_prompt_sha256`.
- Cache hits return raw DeepSeek `raw_json`; the credentialed compile path feeds those signals through the production parser and daemon `signalService.receiveSignal` with `source=garden_compile`.
- The cache proves extraction reuse only. It does not automatically prove `answers_with`, facet-conditioned path fuel, or query-orthogonal evidence support exists.
- The current code still contains the old additive fused-score shape (`R_obj + path + evidence + temporal + control`) and evidence beta defaults that need review before implementation.
- The "karma lost-update", temporal interval swap, and final `fused_rank` comparison findings are stale on current `main`; do not keep them as execution tasks unless re-verified as live bugs.
- `scanRetentionDecay` and lifecycle feedback need live wiring review; do not assume `retention_score` should be read directly by recall without checking the existing activation path.

## 4. Interface And Architecture Rules

- `packages/protocol` remains the zod-only leaf; public schema changes require SemVer review under handbook invariant §25.
- `packages/core` owns recall behavior and lifecycle transitions.
- `apps/core-daemon` owns runtime wiring, MCP handlers, and side-effect modes.
- `apps/bench-runner` must not silently diverge from production recall policy or handler semantics.
- EventLog-first and audit-before-broadcast remain mandatory for durable state changes.
- Embeddings are recall supplements only; embedding weight 12 is a ranking/base-policy decision, not durable truth.
- No source file over 500 lines and no function over 50 lines after new logic lands; extract before adding to large units.

## 5. Failure-Mode Forecast

| Class | Risk | Required prevention |
| --- | --- | --- |
| Live-path gap | Bench and MCP may exercise different policy/handler paths | Shared execution core or explicit parity test before KPI claims |
| Contract drift | Policy defaults, diagnostics, or schema fields may diverge across packages | Interface drill before public/additive schema or config changes |
| Synthetic proof | Unit tests can mock away materialization or side effects | At least one integration seam for each live-path claim |
| State-machine gap | Retention/karma fixes can violate EventLog-first or atomicity | Stateful mutation checklist and transaction-level tests |
| Evidence drift | Old `.do-it` findings can be stale against current `main` | Re-verify each card against live code before editing |
| Operator gap | A full run can accidentally hit live API side paths | Limit 1-2 no-network smoke before any long benchmark |

Path map:

```text
DeepSeek cache / runtime producer
-> signal parsing / materialization / deterministic fuel derivation
-> recall policy + execution core
-> core scoring / delivery diagnostics
-> benchmark archive / MCP result
-> build, vitest, review, cache-only recall verification
```

## 6. Verification Policy

No implementation card may claim completion without:

- `rtk pnpm build`
- Relevant targeted `rtk pnpm exec vitest run ...`
- GitNexus impact before editing any symbol and `gitnexus_detect_changes()` before commit
- Review protocol pass with zero Blocking / Important findings
- For benchmark claims: manifest/preflight pass, limit 1-2 recall-only no-network smoke, then full LongMemEval-S recall-only

Benchmark environment must explicitly disable live side paths before long runs:

```bash
ALAYA_INGEST_RECONCILIATION_ENABLED=0
ALAYA_CONFLICT_DETECTION_ENABLED=0
ALAYA_GARDEN_PROVIDER_KIND=local_heuristics
ALAYA_BENCH_EXTRACTION_CACHE_ROOT=/home/tdwhere/vibe/Do-SOUL-Alaya/.do-it/bench-runs/seeds/longmemeval-s-extraction-cache/deepseek-v4-flash-nonthinking/cache
ALAYA_EMBEDDING_PROVIDER=local_onnx
ALAYA_LOCAL_EMBEDDING_CACHE_DIR=/home/tdwhere/.cache/do-soul-alaya/models
```

Smoke acceptance:

- `llm_calls=0`
- no new `docs/bench-history/datasets/reconciliation-decisions`
- no shard TCP 443 after startup
- no `reconciliation LLM decision` log lines
- recall-only, no chat, no QA

### 2026-07-08 Bench Discipline Update

The credentialled 100Q run
`.do-it/bench-runs/public/2026-07-08T001131Z-2082994-policy-stress/`
did not satisfy this policy. Extraction itself was cache-only
(`cache_hits=25127`, `llm_calls=0`), but the command sourced
`.do-it/bench-env/alaya-api.env` without disabling ingest reconciliation.
That allowed the ambiguous-band reconciliation LLM path to run during
materialization and populated
`docs/bench-history/datasets/reconciliation-decisions/`.

Current adjudication for that run:

| Gate | Result |
| --- | --- |
| Recall-only / no chat / no QA | VERIFIED |
| Extraction cache-only | VERIFIED |
| No live reconciliation side path | FAILED |
| `materialization_drop = 0` | FAILED (`315`) |
| p95 ≤ 1100ms | FAILED (`1634ms`) |
| Release-grade evidence | FAILED — diagnostic-only / partial-clean |

The only current local script entrypoint for this phase is
`.do-it/bench-runs/scripts/longmemeval-recall-cache-only-gate.sh`. It defaults to a
2-question smoke, forces reconciliation/conflict detection off, refuses
non-cache extraction, and fails if the reconciliation decision cache grows.
Any longer run must use:

```bash
LME_RECALL_MODE=full LME_RECALL_CONFIRM_FULL=1 LME_RECALL_LIMIT=<N> LME_RECALL_SHARDS=<N> \
  .do-it/bench-runs/scripts/longmemeval-recall-cache-only-gate.sh
```

Do not reuse older `.do-it/bench-runs/scripts/*` experiment scripts; they were
removed because they were stale, paid-path-prone, or unrelated to the current
recall-only/cache-only gate.

## 7. Explicit Non-Goals

- Do not rerun broad KPI benchmarks before code issues are fixed and reviewed.
- Do not re-extract LongMemEval-S with a live paid model for this phase.
- Do not add a second durable memory truth layer.
- Do not tune weak proxy axes into the default formula.
- Do not keep a permanent "legacy RRF vs flood" branch.
- Do not use full-gold delivery coverage as proof that core scoring is correct; delivery and scoring need separate diagnostics.
