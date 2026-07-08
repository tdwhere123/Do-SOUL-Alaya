# Backlog

Cross-phase unresolved issues. Scheduled work keeps detailed acceptance
criteria in the owning phase README or task card. Resolved issues are
archived to `docs/archive/backlog-resolved-historical.md`.

## Issue Numbering

Issues are numbered `#BL-NNN` in plain decimal sequence.
**Next available number**: `#BL-069`.

**Audit branch progress (2026-07-07)**: `#BL-065` resolved; `#BL-060`–`#BL-064` and
`#BL-066`–`#BL-068` have partial landings documented below.

---

## Open Issues

### #BL-051 — Abstention calibration re-test on 500q data

**Status**: Open (deferred to R5 data; opened v0.3.11). **Due**: after the R5 big-machine 500q gate.

**Context**: `abstain_false_confident=9` misses are a calibration question, not a threshold-bump. Re-test needs real 500q data, gated on the big-machine R5 run.

**Close condition**: re-evaluate against R5 500q cached archive; either land a calibrated evidence-strength signal or record "calibration inert on real corpus".

### #BL-052 — Scale LongMemEval CI sample-floor (was #BL-040)

**Status**: Open (re-opened as scale-up; v0.3.11). **Due**: after a larger CI host is available.

**Context**: CI sample-floor still runs small because 500q full bench OOMs on the 7.6 GB WSL2 box. Needs a larger CI host (same constraint that defers the R5 gate).

**Close condition**: a larger CI host runs a category-balanced sample-floor at or above the confidence-interval threshold without OOM, wired into the CI gate.

### #BL-053 — Edge `llm_supports` LOCAL pair-classifier (host-worker / ONNX)

**Status**: Open (deferred; v0.3.11). **Due**: revisit alongside local ONNX cache work.

**Context**: `EdgeAutoProducerService` accepts an optional in-process pair-classifier port, but a LOCAL (host-worker / ONNX) classifier producing `llm_supports` is not yet built. Local rule heuristic tags `local_*` only.

**Close condition**: a local pair-classifier produces confidence-floor-clearing `llm_supports` verdicts offline, with a no-network regression.

### #BL-054 — Lease-pierce governance-cache hot-path hook

**Status**: Open (deferred; v0.3.11). **Due**: revisit if governance cache moves onto the production recall hot path.

**Context**: Lease-pierce invalidation hook for the governance cache was scoped during D-LEASE. The governance cache is NOT on the production recall hot path today, so the hook is moot. Kept open to preserve the dependency.

**Close condition**: close as not-needed if the cache stays off the hot path through v0.3.12; otherwise land the hook with a test.

### #BL-047 — `multi_hop_path` as a dedicated recall fusion stream

**Status**: Open (deferred by explicit operator decision, v0.3.11).

**Context**: Multi-hop traversal already exists (2-hop BFS folds into `graph_expansion`). `multi_hop_path` would give multi-hop candidates their own dedicated fusion lane. Lowest-ROI item in the D-series.

**Close condition**: revisit if a 500q root-cause diagnostic shows multi-hop gold drowned inside `graph_expansion` and needing a separate lane.

### #BL-057 — Warm-workspace witness for base-weight recall priors

**Status**: Open (v0.3.11; residual from B2 fusion-prior correction).

