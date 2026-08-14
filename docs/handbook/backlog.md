# Backlog

Cross-phase unresolved issues that are **not** the recall-field landing.
Recall algorithm work (UGAF target vs live degenerate projection) lives in
[`recall.md`](recall.md).
Do not add a fusion stream, ranker, promoter, or weight/cap retune from
this list — that is the UGAF §1.1 failure mode.

Scheduled work keeps detailed acceptance criteria in the owning phase
README or task card. Resolved issues are archived to
`docs/archive/backlog-resolved-historical.md`.

## Issue Numbering

Issues are numbered `#BL-NNN` in plain decimal sequence.
**Next available number**: `#BL-069`.

**2026-08-14**: `#BL-047` superseded (would add another fusion ranker);
`#BL-060` moved to resolved (close condition already met 2026-07-30).
**2026-08-14 triage**: `#BL-053` closed (host-worker `EDGE_CLASSIFY`);
`#BL-064` closed (LongMemEval domain layout). Remaining open items
retargeted to HEAD `10da1318` paths. Audit leftovers below are
engineering debt, not recall-field work.

---

## Open Issues

### #BL-051 — Abstention calibration verdict on a 500q archive

**Status**: Open (deferred; opened v0.3.11). **Due**: a recorded calibration verdict, not another threshold bump.

**Context**: Abstention is bench-scoring only
(`apps/bench-runner/src/longmemeval/diagnostics/abstention.ts`). HEAD
`10da1318` has no production `abstain` path under `packages/core` or
`apps/core-daemon`. A tracked full LongMemEval-S archive already exists:
`docs/bench-history/public/2026-06-24T121950Z-efc68f5-policy-stress/kpi.json`
(`evaluated_count=500`, `miss_distribution.abstain_false_confident=6`).
The original `=9` figure is stale. Official 500Q promotion is still not
claimed (`runtime-snapshot.md`). Remaining work is the verdict against
that class of archive, not "waiting for 500q data."

**Close condition**: against a full 500q archive, either land a calibrated
evidence-strength signal or record "calibration inert on real corpus".

### #BL-052 — Wire LongMemEval CI sample-floor (was #BL-040)

**Status**: Open (re-opened as scale-up; v0.3.11). **Due**: when a CI host can hold a category-balanced floor.

**Context**: `.github/workflows/ci.yml` runs typecheck / build / test /
hygiene / smoke. It does not run LongMemEval. Wilson labels treat
`evaluatedCount >= 500` as `full`
(`packages/eval/src/metrics/wilson-ci.ts:90-95`). A tracked 500q
recall-eval archive exists (see `#BL-051`); that does not wire a
sample-floor into CI.

**Close condition**: CI runs a category-balanced LongMemEval sample-floor
at or above the confidence-interval threshold without OOM.

### #BL-054 — Lease-pierce `ToolGovernanceClient` invalidation hook

**Status**: Open (deferred; v0.3.11). **Due**: revisit if `ToolGovernanceClient` is constructed on a production hot path.

**Context**: `GovernanceLeaseService.pierce` appends
`soul.governance_lease.pierced` and clears its own lease map
(`packages/core/src/governance/policy/governance-lease-service.ts:143-176`).
`ToolGovernanceClient.invalidateNode` is the API a pierce hot-path hook
would call (`packages/core/src/ports/tool-governance-client.ts:65-71`).
On HEAD `10da1318`, `new ToolGovernanceClient` exists only in tests;
`invalidateNode` has no production caller; `packages/core/src/recall/`
does not import the client. `createConversationToolExecutor` voids the
injected client
(`apps/core-daemon/src/runtime/daemon/support/conversation-tool-executor.ts:18`).
Kept open because the original close condition gates "not-needed" on
v0.3.12, which has not shipped (package version still `0.3.11`).

**Close condition**: close as not-needed if the client stays unconstructed
and off the recall hot path through v0.3.12; otherwise land pierce →
`invalidateNode` with a test.

### #BL-057 — Warm-workspace witness for recall priors

**Status**: Open (v0.3.11; residual measurement, not a fusion-lane add).

**Context**: No dedicated warm-seeding A/B harness exists. Archive
schema accepts `longmemeval-cold-warm-comparison.json`
(`apps/bench-runner/src/longmemeval/archive/archive-evidence.ts:30-31`);
that is a sidecar name, not a prior-witness run. Official 500Q
promotion is still not claimed. Do not close this by retuning fusion
weights, caps, or cutoffs (UGAF §1.1 / anti-fitting).

**Close condition**: a warm-seeding A/B, or a "warm-neutral on real
corpus" verdict against a full archive. Not a new ranker.

### #BL-061 — Audit structural/SRP split wave

**Status**: Open (first card landed 2026-07-07; paths retargeted 2026-08-14). **Due**: before v0.3 stable.

**Context**: Named units still exist after domain moves; on HEAD
`10da1318` each listed *file* is under the 500-line source cap, but
function-length / per-owner regression close is unpaid
(`NOT_VERIFIED` this pass — tests not run). Current homes:

- `packages/core/src/governance/reconciliation/pre-write-recall-service.ts` (220)
- `packages/storage/src/repos/memory-entry/sqlite-memory-entry-repo.ts` (417)
- `packages/core/src/health/green-service.ts` (322)
- `packages/storage/src/repos/runtime/event-log-repo.ts` (472) plus split helpers under `event-log/`
- `packages/storage/src/repos/memory-entry/memory-entry-statement-groups.ts` (479)
- `MemoryService` → `packages/core/src/memory/memory-service/service.ts:21` (286); barrel `memory-service.ts` is 15 lines
- `apps/core-daemon/src/runtime/app.ts` (466); security middleware already extracted to `apps/core-daemon/src/middleware/register-security-middleware.ts` (46)
- `packages/storage/src/index.ts` (343) remains a broad barrel

