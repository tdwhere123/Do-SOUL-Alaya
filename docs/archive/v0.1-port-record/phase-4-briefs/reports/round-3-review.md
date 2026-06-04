# Round 3 Review — bl-open-repair

> Closes the five cross-perspective Blocking findings raised in the
> depth review on `bl-open-repair`. Builds on pass-3 (`2010b88`) with
> two atomic commits:
>
> - `36a720d` docs(round-3-governance): seed followup cards, flip
>   readiness, retire hygiene plan
> - `e371767` feat(round-3-trust): config-service boundary recovery +
>   OPENAI rename + EventLog orphan reconciler + counter rebuild

## Verdict

Round 3 is **passed**. Five-perspective re-run reports zero Blocking
and zero Important findings against the merged worktree. Two
nice-to-have gaps remain, listed in §Deferred.

## Findings Closed

| Finding | Resolution |
|---|---|
| config-service boundary creep (Port-First / architecture / data / test cross-vote) | `apps/core-daemon/src/services/config-service.ts` 632 → 257 lines; .env atomic write, secret-ref parsing, ENV_SECRET_REF_PATTERN, fs primitives moved to `apps/core-daemon/src/services/env-file-service.ts`; daemon-local `RuntimeEmbeddingConfig` duplicate removed in favour of `import type { RuntimeEmbeddingConfig } from "@do-soul/alaya-protocol"`. |
| Migration 056 + repo missing P1-migrations-followup carve-out | `task-p1-migrations-followup-trust-state-056.md` seeded; `#BL-022` opened in `backlog.md`; `task-p4-trust-state.md §2.1` adds the migration + repo rows authorised by the followup card and `#BL-022`; AC10 added. |
| EventLog ↔ trust-state cross-await orphan window (data / architecture / test cross-vote) | New `GardenTaskKind.EVENT_LOG_ORPHAN_DETECTION` reuses the existing `orphan_radar` framework via migration 057. The Auditor scans `event_log` for trust delivery / usage events whose `audit_event_id` is missing from both trust tables and records `soul.garden.event_log_orphan_detected` through `publishWithMutation`, so a failed radar insert rolls the audit event back instead of creating a synthetic orphan. |
| Trust counter persistence drift (`#BL-020`) | `rebuildCountersFromEventLog` in `packages/core/src/trust-state-service.ts` reconstructs installed / configured / unverifiable counters from EventLog at daemon startup and daemon bootstrap now awaits replay before `markReady`. `trust-state-persistence.test.ts` asserts counter rebuild across daemon restart. `#BL-020` is resolved by EventLog-backed replay. |
| Trust-state reducer in daemon truth boundary | `reduceTrustState`, `collectCounts`, and `SummaryCounts` moved to `packages/core/src/trust-state-service.ts`. Daemon imports from `@do-soul/alaya-core`; reducer logic now lives at the truth boundary, daemon only wires repo + EventPublisher + recorder. `task-p4-followup-trust-state-reducer.md` authorises this uplift. |
| `OPENAI_API_KEY` secret-ref naming hazard | `.env` field renamed to `ALAYA_OPENAI_SECRET_REF`. Daemon startup reads only the Alaya secret-ref field, resolves `env:` / `file:` references, and passes the resolved value directly to embedding / Garden providers without writing plaintext back into `process.env.OPENAI_API_KEY` or forwarding it to the Inspector child process. Operators who want the standard variable still configure `ALAYA_OPENAI_SECRET_REF=env:OPENAI_API_KEY`. |
| Cross-document readiness drift (Gate-4 closeout vs INDEX vs report) | `INDEX.md` line 30 + line 116 flip P4-trust-state to `live-event-ready`. `gate-4-closeout.md:10` narrows the `#BL-015` closure note to "delivery/usage records"; counter restart stability is closed by `#BL-020` through EventLog replay before recorder readiness. `task-p4-trust-state.md §2.1` table aligned with code reality. |
| `#BL-014` / `#BL-015` / `#BL-021` wording inconsistencies | `#BL-014` keeps Open status with an explicit note that this round touched documentation references but did not close the issue. `#BL-015` title narrowed to delivery/usage records. `#BL-021` moved under a new "Accepted divergences (registered, not closed)" subsection in `backlog.md`, semantically aligned with `port-protocol.md:104`'s Registered Divergences section. |
| `post-port-hygiene-plan.md` hidden scope creep | File deleted; `backlog.md` `#BL-016` / `#BL-017` references cleaned up; close conditions left intact (no upward gate movement). The plan-file route is no longer used; future hygiene work runs through proper task cards. |

