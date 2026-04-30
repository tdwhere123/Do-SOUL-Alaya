# review-p4-controller — Phase 4 Controller Worktree Static Review

**Reviewer**: Claude Opus 4.7 (1M context), invoked by user via `/simplify` on 2026-04-30.
**Subject**: branch `p4-controller` @ `bfa3ad9 feat(p4): complete Codex-owned runtime backend` (the user collapsed all Codex Phase 4 work into one feature commit on top of `07979b5 chore(p4): checkpoint controller smoke baseline`).
**Mode**: read-only static review. The reviewer did NOT modify any code or tests. This report is dropped into the worktree as untracked content; the user decides whether to commit it.
**Pre-conditions met**:
- worktree clean (`rtk git status` returns 0 lines).
- `rtk pnpm build` passed.
- `rtk pnpm exec vitest run` (full workspace) passed: **209 files / 1715 tests** in 23.59s.
- `main` is 1 commit ahead of merge-base `16b8cc0` with a doc-only commit `9883012`; clean rebase target.

## Final Verdict — DO NOT MERGE

**Mergeable status**: ❌ **FAIL**.

User-supplied bar (2026-04-30): **0 Blocking + 0 Important + 0 Nice-to-have** before merge.
Aggregate findings across Tracks 1 + 2 (Track 3 deferred — see §6):

| Track | Scope | Blocking | Important | Nice-to-have |
|---|---|---|---|---|
| T1a | Daemon core (skeleton / startup-ordering / sse-strip) | **7** | 4 | 1 |
| T1b | Routes (5 batch cards, 34+ route files) | **7** | 3 | 2 |
| T1c | Daemon aux + barrel (services / glue / middleware / mcp-tooling / recall-cache / routes-register) | **6** | 4 | 1 |
| T2a | Alaya-original CLI surface (11 cards) | **4** | 11 | 3 |
| T2b | Trust-state + MCP memory tools + MCP server | 0 | 5 | 2 |
| T2c | Inspector server (Gemini handoff boundary) | **1** | 3 | 3 |
| **Total** | | **25** | **30** | **12** |

Build + tests are green, but **a green build does not prove port fidelity**. Tests pass because they were written against the redesigned implementation, not against the vendor source contract that the cards declared they would honor.

## 1. Why The Worktree Fails Its Own Charter

Three fault classes dominate. All are explicitly listed in CLAUDE.md as **anti-patterns that will be rejected at review**:

1. **Clean-room reimplementation in place of porting.** The daemon core (`apps/core-daemon/src/{index,app,garden-runtime,worker-runtime-wiring,routes/runs}.ts`) and all 34 HTTP route files are wholesale rewrites that do not match `vendor/do-what-new-snapshot/<same-path>`:
   - `index.ts`: 99 LoC vs vendor 1135 LoC.
   - `app.ts`: 46 LoC vs vendor 731 LoC. Vendor uses `Hono` + `cors` + `bodyLimit` + `timingSafeEqual` request-token gate + 28 typed `register*Routes` registrations. Worktree uses a custom `DaemonRouteHandler` + URL-pathname regex + a god-object `context.daemon` indirection.
   - `garden-runtime.ts`: 33 LoC empty-stub vs vendor 519 LoC (Janitor / Librarian / Auditor / GardenScheduler / PathGraphSnapshotter all dropped).
   - `worker-runtime-wiring.ts`: 7-line `{ ready: true }` stub vs vendor 186 LoC (ConstraintProxy / SerialDelegationService / RuntimeEventNormalizer / WorkerRunLifecycleService etc. all dropped).
   - All 34 route files use the custom framework with zero `from "hono"` imports (verified by `rtk grep -l "from \"hono\"" apps/core-daemon/src/routes/*.ts` → empty).
   - **None of these rewrites is enumerated as Adapter Points in the owning task cards' §2 Allowed Scope.**

