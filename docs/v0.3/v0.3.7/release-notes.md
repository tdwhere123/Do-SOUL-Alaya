# v0.3.7 Release Notes

v0.3.7 lands no-embedding candidate-generation infrastructure and
benchmark-diagnostic surfaces without changing public protocol or
storage contracts. Inspector memory graph actions now mutate through
the managed daemon without hitting a request-token 403.

This is an implementation checkpoint in **honest-baseline rewrite**
mode. The earlier R@5 = 70.0% disabled-100 number was produced by a
v0.3.7 build that included LongMemEval-question-shape heuristics
inside `packages/core`. Those heuristics have been removed; the new
honest disabled-100 archive replaces the 70.0% claim. See
`reports/v0.3.7-closeout.md` for the current archive path and number.

Two earlier-claimed archives are retracted: `docs/bench-history/live/`
and `docs/bench-history/public-multiturn/`. Their import commands are
in place, but no v0.3.7-era archive exists on disk yet. Producing the
first multi-turn baseline is Phase B of the follow-up plan;
disabled-500 and env-embedding staged floor evidence remain explicitly
out of scope.

## Added

- `alaya-bench-runner live` imports
  `.do-it/checks/alaya-live/main-check.json` into
  `docs/bench-history/live/<slug>/`. No v0.3.7-era live archive has
  been produced yet; the earlier baseline pointer was retracted.
- `alaya-bench-runner longmemeval-multiturn` runs LongMemEval-S
  questions through repeated `soul.recall` →
  `soul.report_context_usage` rounds and archives to
  `docs/bench-history/public-multiturn/<slug>/`. First archive is
  follow-up work.
- Inspector Overview supports four split cards
  (`self` / `public` / `live` / `public-multiturn`), rendering "no
  entries" rather than failing when an archive directory is empty.
- Internal no-embedding recall diagnostics: query probes, admission
  planes, pre-budget rank, final rank, drop reason, lexical rank,
  structural score, and provider status.
- Read-side multi-plane candidate generation for activation,
  protected/winner governance, object probes, evidence anchors, domain
  tag clusters, temporal/session cohorts, memory graph one-hop
  expansion, PathRelation expansion, and lexical evidence.
- LongMemEval diagnostic sidecar
  (`longmemeval-diagnostics.json`); optional `public-multiturn` KPI
  fields (`r_at_5_round_1`, `r_at_5_round_2`, `r_at_5_round_n`,
  `multiturn_rounds`); optional env-embedding provider-state KPI
  fields (`r_at_5_overall`, `r_at_5_with_embedding_returned`,
  `provider_returned_rate`, `provider_pending_rate`,
  `provider_failed_rate`).

## Fixed

- `alaya inspect` passes the managed daemon request token to the
  Inspector child process, fixing memory graph actions such as keep,
  rewrite, downgrade, and retire when launched through the normal CLI.
  When pointing Inspector at an external daemon, inherited
  `ALAYA_REQUEST_TOKEN` is not forwarded; use
  `ALAYA_INSPECTOR_DAEMON_REQUEST_TOKEN` for that explicit path.
- Inspector `apiFetch` now surfaces `{ error: "..." }` and structured
  `{ error: { message } }` bodies instead of only `API Error: 403
  Forbidden`.
- `rtk pnpm build` now includes `@do-soul/alaya-eval` and
  `@do-soul/alaya-bench-runner`, so eval schema changes do not leave
  stale `dist/` declarations behind.
- `live-gates.json` is written inside the same staged archive publish as
  `kpi.json` and `report.md`, and is allowlisted to aggregate metrics /
  gate rows only.
- `soul.recall` keeps `max_results` as the delivery limit while using a
  wider internal candidate window for scoring and diagnostics.
- No-embedding scoring now keeps FTS rank separate from structural /
  content evidence (`lexical_rank` vs `structural_score` are distinct
  diagnostic fields), so broad keyword matches do not masquerade as
  graph, path, or direct-answer support.

## Retracted in honest-baseline rewrite

- `QUERY_TERM_ALIASES`, `expandQueryTermVariants`,
  `queryLooksPersonal`, `looksLikePersonalFact`,
  `looksLikePromptTemplate`, and `scoreDirectAnswerCue` deleted from
  `packages/core/src/recall-service.ts`. They were
  LongMemEval-question-shape regexes (gift/reading/class/yoga/devouring)
  that did not belong inside the core truth boundary.
- Two Sister/Birthday/Gift synthetic tests in
  `packages/core/src/__tests__/recall-service.test.ts` replaced with a
  single neutral-token regression that verifies `lexical_rank` and
  `structural_score` remain decoupled diagnostic fields.

## Bench Snapshot

Honest-baseline disabled-100 numbers and the first
`public-multiturn` round-curve are recorded in
`reports/v0.3.7-closeout.md` once the Phase A rerun and Phase B
multi-turn run land. The earlier 70.0% claim and the
91.4% / 94.6% live-archive claim are retracted in that report.

## Compatibility

- No MCP tool surface change.
- No protocol zod schema change.
- No EventLog payload schema change.
- No runtime config schema change.
- No SQLite migration.

See [`reports/v0.3.7-closeout.md`](reports/v0.3.7-closeout.md) for the
implementation summary, verification commands, and benchmark gate status.
