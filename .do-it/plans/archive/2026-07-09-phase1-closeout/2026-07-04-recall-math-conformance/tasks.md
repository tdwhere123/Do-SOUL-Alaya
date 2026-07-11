# Recall 全生命周期算法一致性任务卡

依赖顺序：Card 0 -> 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7。Card 5 可以在 Card 2 之后并行启动，但必须在最终 benchmark 前合入并复审。

统一完成标准：每张代码卡必须有 GitNexus impact、针对性测试、`rtk pnpm build`、相关 vitest、review protocol 零 Blocking / Important。文档卡只需 targeted grep / diff review，但不得声称代码完成。

---

## Card 0 — Current Truth Re-Verification（P0）

**Goal**: Before code edits, turn this plan into a current-state checklist against live `main`.

**Scope**:

- Read `README.md`, this `tasks.md`, `docs/handbook/invariants.md`, `docs/handbook/workflow/agent-workflow.md`, `docs/handbook/code-map.md`, `docs/handbook/runtime-status.md`, and `docs/handbook/backlog.md`.
- Re-check the live code for every task claim below.
- Run GitNexus context/impact only after identifying concrete symbols.

**Must Verify**:

- Whether fused scoring still has additive evidence/temporal/control terms.
- Whether evidence beta default is still active before true support fuel exists.
- Whether daemon and bench still diverge on embedding fusion weight.
- Whether MCP recall and bench recall still diverge by direct service call vs handler/execution core.
- Whether stale old-plan findings are truly fixed: karma lost-update, temporal interval normalize, final fused-rank ordering.
- Whether retention scanner is wired into production scheduling and whether recall consumes decayed activation.
- Whether `superseded_by` can still write self instead of the replacing memory id.

**Acceptance**:

- A short implementation note in the eventual completion report lists each old finding as `live`, `fixed`, or `not checked`.
- No code card starts from stale plan claims alone.

---

## Card 1 — Recall Policy And Execution Parity（P0）

**Goal**: Make benchmark and MCP recall use one resolved policy/execution contract before any KPI claim.

**Problem**:

The old plan framed this as "prod=12 vs bench=6". Current code must be rechecked, but the larger issue is policy resolution and handler path parity: policy decorators, overrides, side effects, diagnostics, and delivery recording can diverge across surfaces.

**Implementation Direction**:

- Define one shared recall execution boundary owned by daemon/core wiring.
- MCP recall handler and bench recall call this boundary.
- Side effects must be explicit modes, not hidden differences:
  - production MCP mode may report delivery, enqueue extraction, and usage/plasticity as today;
  - benchmark mode must be recall-only unless explicitly enabled.
- Align resolved embedding policy to weight 12 for the object base.
- Keep caller-supplied explicit fusion weight overrides authoritative for sweeps.
- Set benchmark `conflictAwareness=true` for recall-only parity unless a card explicitly tests chat-shape divergence.

**Interface Drill**:

| Shape | Best For | Risk | Verification |
| --- | --- | --- | --- |
| Shared daemon execution helper | Keeps MCP and bench parity without protocol changes | Could become a broad god helper | MCP handler unit + bench harness integration |
| Bench calls MCP handler | Strongest surface parity | Pulls MCP-only side effects into benchmark | Harder no-network smoke |
| Policy-only helper | Smallest change | Leaves handler side effects divergent | Policy tests only, insufficient for KPI claims |

Chosen shape: shared execution helper plus explicit side-effect mode.

**Acceptance**:

- A parity test proves same query + same seeded state + same resolved policy gives same top-K through MCP mode and bench mode, excluding explicitly disabled side effects.
- Diagnostics/logs show embedding fusion weight 12 when local embedding mode is active and no caller override is supplied.
- `ALAYA_RECALL_NOW_ISO` or equivalent deterministic time source is controlled in benchmark runs.

**Forbidden**:

- Do not change core scoring in this card.
- Do not make benchmark side effects default-on to hide a parity gap.