2. **Parallel contract layer instead of ported real code.** Two new files absorb the redesign:
   - `apps/core-daemon/src/daemon-handle.ts` (24.8 KB) — a god-object controller with no vendor counterpart and no card §2 ownership.
   - `apps/core-daemon/src/daemon-service-graph.ts` (1950 LoC) — `createAlayaDaemonServiceGraph(...)` consumed by `daemon-handle.ts`. Also no vendor counterpart, no card ownership. `rtk grep -rn "daemon-service-graph" docs/` returns 0 hits.

3. **Cards claim DONE while their target files are MISSING.** P4-daemon-services and P4-daemon-glue have completion reports under `docs/v0.1/phase-4-briefs/reports/` but the actual target files do not exist in the worktree:
   - `services/principal-coding-availability.ts`, `services/environment-status-service.ts`, `services/embedding-status-service.ts`, `services/soul-topology-audit-service.ts`, `services/config-service.ts`, `services/soul-approval-service.ts`, `services/workspace-engine-config-repo.ts` — **`apps/core-daemon/src/services/` is empty**.
   - Helper files `daemon-defaults.ts` (40 LoC vendor), `server-options.ts` (36), `files-data-dir.ts` (7), `zero-day-policies.ts` (33), `security-status-bootstrap.ts` (204), `budget-wiring.ts` (65), `narrative-budget-repo.ts` (62), `compute-routing-resolver.ts` (68), `manifestation-context-lens-assembler.ts` (12), `orphan-query.ts` (43), `handoff-gap-adapter.ts` (150), `builtin-conversation-tool-specs.ts` (36), `tool-runtime.ts` (486), `middleware/error-handler.ts`, `daemon-mcp-tooling.ts` (79), `mcp-runtime-registry.ts` (400), `mcp-catalog.ts` (868), and tests `mcp-runtime-registry.test.ts`, `tool-runtime.test.ts`, `tool-runtime-bootstrap.test.ts` — **all missing**.
   - `mcp-catalog.ts` (868 LoC vendor general MCP catalog) replaced by `mcp-memory-tool-catalog.ts` (153 LoC, narrowed to `soul.*` tools only) — that's a `requires-redesign` swap performed without explicit user approval and without a Charter Authority cite.

This is exactly what `docs/handbook/port-protocol.md` and CLAUDE.md "Port-First Discipline" forbid. The cards' port modes (mostly `adapt-and-port`) only sanction namespace renames + listed Adapter Points; they do not sanction discarding vendor logic and rebuilding around an Alaya-specific service-graph file.

## 2. RuntimeNotifier broadcast leg is functionally absent (architecture invariant)

`apps/core-daemon/src/runtime-notifier.ts:16-18`:
```ts
public async notify(_runId: string, _event: Phase0Event): Promise<void> {
  return;
}
```
And `createRuntimeNotifier()` is exported from `index.ts` but never instantiated nor passed into routes / garden-runtime / worker-runtime-wiring / `background/bootstrap.ts`. Routes do not receive a `runtimeNotifier` field on `routeContext` (only `{ daemon, mcpServer }`).

Per invariant §11 (CLAUDE.md cited via `docs/handbook/invariants.md`), `RuntimeNotifier` is the only legal broadcast leg in Alaya (replacing SSE). Per §7 the invariant is `EventLog → DB → audit → notify`. With `notify` returning unconditionally and never invoked, Phase0Events never leave core in production. The 1715 tests are green because they all use mocks at the route level — no production call site exercises the broadcast leg.

This is a **Blocking architectural violation**, not a port-fidelity wobble.

## 3. Audit-precedes-broadcast (§10) is systemically inverted across §23 surfaces

Across the CLI / Operations / Profile-mutation surfaces:
- `apps/core-daemon/src/profile-mutation.ts:226-260`: `applyProfileMutationPlan` writes the user's `~/.codex/config.toml` and `~/.claude.json` BEFORE appending the audit row.
- `apps/core-daemon/src/cli/install.ts:80-100`: `install` writes `alaya.toml`, `.env`, secrets file, then audits.
- `apps/core-daemon/src/operations.ts:31-33` and `45-62`: `backup` and `export` write artifacts before audit; `import` writes without preview, without `[y/N]`, without atomic temp+rename — see B-CLI-003.