**Context**: B2 subordinated non-evidence fusion streams to base weight. A warm-seeding A/B harness does not exist (same constraint as R5 gate / #BL-052).

**Close condition**: a warm-seeding A/B confirms no warm recall regression from base-weight priors; or "warm-neutral on real corpus" verdict against R5 archive.

### #BL-060 — SQLite worker queue for blocking storage operations

**Status**: Open (design spike landed 2026-07-07). **Due**: after S7 async SQLite comparison is reviewed.

**Context**: The daemon still uses synchronous `better-sqlite3` on the main thread. S7 added a blocking probe, tail-latency test, bench driver, and doctor storage-growth advisory, but moving writes or heavy cleanup into a worker-thread queue is a larger storage architecture migration that must preserve EventLog-first transaction ordering. Branch landed typed port stub `packages/storage/src/sqlite/write-queue-port.ts` and contract test.

**Close condition**: a worker-thread write queue or reviewed async SQLite replacement keeps EventLog-first / transaction-CAS invariants intact and improves concurrent recall tail latency against the S7 witness.

### #BL-061 — Audit structural/SRP split wave

**Status**: Open (first card landed 2026-07-07). **Due**: before v0.3 stable.

**Context**: The audit flagged large units and broad facades that are real maintainability debt but unsafe to mix into the security/stability remediation branch: `pre-write-recall-service.ts`, `sqlite-memory-entry-repo.ts`, `green-service.ts`, `event-log-repo.ts`, `memory-entry-statement-groups.ts`, `MemoryService`, `app.ts`, and broad storage barrels. Branch extracted security middleware wiring to `apps/core-daemon/src/middleware/register-security-middleware.ts` (−43 lines from `app.ts`).

**Close condition**: split the listed units under the SRP thresholds in `AGENTS.md`, preserve package dependency direction, and pass focused regression tests for each moved owner.

### #BL-062 — Audit API ergonomics cleanup wave

**Status**: Open (first slice landed 2026-07-07). **Due**: next compatibility window.

**Context**: Boolean trap parameters, single-letter names, `object` return types, CLI `as unknown as Readable/Writable`, and switch-heavy routing helpers are low-to-medium API clarity issues. They require compatibility review and call-site migration rather than a drive-by patch. Branch migrated `readSecretLine` to `{ isTTY }` options with deprecated boolean overload + migration test.

**Close condition**: replace the reported boolean parameters with option objects, tighten the `EventPublisherEventLogRepoPort.getStorageConnectionIdentity` opaque type, remove CLI stream double-casts, and add migration tests for affected public call sites.

### #BL-063 — Audit test/CI infrastructure hardening

**Status**: Open (route coverage landed 2026-07-07). **Due**: before release-candidate gate.

**Context**: The audit called out console warning suppression, over-mocked tests, wall-clock timeout assertions, single-OS coverage, serial project execution, and residual uncovered route/CLI branches. Branch added `routes-audit-coverage.test.ts`, MemoryQueryService tests, engine-gateway auth edge cases, and score/source-proximity diagnostic tests. Cross-platform CI matrix and console.warn assertion sweep remain.

**Close condition**: warning-producing tests assert or filter expected warnings, flaky wall-clock checks use fake timers or bounded pollers, CI runs the selected cross-platform matrix, and coverage reports show the listed zero-coverage files no longer at 0%.

### #BL-064 — LongMemEval source tree organization

**Status**: Open (blocked on benchmark archive; 2026-07-07). **Due**: after current benchmark evidence is archived.

**Context**: `apps/bench-runner/src/longmemeval/` is intentionally active and currently flat. Moving 70+ files during audit remediation would make benchmark diffs harder to review and risks invalidating in-flight evidence paths. No tracked `docs/bench-history/latest-*.json` pointer refresh observed on branch — reorg deferred.

**Close condition**: move LongMemEval files into domain subdirectories, update imports/scripts/docs, and run the recall-only benchmark preflight plus targeted LongMemEval tests.

### #BL-066 — Remaining audit low-risk hardening

**Status**: Open (partial landing 2026-07-07). **Due**: opportunistic hardening wave.

**Context**: Remaining low/medium audit items include hardcoded tuning constants, FTS/content length policy review, optional TTL policy for DB cache metadata, EventLog append retry policy, Garden raw input validation review, and broad catch/void-promise diagnostics. Branch landed `bestEffortDelete` rollback diagnostics (`ALAYA_FILE_UPLOAD_ROLLBACK_DELETE_FAILED`) in `apps/core-daemon/src/routes/workspace/files.ts` with regression test.

**Close condition**: each item is either closed as stale with file-level evidence or lands a targeted regression; no silent catch in critical paths remains without an explicit diagnostic.

### #BL-067 — MCP external runtime authentication and endpoint policy

**Status**: Open (destructive builtin confirmation and env runtime narrowing landed 2026-07-07). **Due**: before enabling arbitrary external MCP servers.

**Context**: The audit branch added server-verifiable confirmation receipts for builtin tools that mutate state or execute commands. Env-sourced MCP runtime config no longer spawns stdio commands and only accepts loopback HTTP(S) endpoints. This does not implement a full MCP handshake/session authentication layer for every builtin read/list/search call, nor does it define the trust model for arbitrary external stdio or HTTP MCP servers; adding that layer changes host compatibility and belongs in a dedicated protocol migration.

**Close condition**: External MCP sessions authenticate at connection or tool-call boundary with a daemon-owned bearer/capability token, every builtin conversation tool rejects unauthenticated calls in an integration test, env-provided external endpoints and headers have an explicit trust policy, documented host attach profiles pass the token, and unauthenticated legacy clients fail with a typed auth error.

### #BL-068 — Bound audit-reported in-memory caches

**Status**: Open (classification corrected 2026-07-07). **Due**: v0.3 hardening window.

**Context**: `ContextLensAssembler.lensStore` is bounded by expiry and `MAX_LENS_STORE_SIZE`, but the audit-reported session-override maps (`store`, `pendingLoads`, `cacheVersions`) and other long-lived core maps still need explicit owner review. This is separate from the SQLite worker queue and from generic low-risk hardening because the acceptance surface is bounded memory growth on daemon-long-lived in-memory caches.

**Close condition**: every cache named in the 2026-07-06 audit is classified as bounded/stale or gets an explicit max-size/TTL/idle-prune policy with regression tests covering eviction and no loss of durable truth.


## Out of Alaya Scope (Permanently Rejected)

These would never enter Alaya's roadmap. Each entry documents *why*:

- **#BL-001 — Frontend GUI**: not in Alaya scope. Memory Inspector is the only Alaya-side UI; agent-flow UIs belong to the consuming agent. See invariant §21.
- **#BL-002 — Conversation TUI**: consuming agent's responsibility.
- **#BL-003 — `apps/tui/` upstream port**: no Alaya counterpart.
- **#BL-004 — ConversationService chat-specific orchestration**: dropped during v0.1 port.
- **#BL-005 — `packages/ui-sdk/`**: no shared HTTP client surface justifies a dedicated SDK.
- **#BL-006 — `packages/surface-runtime/`**: Alaya has no agent UI requiring a shared surface reducer.
- **#BL-007 — Daemon SSE pipeline**: stripped per invariant §11.

---

## Issue Format

```markdown
### #BL-NNN — <one-line title>

**Status**: <Open | Deferred | Resolved>
**Close condition**: <what acceptance test must pass>

<one-paragraph context>
```

Per Anti-Tail Rule R2, every deferral from a task card MUST cite a numbered backlog issue here.
