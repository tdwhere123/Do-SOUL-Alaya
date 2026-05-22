# v0.3.10 Phase Y Retained Closure Evidence

> Status: Phase Y retained-work closure evidence for entering Phase C.
> Final release closeout must refresh the command evidence after the last
> fix-loop patch, but the retained work is no longer deferred past review.

## Closure Matrix

| Item | Owner | Closure evidence | Verification lane |
|---|---|---|---|
| P1 usage_proof gate removal | core owner | Cold-path recall is covered by the v0.3.10 regression suite and path expansion diagnostics; no benchmark gate depends on prior usage proof. | `rtk pnpm exec vitest run --project @do-soul/alaya-core -- recall-regression-suite/v0.3.10-regressions.test.ts recall-service.test.ts` |
| P3 time_concern producer/path | core + storage owner | Date terms are query probes and `time_concern` path-expansion sources in recall diagnostics; the temporal stream is rank-fusion input, not a revived temporal proximity plane. | `rtk pnpm exec vitest run --project @do-soul/alaya-core -- recall-query-probes recall-regression-suite/v0.3.10-regressions.test.ts` |
| P4 active constraints channel | core-daemon owner | `active_constraints[]` remains a separate response-root channel for governance-backed constraints. Draft or dimension-only agent outputs stay out of the hard channel; LongMemEval records active-constraint delivery in diagnostics only and does not count it toward R@K. | `rtk pnpm exec vitest run --project @do-soul/alaya-bench-runner -- harness longmemeval-runner` |
| G governance/control-plane | governance owner | Control-plane output remains explicit proposal/audit state; benchmark and recall diagnostics do not promote control-plane output into durable memory. | `rtk pnpm exec vitest run --project @do-soul/alaya-core -- recall-service recall-regression-suite/v0.3.10-regressions.test.ts` |
| A agent attach/usage loop | daemon owner | Controlled replay covers the recall to `report_context_usage` warm loop and archives it under `controlled-replay/`, outside the public KPI root. | `rtk pnpm exec vitest run --project @do-soul/alaya-bench-runner -- controlled-replay` |
| D docs truth/release notes | docs owner | D20 six K1 floors, Alaya-native non-goals, cross-encoder park, and cache-first benchmark instructions are the active docs truth. | active README/plan/KPI/decision sweep for retired single-line K1 gate wording, stale pre-D20 R@5 fallback wording, and latency-threshold parity |
| B benchmark reproducibility | bench owner | LongMemEval cache uses pinned dataset metadata as checksum source of truth; `--data-dir` is threaded through CLI help, runner preflight, sharded full runs, and docs. | `rtk pnpm exec vitest run --project @do-soul/alaya-bench-runner` |

## Non-Goals Kept Closed

- No cross-encoder or rerank stage in v0.3.10.
- No generic RAG synonym expansion.
- No default embedding dependency; embedding remains an opt-in benchmark track.
- No public MCP result schema exposure for internal `fused_rank` or `fusion_score`.