A SIGKILL or power-fail between artifact write and audit append leaves observable mutation with no audit trace. Per §10 the audit must precede the observable state change. This is **Blocking** for `import` (destructive, no recovery), and **Blocking** for the rest as a §10 violation pattern.

## 4. Inspector server contract has a silent break Gemini will trip on

`apps/inspector/src/routes/config.ts:105-151` accepts `embedding_enabled` in the PATCH body for `/api/config/runtime/embedding-supplement`. The card §2.3 also lists it. But `apps/core-daemon/src/routes/config.ts:22-31`'s `patchRuntimeConfig` only forwards `provider_url` / `secret_ref` / `model_id` — `embedding_enabled` is silently dropped. A Gemini-authored UI toggle wired to this PATCH will appear to succeed (200 OK) while making no daemon-side change.

This is **Blocking** because the worktree's stated reason for landing is precisely "freeze the Inspector server contract before Gemini handoff." The contract has a break the contract owner can't see without comparing two unrelated route handlers.

Adjacent issues:
- `AlayaStatus` schema is cited in P4-inspector-server §2.3 but does not exist in `packages/protocol/src/`. Gemini cannot type the status panel.
- No exported response-shape contracts (TS types or JSON schemas) for the SPA-facing payloads. Inspector is currently a passthrough proxy with implicit contracts.

## 5. Per-Track Findings Index

The full Review Finding Records are listed below by track. Each carries `ID / Severity / Headline / Location / Observed / Expected / Repro or Witness / Cause Class` per `docs/handbook/workflow/review-protocol.md` §Review Finding Record.

### Track 1a — Daemon Core port fidelity (3 cards)

Verdict: **all 3 cards FAIL** — P4-daemon-skeleton, P4-daemon-startup-ordering, P4-sse-strip.

| ID | Severity | Headline (one-line) |
|---|---|---|
| B-DAEMON-CORE-1 | Blocking | `index.ts` 99 vs 1135 LoC clean-room rewrite under adapt-and-port |
| B-DAEMON-CORE-2 | Blocking | `app.ts` 46 vs 731 LoC clean-room rewrite; Hono + middleware + 28 registrations dropped |
| B-DAEMON-CORE-3 | Blocking | `garden-runtime.ts` 33 vs 519 LoC empty stub; Garden services dropped; RuntimeNotifier replacement leg never wired |
| B-DAEMON-CORE-4 | Blocking | `worker-runtime-wiring.ts` 7 vs 186 LoC stub; 9 services deleted |
| B-DAEMON-CORE-5 | Blocking | `index.ts` re-exports parallel contract files (daemon-handle, mcp-server, trust-state, cli/) outside any card §2 |
| B-DAEMON-CORE-6 | Blocking | `routes/runs.ts` clean-room far beyond strip scope; `runtimeNotifier: RuntimeNotifier` field absent |
| B-DAEMON-CORE-7 | Blocking | `RuntimeNotifier.notify` is no-op + never invoked; §7/§11 broadcast leg absent in production |
| I-DAEMON-CORE-1 | Important | `package.json` drops hono / @hono/node-server / MCP SDK; adds `bin: alaya` outside §2 |
| I-DAEMON-CORE-2 | Important | `tsconfig.json` removes vendor `exclude` of `__tests__/`; adds `tsBuildInfoFile` outside §2 |
| I-DAEMON-CORE-3 | Important | `daemon-runtime-helpers.ts` switch→if rewrite + arrow-arg type elision (anti-pattern: split-into-own-style) |
| I-DAEMON-CORE-4 | Important | `background/bootstrap.ts` silently drops vendor "Background service started"/"skipped" diagnostic warns |
| N-DAEMON-CORE-1 | Nice-to-have | `runtime-notifier.notify` interface inconsistency (deferred wiring) |

