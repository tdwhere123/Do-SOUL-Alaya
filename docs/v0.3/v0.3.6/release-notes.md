# v0.3.6 Release Notes

> Draft. Filled out at Phase 6 close-out. Reads "WIP" while a Phase is
> still open.

v0.3.6 adds an operator-facing UI uplift (Overview home page, Recall
Stats page, sidebar nav, unified design tokens) and the first
reproducible recall benchmark harness (self-bench + public LongMemEval-S
baseline) for `@do-soul/alaya-*`. README narrative becomes dual-axis:
recall accuracy alongside governance / audit depth.

## Added

- WIP: Inspector `Overview` home page, `Recall` stats page.
- WIP: Sidebar navigation; mobile bottom tab-bar fallback.
- WIP: Daemon HTTP `GET /workspaces/:workspaceId/recall-stats` route.
- WIP: Inspector backend `GET /api/recall-stats/:workspaceId` proxy.
- WIP: `@do-soul/alaya-eval` workspace package with CLI subcommands
  `self`, `longmemeval`, `diff`, `list`.
- WIP: Cross-version benchmark history under `docs/v0.3/bench-history/`
  (`self` + `public` splits, `kpi.json` + `report.md` + diff engine).
- WIP: LongMemEval-S public benchmark driver.

## Changed

- WIP: Inspector default route `/` → `/overview` (was `/config`).
- WIP: Inspector navigation: header tabs → left sidebar (sm: bottom).
- WIP: All Inspector hex-color literals collapsed into Tailwind theme
  tokens.

## Compatibility

- WIP: No MCP tool surface change.
- WIP: No protocol zod schema change.
- WIP: No EventLog payload schema change.
- WIP: No runtime config schema change.
- WIP: No SQLite migration.

## Bench KPIs (filled at Phase 5/6 close-out)

| Bench | R@1 | R@5 | R@10 | latency p95 | token saved | Δ vs prev |
|---|---|---|---|---|---|---|
| self / golden | — | — | — | — | — | — |
| self / synthetic | — | — | — | — | — | — |
| public / LongMemEval-S | — | — | — | — | — | — |

## Reproduce these numbers

```bash
rtk pnpm install
rtk pnpm exec alaya-eval self
rtk pnpm exec alaya-eval longmemeval
```

History archive: `docs/v0.3/bench-history/`.

## Verification

See `reports/v0.3.6-closeout.md` for command evidence.