## Verification

```
rtk pnpm build                                       # green
rtk pnpm exec vitest run --project @do-soul/alaya-protocol     # 519 / 519
rtk pnpm exec vitest run --project @do-soul/alaya-core         # 596 / 596
rtk pnpm exec vitest run --project @do-soul/alaya-storage      # 312 / 312
rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon  # 202 / 202
rtk pnpm exec vitest run --project @do-soul/alaya-soul         # 173 / 173
rtk pnpm exec vitest run --project @do-soul/alaya-inspector    # 10 / 10
rtk pnpm exec vitest run --project @do-soul/alaya-inspector-web # 20 / 20
```

Total: 1832 vitest cases passing. The Gate-4 attached-agent MCP proof
harness still passes in the same daemon lifetime; the
`trust-state-persistence` suite now includes a counter-rebuild-across-
restart case that proves `#BL-020`'s replay path works end-to-end.

## Followup Cards Seeded This Round

- `docs/v0.1/phase-1-followup-briefs/task-p1-migrations-followup-trust-state-056.md`
  — registers migration 056 + `trust-state-repo.ts` against `#BL-022`.
- `docs/v0.1/phase-1-followup-briefs/task-p1-protocol-followup-grace-and-trust-counters.md`
  — registers `soul.green.grace_entered` (phase-3b) + the three trust
  counter events in `packages/protocol/src/soul/trust-state.ts` and
  the global EventLog union under `#BL-013` / `#BL-020`, with the
  events kept Alaya-original (source `n/a`).
- `docs/v0.1/phase-4-followup-briefs/task-p4-followup-trust-state-reducer.md`
  — pre-authorises the reducer uplift to `packages/core/`. The work
  landed in this round's `e371767` commit.

## Nice-to-have items resolved

The depth review's nice-to-have items below were folded in as a final
test-rigor pass rather than carried forward.

- `routes-config-port.test.ts` — added a real-`SqliteConfigRepo` +
  Hono harness round-trip case covering the soul / strategy /
  environment PATCH paths in addition to the existing real-EventLog
  paste-mode case for runtime-embedding. All four PATCH paths now
  have at least one fully-live assertion path.
- `migration-parity.test.ts` — added a `sqlite_master` /
  `PRAGMA index_list` / `PRAGMA table_info` assertion set after the
  full migration suite (056 trust tables + 057 orphan_radar rebuild).
- `attached-agent-mcp-proof.test.ts` — added two reverse
  assertions in the same daemon lifetime: `soul.recall` with malformed
  arguments and an unknown tool name both return `isError: true`.
- `EmbeddingSupplementForm.test.tsx` — three new cases cover initial
  GET network failure, PATCH 500 response, and a double-click race
  during a pending save (verifies only one PATCH dispatches and
  `onRequiresRestart` fires once); existing tests already use
  `getByRole` / `getByPlaceholderText` for a11y-first selectors.

Total vitest growth: 1832 → 1861 cases passing across the same
package matrix.

## Commits

```
36a720d docs(round-3-governance): seed followup cards, flip readiness, retire hygiene plan
e371767 feat(round-3-trust): config-service boundary recovery + OPENAI rename + EventLog orphan reconciler + counter rebuild
1777e9f docs(round-3-review): close out bl-open-repair Round 3 with verification log
<this commit> test(round-3-rigor): land the four nice-to-have test reinforcements
```

All commits land on `bl-open-repair` directly above pass-3 (`2010b88`)
and pass the local pre-commit hooks without `--no-verify`.
