# Review: 2026-07-09 multi-lens fix-loop

**Scope:** `.worktrees/recall-root-cause-levers-2026-07-06` tip `6bfb5891` + uncommitted fix-loop  
**Branch:** `cursor/fix-all-then-full-500q-2017`  
**Intensity:** review-adversarial (correctness, red-team, spec/AGENTS, code-quality/comments, architecture, time-complexity)  
**Verdict:** **CLEAR** for Blocking / Important in assigned review scope

## Lenses run

| Lens | Agent | Result |
| --- | --- | --- |
| Correctness | reviewer | Round-1 Important closed; re-review clean |
| Adversarial | red-team-reviewer | RT1–RT4 closed; P1 closed in round-2 |
| Spec / AGENTS | spec-compliance-reviewer | Size/comment/docs drift closed or downgraded |
| Code quality / comments | code-quality-cleaner + comments lens | Card/Phase labels removed; splits done |
| Architecture | architect-reviewer | A2/A3 closed; A1 residual intentional |
| Time complexity | red-team (perf) | No Blocking asymptotic; P1 throttle closed |

## Important closed (evidence)

- R1 abstention scale `1/60` — `abstention-confidence.ts`
- R2/RT1 ONNX dead-PID reclaim + P1 ≥1000ms reclaim throttle — `local-onnx-host-single-flight.ts`
- RT2 feature-rerank head floor gated by `ALAYA_RECALL_FUSION_RANK_FLOOR` (default off)
- RT3 merge fails loud on missing diagnostics sidecar
- RT4 concurrency wires ONNX single-flight + shared lock under `shardRoot`
- A2 calibration scripts ≤500 (`lib` 434 / `isotonic` 115 / entry 143)
- A3 `OTHER_STREAMS` + vitest vs `RECALL_FUSION_STREAMS`
- Comment discipline: Card/Phase/history labels removed from changed source
- Build break from size extract: mutable miss-taxonomy tally typing fixed in `diagnostics-sidecar.ts`

## Residual (not Important for this loop)

- **A1:** `answers_with` / flood hard-on with no env kill-switch — intentional per tip commit `6bfb5891`; ops rollback = code revert or HQ absence.
- Clean 500Q release evidence: **NOT_VERIFIED** on tip.
- Diagnostics test files still >500 after part2 (693 / 547) — Opportunity only (<800).
- Full `@do-soul/alaya-core|bench-runner|eval` suite hit `better-sqlite3` NODE_MODULE_VERSION mismatch under Node 20 vs modules built for 24 — env, not this diff. Targeted suites below are the gate evidence.

## Verification (fresh)

```text
rtk pnpm build                                                  → exit 0
rtk pnpm exec vitest run --project @do-soul/alaya-core
  (onnx single-flight, fusion lexical rerank, delivery-selection,
   facet-overlap, integrated-flood, feature-rerank)             → targeted pass
rtk pnpm exec vitest run --project @do-soul/alaya-bench-runner
  (abstention, calibration, diagnostics part1/2, concurrency,
   merge-validations)                                           → targeted pass
rtk pnpm exec vitest run --project @do-soul/alaya-eval          → see command output in parent turn
```

## Prevention hooks added

- Stale-lock reclaim interval unit test
- Fusion-rank floor default-off / on tests
- Missing-sidecar merge refusal test
- Concurrent ONNX env wiring test
- `RECALL_FUSION_STREAMS` partition coverage test
