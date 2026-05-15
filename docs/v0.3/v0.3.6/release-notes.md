# v0.3.6 Release Notes

v0.3.6 ships the operator-facing Inspector uplift (Overview, Recall
Stats, sidebar nav, unified design tokens) and the first reproducible
end-to-end bench harness for `@do-soul/alaya-*` — self-bench plus the
first honest LongMemEval-S retrieval baseline. The README becomes
dual-axis: recall accuracy alongside governance / audit depth, neither
hidden, neither overclaimed.

## Added

- Inspector `Overview` home page (health pill, pending proposals,
  recall stats, tier distribution, latest bench cards) and `Recall`
  stats page with windowed KPI cards + agent-target breakdown.
- Sidebar navigation; mobile bottom tab-bar fallback under `sm`.
- Daemon HTTP `GET /workspaces/:workspaceId/recall-stats` route reusing
  `RecallUtilizationService`.
- Inspector backend `GET /api/recall-stats/:workspaceId` proxy with
  token + workspace validation.
- Inspector backend `GET /api/bench-summary` reading the cross-version
  bench-history archive, with per-split error isolation.
- `@do-soul/alaya-eval` workspace package — zod-only leaf: KPI schema
  (sample_size / evaluated_count / harness_mode), threshold engine,
  split-aware history archive, diff engine with sample-size-guarded
  ratio classifier (#BL-040 fields baked into thresholds).
- `@do-soul/alaya-bench-runner` workspace package — daemon-attached
  harness that drives self-bench and LongMemEval through the real
  in-process daemon + MCP `propose+review` chain.
- LongMemEval-Oracle and LongMemEval-S drivers (sha256-pinned via
  `docs/bench-history/datasets/`).
- Cross-version benchmark archive under `docs/bench-history/` with
  split-aware `readLatest` so Oracle and S do not cross-compare.
- Evidence artefact: 9-row EventLog audit-trail-witness for one bench
  seed, proving the harness exercises the production governance path.

## Changed

- Inspector default route `/` → `/overview` (was `/config`).
- Inspector navigation: header tabs → left sidebar (mobile: bottom).
- All Inspector hex-color literals collapsed into Tailwind theme
  tokens (`beige.*` / `ink.*` / `morandi.*` / `state.*`).
- LongMemEval runner now picks `split` from `--variant` instead of
  hard-coding `longmemeval-s`; Oracle and S are archived as
  distinct splits.

## Compatibility

- No MCP tool surface change.
- No protocol zod schema change.
- No EventLog payload schema change.
- No runtime config schema change.
- No SQLite migration.

## Bench KPIs (v0.3.6 baseline)

Honest first numbers — pure SQLite FTS + activation, no embedding
supplement, full MCP `propose+review` chain seeded.

| Bench | n | R@1 | R@5 | R@10 | p95 latency | Notes |
|---|---|---|---|---|---|---|
| self / synthetic | 8 | 100% | 100% | 100% | 26ms | Tiny workspace tripwire, not a retrieval claim. See report.md Scoring contract. |
| public / longmemeval-oracle | 500/500 | 45.2% | 80.0% | 90.4% | 21ms | Coarse retrieval — no distractor sessions, session-axis filter degenerates. |
| public / longmemeval-s | **500/500** | 45.8% | **60.2%** | 60.6% | 73ms | First honest retrieval baseline. 98% distractor session ratio. Shard split — first 250 human-authored: 52.0%; last 250 GPT-4-augmented: 68.4%. Scale-up + CI tracked as #BL-040. |

External reference (cited as reported, link, not run by us):
`agentmemory` README claims R@5 = 95.2% on **LoCoMo** (different
dataset). LoCoMo cross-stack comparison is tracked as #BL-041.

## Reproduce these numbers

```bash
rtk pnpm install
rtk pnpm build
# self-bench (8 inline synthetic scenarios, ~10s)
node apps/bench-runner/bin/alaya-bench-runner.mjs self
# LongMemEval Oracle full set (500 questions; ~self-consistency throughput,
# Oracle's session-set filter is a no-op — see the report.md Scoring contract)
node apps/bench-runner/bin/alaya-bench-runner.mjs fetch-longmemeval --variant oracle
node apps/bench-runner/bin/alaya-bench-runner.mjs longmemeval --variant oracle
# LongMemEval-S with distractor sessions — the honest retrieval R@K.
# Full 500 questions on S costs hours; smoke at --limit 20–50 first.
node apps/bench-runner/bin/alaya-bench-runner.mjs fetch-longmemeval --variant s
node apps/bench-runner/bin/alaya-bench-runner.mjs longmemeval --variant s --limit 20
```

History archive: `docs/bench-history/`. Each run writes
`{kpi.json, report.md}` and rewrites `latest-baseline.json`; runs across
splits (synthetic / longmemeval-oracle / longmemeval-s) are diffed
apples-to-apples via the split-aware `readLatest`.

## Verification

See `reports/v0.3.6-closeout.md` for command evidence.