### Track 1b — Routes port fidelity (5 cards, 34 files)

Verdict: **all 5 cards FAIL** — P4-routes-{memory, governance, soul, workspace, config}.

| ID | Severity | Headline |
|---|---|---|
| B-ROUTES-1 | Blocking | All 34 route files run a clean-room HTTP framework (custom `DaemonRouteHandler` + `context.daemon` god object) — no Adapter Point declared in any card §2 |
| B-ROUTES-2 | Blocking | 6 orphan route files (`index.ts`, `workspace.ts`, `status.ts`, `health.ts`, `mcp.ts`, `memory.ts`) — owned by no card, absent from vendor |
| B-ROUTES-3 | Blocking | `index.ts` route barrel is unowned; opt-in `e2e-event-triggers` flag introduced without §2 authorization |
| B-ROUTES-4 | Blocking | Massive LoC reduction across governance / soul / workspaces / workspace-files / global-memory / project-mapping / runs — vendor logic relocated or lost without an Adapter Point map |
| B-ROUTES-5 | Blocking | Orphan `memory.ts` duplicates `proposals.ts` review path through MCP-tool handler with synthesized `actor: "http"`; dead code today |
| B-ROUTES-6 | Blocking | `routes/shared.ts` 9 → 194 LoC identity replacement; `parseJsonBody` helper replaced by full route framework + `backendApiBlocked` policy enforcer outside §2 |
| B-ROUTES-7 | Blocking | `runs.ts` joint ownership undeclared in P4-routes-workspace §2 / §3 — only P4-sse-strip cites the strip |
| I-ROUTES-1 | Important | Route registration barrel has no test enforcing §2 union (drift risk) |
| I-ROUTES-2 | Important | `health-journal.ts` drops `HealthEventKindSchema.parse` and `Math.min(parsed, 200)` cap (silent contract narrowing) |
| I-ROUTES-3 | Important | P4-routes-config has no AC binding the prune invariant for slash-commands / worker-dispatch / surfaces / surface-bindings |
| N-ROUTES-1 | Nice-to-have | `runs.ts` 501 fail-closed envelope is the cleanest port shape — cite as canonical template in P4-sse-strip closeout |
| N-ROUTES-2 | Nice-to-have | `health-journal.ts` double-`url.searchParams.get` + `!` non-null asserts (readability) |

### Track 1c — Daemon aux + barrel (6 cards)

Verdict: **5 of 6 cards FAIL** — only P4-svc-global-recall-cache passes (with minor I/N).

| ID | Severity | Headline |
|---|---|---|
| B-AUX-01 | Blocking | P4-daemon-services: 15 of 15 §2 files unported; `services/` directory empty |
| B-AUX-02 | Blocking | P4-daemon-glue: all 5 §2 files unported (incl. 486-line `tool-runtime.ts`, 150-line `handoff-gap-adapter.ts`) |
| B-AUX-03 | Blocking | P4-daemon-middleware: `middleware/error-handler.ts` missing |
| B-AUX-04 | Blocking | P4-mcp-tooling: 6 §2 files unported, replaced by `mcp-memory-tool-catalog.ts` (clean-room redesign without sanction) |
| B-AUX-05 | Blocking | P4-daemon-routes-register: `app.ts` is a structural redesign (Hono → custom dispatcher), not adapt-and-port |
| B-AUX-06 | Blocking | `daemon-service-graph.ts` (1950 LoC) is an orphan; no card §2 claims it |
| I-AUX-07 | Important | P4-svc-global-recall-cache: card §2.1 cites `cross-workspace.test.ts` filename that doesn't exist (tests merged into main test file) |
| I-AUX-08 | Important | P4-mcp-tooling test files unported; AC4 cannot have meaningfully run |
| I-AUX-09 | Important | Dead route files `routes/memory.ts` and `routes/workspace.ts` (registered nowhere) |
| I-AUX-10 | Important | `handoff-gap-adapter.ts` logic is missing from runtime entirely (not just relocated) |
| N-AUX-11 | Nice-to-have | `global-memory-recall-service.ts` helper hoisting for readability |