---

## Card 2 — Integrated Flood-Potential Scoring Contract（P0）

**Goal**: Replace the stale linear-axis target with a single integrated scoring contract.

**Target Contract**:

```text
cold start:
  S(o) = R_obj(o)

warm / fuel-present:
  S(o) = omega(o) * [ R_obj(o) + lambda * Flood(q,o) ] * [ 1 + beta * E_direct(o) ]

Flood(q,o) = Slice(q,o) * A_path(q,o) * B_evidence(o), with governance caps
```

**Implementation Direction**:

- Preserve `R_obj` as the RRF/object base and seed ignition.
- Remove or gate additive evidence/temporal/control contributions from the target path.
- Path/flood participates only with verified fuel:
  - facet/intent slice exists;
  - path relation is eligible and bounded;
  - evidence depth is available or the card records `B_evidence` as inactive.
- Evidence direct multiplier is disabled (`beta=0`) until query-orthogonal support fuel exists.
- Governance is omega/cap/filter only.
- Temporal becomes time/facet slice and decay input, not `+T`.

**Diagnostics Required**:

- per-candidate `R_obj`, `Slice`, `A_path`, `B_evidence`, `E_direct`, `omega`, final score;
- inactive reason per axis, especially `inactive:no_fuel`;
- fuel coverage summary for the run.

**Acceptance**:

- Unit tests prove cold-start output is identical to `R_obj` when no verified fuel exists.
- Unit tests prove adding path/evidence fuel changes only eligible candidates.
- Formula docs and diagnostics agree with implementation names.

**Forbidden**:

- No cross-axis noisy-OR.
- No unbounded graph diffusion.
- No global topic/co-occurrence edge as positive path fuel by default.
- No permanent legacy/flood branch comparison scaffold.

---

## Card 3 — DeepSeek Cache Reuse And Deterministic Fuel Derivation（P0）

**Goal**: Reuse the existing extraction cache as warm-substrate input without new online LLM extraction.

**Current Required Cache**:

`.do-it/bench-runs/seeds/longmemeval-s-extraction-cache/deepseek-v4-flash-nonthinking/cache`

**Implementation Direction**:

- Treat cache manifest as a hard preflight:
  - model matches `deepseek-v4-flash`;
  - `system_prompt_sha256` matches runtime extraction prompt;
  - `coverage=1`;
  - window containment passes for the selected run.
- Use cached `raw_json` through the existing production parser and `garden_compile` materialization path.
- After materialization, deterministically derive available fuel:
  - facet anchors from existing projection fields and domain tags;
  - source/evidence refs from materialized objects and evidence capsules;
  - answer-overlap/path candidates from deterministic overlap/projection rules;
  - support depth only when query-orthogonal evidence exists.
- Persist/report fuel coverage so scoring can refuse empty axes.

**Acceptance**:

- Cache-only seed smoke reports `cache_hits > 0`, `llm_calls=0`, and no live reconciliation side output.
- A fuel-inventory artifact or diagnostics section reports counts for objects, evidence refs, facet anchors, path candidates, and support-bearing candidates.
- Missing fuel keeps the matching axis inactive instead of using weak proxy scoring.

**Forbidden**:

- No new live DeepSeek/OpenAI extraction.
- No use of cache presence as proof that answers_with/evidence support fuel exists.

---

## Card 4 — Delivery And Full-Gold Coverage Integration（P1）

**Goal**: Keep delivery coverage as a bounded post-score selection layer while exposing where full-gold misses occur.

**Implementation Direction**:

- Delivery/S4 remains after core scoring.
- It may reorder within a bounded budget for set coverage, session/member coverage, and evidence complementarity.
- It must not masquerade as core relevance score.
- Diagnostics classify misses as:
  - candidate absent;
  - materialization drop;
  - budget drop;
  - delivery order drop;
  - answer-set coverage drop.

**Acceptance**:

- Tests or fixture diagnostics show a candidate can be present in pool but lost at delivery, with a distinct reason.
- Full@5 analysis reports delivery contribution separately from core scoring.

**Forbidden**:

- Do not use full-gold improvement alone to justify changing core scoring constants.
- Do not implement `Score + lambda * Diversity` as an unbounded additive ranker.

---

## Card 5 — Lifecycle Feedback Closure（P1）

**Goal**: Close the parts of memory lifecycle that feed later recall without reintroducing stale old bugs.

**Live Items To Re-Verify And Fix If Present**:

1. `superseded_by` source:
   - If `supersede_penalty` still records the target memory id as its own replacement, add the replacing/source memory id to the event path or transition input.
   - Protocol/schema changes must go through invariant §25 review.
2. Retention scanner:
   - Wire scanner into Janitor/Garden scheduling if production still has zero calls.
   - Preserve fire-and-forget Garden semantics.
3. Recall consumption:
   - Prefer recomputing/consuming decayed `activation_score` through the existing activation path.
   - Do not make recall read `retention_score` directly unless an interface drill proves that is the correct contract.
4. Accept/reject karma:
   - Emit `accept_gain` / `reject_penalty` at proposal/review accept/reject points if production still has no producers.
   - Avoid double counting with initial materialization dynamics.

**Acceptance**:

- EventLog-first tests for every state-changing path touched.
- Regression tests for supersede source id if changed.
- Time-injected retention test proves a memory can decay into lower activation and affect recall eligibility through the intended channel.
- Accept/reject tests prove karma event and derived dynamics changes once, not twice.

**Stale Findings Not To Carry Forward Without Reproof**:

- karma lost-update atomicity;
- temporal `start > end` normalization;
- final `fused_rank` comparator mismatch.

---

## Card 6 — Formula And Lifecycle Regression Test Net（P1）

**Goal**: Add tests that protect the model contract rather than implementation trivia.

**Required Test Areas**:

- Cold-start identity: no fuel means `S == R_obj`.
- Fuel gating: path/evidence/governance inactive reasons are explicit.
- Embedding policy parity: default local embedding fusion weight 12 across bench and daemon resolved policy.
- Formula assembly: evidence multiplier disabled until true support fuel exists.
- Temporal/control placement: no target-path additive `+T/+C`.
- Materialization fuel inventory: cache replay can report what it did and did not produce.
- Lifecycle feedback: retention and karma changes affect later recall through the documented path.

**Acceptance**:

- Each test names the behavior it protects.
- At least one integration seam proves producer -> consumer wiring for parity and cache replay.
- Tests do not mock away the collaborator chain being claimed.

---

## Card 7 — Cache-Only Benchmark Gate And Closeout（P0 Final Gate）

**Goal**: Produce final evidence only after Cards 1-6 are implemented and reviewed.

**Preconditions**:

- `rtk pnpm build` passes.
- Relevant vitest projects pass.
- Review protocol reports zero Blocking / Important findings.
- GitNexus detect-changes confirms affected symbols/flows match the cards.

**Smoke Command Shape**:

Use the environment from `README.md` §6. Start with limit 1-2.

**Smoke Acceptance**:

- recall-only;
- no chat;
- no QA;
- `llm_calls=0`;
- no new reconciliation decision files;
- no TCP 443 after startup;
- no reconciliation LLM decision logs;
- manifest/model/prompt/window preflight passes.

**Full Gate**:

- LongMemEval-S recall-only.
- Both embedding modes only if explicitly intended for that run.
- Archive results via the normal bench-history pointer mechanism.
- Report any `NOT_VERIFIED` rows; do not claim release readiness from smoke-only output.

**Closeout Report Must Include**:

- changed files by card;
- verification commands and outcomes;
- cache manifest/path used;
- fuel inventory summary;
- score/delivery miss taxonomy;
- review/fix-loop result;
- residual risks and linked backlog issues for any deferral.