**Close condition**: listed units meet `AGENTS.md` §Code quality size
and layout limits (file and function), preserve package dependency
direction, and pass focused regression tests for each moved owner.

### #BL-062 — Audit API ergonomics cleanup wave

**Status**: Open (first slice landed 2026-07-07). **Due**: next compatibility window.

**Context**: `readSecretLine` has `{ isTTY }` options plus a deprecated
boolean overload (`apps/core-daemon/src/cli/install/masked-stdin.ts:11-38`)
and `masked-stdin-migration.test.ts`. Remaining on HEAD `10da1318`:
CLI `as unknown as Readable/Writable`
(`apps/core-daemon/src/cli/register.ts:398-399`);
`EventPublisherEventLogRepoPort.getStorageConnectionIdentity(): object`
(`packages/core/src/runtime/event-publisher.ts:23-24`). Boolean-trap
and `object` return cleanup beyond that slice is unpaid.

**Close condition**: replace remaining reported boolean parameters with
option objects, tighten `getStorageConnectionIdentity` off a bare
`object`, remove CLI stream double-casts, and add migration tests for
affected public call sites.

### #BL-063 — Audit test/CI infrastructure hardening

**Status**: Open (route coverage and OS matrix landed; remainder unpaid). **Due**: before release-candidate gate.

**Context**: Cross-platform CI matrix is live
(`.github/workflows/ci.yml:26-44`, ubuntu / macos / windows Node 24;
landed `2082994a`). `routes-audit-coverage.test.ts` exists.
Coverage job runs on ubuntu (`ci.yml:71-73`). Still true on HEAD
`10da1318`: `scripts/ci/run-vitest-projects.mjs:29-48` runs projects
sequentially; several tests still `vi.spyOn(console, "warn").mockImplementation`;
wall-clock vs fake-timer sweep and "listed zero-coverage files no
longer at 0%" are `NOT_VERIFIED` this pass (coverage not run).

**Close condition**: warning-producing tests assert or filter expected
warnings, flaky wall-clock checks use fake timers or bounded pollers,
CI keeps the selected cross-platform matrix, and coverage reports show
the listed zero-coverage files no longer at 0%.

### #BL-066 — Remaining audit low-risk hardening

**Status**: Open (partial landing 2026-07-07). **Due**: opportunistic hardening wave.

**Context**: `bestEffortDelete` rollback diagnostics remain at
`apps/core-daemon/src/routes/workspace/files/files.ts:434-450`
(`ALAYA_FILE_UPLOAD_ROLLBACK_DELETE_FAILED`). Unpaid grab-bag on HEAD
`10da1318`: EventLog append retry (no production retry helper under
`packages/storage/src/repos/runtime/`); `EventLogBackedCache` still has
no TTL/max (`packages/core/src/governance/cache/event-log-backed-cache.ts`,
also `#BL-068`); FTS token policy lives in
`packages/protocol/src/soul/fts-search-policy.ts` (review, not deletion);
Garden raw-signal salvage exists
(`packages/soul/src/garden/official-api/raw-signal-envelope.ts:59`).
Hardcoded tuning constants and remaining silent-catch/void-promise
diagnostics are `NOT_VERIFIED` as a complete inventory this pass.

**Close condition**: each item is either closed as stale with file-level
evidence or lands a targeted regression; no silent catch in critical
paths remains without an explicit diagnostic.

### #BL-067 — MCP external runtime authentication and endpoint policy

**Status**: Open (destructive builtin confirmation and env runtime narrowing landed 2026-07-07). **Due**: before enabling arbitrary external MCP servers.

**Context**: Env-sourced MCP stdio configs are dropped
(`apps/core-daemon/src/mcp/catalog/mcp-catalog-parsing.ts:128-132`);
HTTP env endpoints must be loopback
(`mcp-catalog-parsing.ts:146,170-187`). Destructive builtin tools still
require a server-verifiable confirmation receipt
(`apps/core-daemon/src/mcp/tool-runtime/tool-runtime.ts:170-188`).
That is not a handshake/session authentication layer for every builtin
read/list/search call, and it does not define trust for arbitrary
external stdio or non-loopback HTTP MCP servers.

**Close condition**: External MCP sessions authenticate at connection or
tool-call boundary with a daemon-owned bearer/capability token, every
builtin conversation tool rejects unauthenticated calls in an
integration test, env-provided external endpoints and headers have an
explicit trust policy, documented host attach profiles pass the token,
and unauthenticated legacy clients fail with a typed auth error.

### #BL-068 — Bound audit-reported in-memory caches

**Status**: Open (classification corrected 2026-07-07; symbols retargeted 2026-08-14). **Due**: v0.3 hardening window.

**Context**: `ContextLensAssembler.lensStore` is bounded by expiry and
`MAX_LENS_STORE_SIZE` (`packages/core/src/conversation/context-lens-assembler-ports.ts:23`,
`context-lens-assembler.ts:371-378`). `EventLogBackedCache` still has
unbounded `store`, `pendingLoads`, and `versions` maps (audit name
`cacheVersions`) with no max-size/TTL
(`packages/core/src/governance/cache/event-log-backed-cache.ts:5-7,20-22`).
`ToolGovernanceClient` is LRU-capped at 500
(`packages/core/src/ports/tool-governance-client.ts:130-131`) but is
not constructed in production (see `#BL-054`). Separate from the SQLite
worker queue.

**Close condition**: every cache named in the 2026-07-06 audit is
classified as bounded/stale or gets an explicit max-size/TTL/idle-prune
policy with regression tests covering eviction and no loss of durable
truth.


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