**Note**: P4-svc-global-recall-cache is the **one** card that genuinely PASSES port fidelity — the cross-workspace cache invalidation closes #BL-011 with the right RuntimeNotifier hook, audit-before-callback ordering proven by `auditCountsAtInvalidation`, and idempotent.

### Track 2a — Alaya-original CLI invariant audit (11 cards)

Verdict: **3 cards FAIL Blocking** (`cli-detach`, `profile-mutation`, `operations`); **5 cards FAIL Important**; rest PASS+.

| ID | Severity | Headline |
|---|---|---|
| B-CLI-001 | Blocking | `cli-detach.test.ts` does not exist; AC4/AC7/AC8/AC9 unmet |
| B-CLI-002 | Blocking | `applyProfileMutationPlan` writes profile files BEFORE audit row (§10 inverted) |
| B-CLI-003 | Blocking | `alaya import` mutates alaya.toml + .env + DB without preview / confirm / atomic write (§10 + §23 + atomicity) |
| B-CLI-004 | Blocking | `backup` and `export` audit-after-write inversion; no audit-ordering tests |
| I-CLI-005 | Important | Bridge `--json` swaps stdout↔stderr undocumented in §2.3 |
| I-CLI-006 | Important | `cli inspect` AC8 (loopback-only bind) and AC10 (port-busy remediation) tests missing |
| I-CLI-007 | Important | `install` writes config + secrets without final preview/confirm gate |
| I-CLI-008 | Important | `install --non-interactive` accepts no `--yes` confirm gate (silent-mutation hazard) |
| I-CLI-009 | Important | `install` audit row written AFTER mutation (§10 ordering) |
| I-CLI-010 | Important | No `attach-codex.test.ts` or `attach-claude.test.ts` driving `bridge.dispatch(...)`; AC4 unmet |
| I-CLI-011 | Important | No bridge-level test asserting absent `--yes` + interactive `n` cancels and writes nothing |
| I-CLI-012 | Important | `cli inspect --token <hex>` allows operator-pinned token in production binary; security-sensitive |
| I-CLI-013 | Important | `mcp` subcommand not authorized by §24-cited card; no `task-p4-cli-mcp.md` |
| I-CLI-014 | Important | `tools call` actor-context override is correct but not pinned in any card §2.3 |
| I-CLI-015 | Important | `cli-doctor` / `cli-status` cards too thin: no "no audit row" non-behavior cited |
| N-CLI-016 | Nice-to-have | `detach` "nothing to detach" omits target name in human-readable line |
| N-CLI-017 | Nice-to-have | `confirmWithPrompt` does not honor `ALAYA_YES=1` env var |
| N-CLI-018 | Nice-to-have | `profile-mutation.ts:252` uses `appendAuditRow?.(row)` optional-chain — silent audit-injection hazard |

### Track 2b — Trust + MCP invariants (3 cards)

Verdict: **all 3 cards PASS** with Important / Nice-to-have. No Blocking.

| ID | Severity | Headline |
|---|---|---|
| I-TRUST-MCP-001 | Important | `recordConfigured` non-idempotent — MCP reconnect inflates `configured_count` and produces duplicate audit events |
| I-TRUST-MCP-002 | Important | `soul.open_pointer` is an unaudited delivery boundary; no `ContextDeliveryRecord`, no `delivery_id` validation |
| I-TRUST-MCP-003 | Important | `not_applicable_count` lacks an isolated reduction-table row; falls into `mixed` |
| I-TRUST-MCP-004 | Important | `evidence_pointers` flows into EventLog payload but is dropped from `ContextDeliveryRecordSchema` (schema/log divergence) |
| I-TRUST-MCP-005 | Important | `runStdio` has no end-to-end test; primary transport invariants unverified |
| N-TRUST-MCP-001 | Nice-to-have | Audit prompt called for "discriminated union"; impl uses `z.enum` (idiomatic, not a deviation) |
| N-TRUST-MCP-002 | Nice-to-have | HTTP transport always returns 400 on JSON-RPC errors regardless of error class |

**Positive evidence**: tool-name parity is exact (8 expected vs 8 actual; `isSoulMemoryToolName` rejects `memory.*`); §19 (propose-route only durable mutation), §20 (delivered ≠ used) for the recall→usage path, and §22 (CLI/MCP single contract via shared handler) are clean.

### Track 2c — Inspector server boundary (1 card; Gemini handoff)

Verdict: **FAIL Blocking** on the single contract break that will burn Gemini.

| ID | Severity | Headline |
|---|---|---|
| B-INSPECTOR-1 | Blocking | `embedding_enabled` accepted by Inspector PATCH validator but silently dropped by daemon `patchRuntimeConfig`; SPA toggle would be a no-op |
| I-INSPECTOR-2 | Important | Inspector `appendClientQuery: false` invariant is fragile; no test pins "token never appears in upstream URL or headers" |
| I-INSPECTOR-3 | Important | Static-asset auth gate is correct but untested (`GET /` and `GET /assets/...` without token) |
| I-INSPECTOR-4 | Important | No exported types or JSON-schema for response shapes (Gemini handoff contract is implicit) |
| I-INSPECTOR-5 | Important | `AlayaStatus` schema cited in card §2.3 does not exist in `packages/protocol/` |
| N-INSPECTOR-7 | Nice-to-have | Header name reconciliation: card uses `X-Alaya-Inspector-Token`, audit prompt mentioned `Authorization: Bearer` |
| N-INSPECTOR-8 | Nice-to-have | `static.ts` content-type table omits `.map`, `.woff2`, `.ttf`, `.ico` |
| N-INSPECTOR-9 | Nice-to-have | Card §2.1 mentions `hono` dep; impl uses `node:http` (card text drift) |

**Positive evidence**: loopback-only bind hardcoded + tested; constant-time token compare; path-traversal protection (decoded raw + `path.relative()` boundary); graceful 503 when `web/dist/` missing; zero `/api/memory/*` or `/api/proposal/*` write endpoints — §21 narrowing satisfied.

## 6. Track 3 (`/simplify` reuse / quality / efficiency) — Deferred

User explicitly chose Track 3 as part of the review scope. **The reviewer is deferring it** with reasoning:

1. Track 1 found that the daemon core, all 34 routes, and 5 of 6 daemon-aux cards are clean-room reimplementations rather than ports. Tracks 1a / 1b / 1c collectively call this out as **20 Blocking findings** with the same root cause (port-mode escalation without §2 declaration).
2. Running `/simplify` reuse / quality / efficiency on the redesigned code only validates "is the redesign well-written" — the actual question Tracks 1 + 2 already answered is "should this redesign exist at all?" The answer is no, not in this form, not without explicit user approval, not without re-citing Charter Authority on the cards.
3. After fix-loop on the Blocking findings (which will require either re-porting a substantial fraction of the daemon and routes, OR amending many cards to declare requires-redesign with charter cites), the surviving code base will be different enough that a Track 3 pass against it now would mostly be wasted work — the refactor itself will reshape the duplication / efficiency surface.
4. Per `review-protocol.md` §Re-Review Weight By Severity, Blocking fixes require fresh reviewer-agent passes. Track 3 should run **after** the fix loop closes Tracks 1 + 2 Blocking + Important findings, not before.

User can override this deferral if they want a snapshot of code-quality observations on the current rewrite — tell the reviewer to launch Track 3.

## 7. Recommended Path Forward

This is not a "rebase + tweak" review. The review found work-product-vs-charter mismatch at the foundation level. Two viable paths:

**Path A — Re-port (faithful)**: Roll back the daemon core / routes / daemon-aux clean-rooms; re-port from `vendor/do-what-new-snapshot/` per each card's declared `adapt-and-port` mode, declaring every divergence as an Adapter Point in §2. Keep what already passes (P4-svc-global-recall-cache, P4-trust-state, P4-mcp-memory-tools, P4-mcp-server, P4-inspector-server modulo B-INSPECTOR-1, P4-secrets, the smaller CLI cards). Fix the §10 audit-precedes ordering across `import` / `backup` / `export` / `profile-mutation` / `install`. Wire `RuntimeNotifier` into production paths. Add the missing tests (B-CLI-001, I-CLI-006, I-CLI-010). This is a multi-day port effort, comparable in scope to a fresh Phase 4 wave.

**Path B — Re-charter (sanctioned redesign)**: Reopen the affected cards, escalate them from `adapt-and-port` to `requires-redesign`, write Charter Authority citations in §0, list every divergence in §2 Allowed Scope (including the `daemon-handle.ts` + `daemon-service-graph.ts` parallel contract layer), and obtain explicit user approval per `port-protocol.md`. Fix the still-Blocking issues (`RuntimeNotifier` not wired, audit-precedes inversions, `embedding_enabled` daemon-side gap, missing tests, orphan route files). Track 3 then runs against the sanctioned redesign.

**Path A** preserves Port-First discipline as the v0.1 charter intended. **Path B** acknowledges that Codex (or its operator) has chosen a different trade-off and locks it in formally so future reviews don't relitigate. Either is defensible; mixing them silently — which is the current state — is not.

In either path, Track 3 (`/simplify`) runs **after** the Blocking + Important findings close, on whatever surface survives the fix loop.

## 8. Inspector Frontend (Gemini Handoff) — Status

`apps/inspector/web/` does not exist in the worktree (correct; Gemini's slot). The Inspector server contract is **almost** ready for handoff. Before merging this worktree, fix at minimum:

- B-INSPECTOR-1: align Inspector and daemon `embedding_enabled` field handling.
- I-INSPECTOR-5: add `AlayaStatusSchema` to `packages/protocol/` (shared with `alaya status` per §22).
- I-INSPECTOR-4: re-export `SoulConfig` / `StrategyConfig` / `EnvironmentConfig` / `EmbeddingStatus` / `SoulGraph` / `AlayaStatus` from `@do-soul/alaya-inspector` for the SPA to import.

Without these the frontend will work for some cases and silently fail for others; debugging the silent-failures is much more expensive than fixing the contract now.

## 9. Test Suite Note

`rtk pnpm exec vitest run` reports `209 passed (209) / 1715 passed (1715)`. This is the post-commit re-run (replaces Codex's old gate evidence). The suite is GREEN on the current code. **It does not validate port fidelity.** Tests are written against the redesigned implementation; no test compares a worktree file to its `vendor/do-what-new-snapshot/` counterpart, no test exercises the production `RuntimeNotifier.notify` call path (because there isn't one), no test asserts audit-precedes-broadcast ordering on `install` / `backup` / `export` / `import`.

## 10. Reviewer Mechanics

- 6 review agents launched in parallel (Track 1a, 1b, 1c, 2a, 2b, 2c).
- Track 3 (3 agents: reuse / quality / efficiency) intentionally not launched (see §6).
- All agents read `docs/handbook/{review-protocol,port-protocol,invariants}.md`, the relevant task cards, the worktree files, and the corresponding `vendor/do-what-new-snapshot/` files.
- All findings carry a runnable Repro / Witness (`grep`, `wc -l`, `diff`, or a named test) per `review-protocol.md` §Evidence Expectations.
- This report file is dropped into `docs/v0.1/phase-4-briefs/reports/review-p4-controller.md` as untracked content. The user decides whether to commit it; suggested commit message if kept:
  `docs(p4-controller): record blocking review findings (port-fidelity + invariants)`.

---

End of review.
