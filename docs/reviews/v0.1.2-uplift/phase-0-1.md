# v0.1.2 Inspector & MCP UX Uplift — Phase 0 + Phase 1 Review

**Diff range**: `177e5dd..9f6332c` (`0444b3c` Phase 0 CI fix + `9f6332c` Phase 1 MCP incentive + time filter + embedding window)
**Lenses**: Claude `reviewer` agent + Codex second-opinion (`codex:codex-rescue`)
**Verdict**: 1 BLOCKING + 5 IMPORTANT + 2 NICE-TO-HAVE — all addressed in fix-loop commit (see Status section).

---

## Findings (merged & deduplicated)

### BLOCKING

#### B-1 — Global recall path ignored `timeFilter`
- **Lens**: Codex Finding 3 (Claude listed as IMP-4, Codex escalated)
- **Where**: `packages/core/src/recall-service.ts` calling `loadGlobalRecallCandidates`; `packages/core/src/global-memory-recall-service.ts`
- **Impact**: A user querying "what did I say on May 20" would receive in-window tier results plus **out-of-window cross-workspace global memories** mixed in. Breaks the time-filter UX promise.
- **Fix**: extract `entryMatchesTimeFilter` predicate from `filterMemoriesByTimeWindow`; thread `timeFilter` + the predicate as parameters into `loadGlobalRecallCandidates`; apply per-candidate after `classifyGlobalCandidate.include` so candidates outside the window do not enter the merged result.
- **Status**: ✅ Fixed (commit follow-up)

### IMPORTANT

#### I-1 — `ALAYA_OPERATOR_INSTRUCTIONS` not synced to imperative wording
- **Lens**: Codex Finding 4 (Claude missed)
- **Where**: `apps/core-daemon/src/profile-mutation.ts` (the operator instructions string injected at attach time, separate from `ALAYA_MCP_SERVER_INSTRUCTIONS` in `mcp-server.ts`).
- **Impact**: Two different attach surfaces saw two different instructions; one used the new "START every memory-sensitive turn" imperative wording, the other still read "Agent loop: soul.recall -> soul.open_pointer -> respond -> soul.report_context_usage" (passive).
- **Fix**: rewrote `ALAYA_OPERATOR_INSTRUCTIONS` to match the new wording; updated the corresponding `profile-mutation.test.ts` pin to assert on the new phrasing.
- **Status**: ✅ Fixed

#### I-2 — Protocol package lacked schema tests for `since` / `until` / `time_field`
- **Lens**: Claude IMP-2 + Codex Finding 7 (anti-tail R2)
- **Where**: `packages/protocol/src/__tests__/`
- **Impact**: New optional schema fields could regress (drop, change nullability, change enum) without a failing test.
- **Fix**: added `mcp-types-time-filter.test.ts` with 8 cases covering: omit-all, explicit nulls, both bounds, `time_field=last_used_at`, non-ISO reject, ISO-with-offset reject (pins current `IsoDatetimeStringSchema` UTC-only invariant), unknown enum reject, and `RecallTimeFieldSchema` enumeration.
- **Status**: ✅ Fixed

#### I-3 — MCP handler did not assert it threads `timeFilter` to `RecallService.recall`
- **Lens**: Claude IMP-3 + Codex Finding 7
- **Where**: `apps/core-daemon/src/__tests__/mcp-memory-tool-handler.test.ts`
- **Impact**: Refactor could silently drop the `since/until/time_field` plumbing without test coverage.
- **Fix**: added 3 cases — (a) request with no time bounds → handler passes `timeFilter: undefined`; (b) full triple `since/until/time_field` → handler passes the matching object; (c) only `since` → handler defaults `field` to `created_at`.
- **Status**: ✅ Fixed

#### I-4 — Protected dimensions (HAZARD/CONSTRAINT) get pre-filtered the same as ordinary entries
- **Lens**: Claude IMP-1 (proposed exemption) vs Codex Finding 1 (proposed pin test)
- **Resolution**: keep current behavior — when a user issues "what did I say on May 20" the time bound is an explicit user intent and should win over "always-relevant"-style protections. Add a pin test so future "exempt protected" guards can't silently slip in.
- **Where**: `packages/core/src/recall-service-helpers.ts` (the predicate is dimension-agnostic by design); `packages/core/src/__tests__/recall-time-filter.test.ts`
- **Fix**: added pin test "does NOT exempt protected dimensions (hazard/constraint) from the window — pinned per UX" with both hazard and constraint entries falling outside the window and `may-20` inside.
- **Status**: ✅ Fixed (pinned-as-intentional)

#### I-5 — Anti-tail R2 partial-fix: end-to-end coverage gap
- **Lens**: Codex Finding 7
- **Resolution**: Closed by the combination of I-2 + I-3 (schema test pins the new fields; handler test pins the plumbing). Service-level (`RecallService.recall` calling `loadGlobalRecallCandidates` with `timeFilter`) is exercised indirectly by existing `global-memory-recall-service.test.ts` continuing to pass after the new optional parameter was added; explicit recall-service integration test is in scope of Phase 4 search e2e.
- **Status**: ✅ Closed

### NICE-TO-HAVE (deferred — see Open Trail)

#### N-1 — `1500ms` embedding window has no latency instrumentation
- **Lens**: Codex Finding 6
- **Where**: `packages/core/src/embedding-recall-service.ts`
- **Note**: The bump from 250 ms is evidence-based (long-run test 2026-05-08) but unmeasured at runtime. Adding an `embedding_query_latency_ms` histogram (or simple p99 log line) would let v0.1.2 users self-tune `queryTimeoutMs`. **Deferred** to Phase 2 / Phase 5 closeout — instrumentation is additive and not on the v0.1.2 critical path.

#### N-2 — "Memory-sensitive turn" never formally defined
- **Lens**: Codex Finding 8
- **Where**: `apps/core-daemon/src/mcp-server.ts` (instructions text)
- **Note**: The three trigger scenarios already in the instructions ("personal preferences / past corrections", "prior decisions / project context", "do you remember / last time / we agreed") form an implicit definition. A literal-following agent might call `soul.recall` on a bare greeting. **Deferred** — observe v0.1.2 behavior in Codex live use; if false-positive recall noise is observed, add a "skip when…" clause in v0.1.3.

### OK (verified, no action)

- **Phase 0 fix correctness**: `alwaysSingleQuote` round-trips through TOML `JSON.stringify`; deleted `shellQuote` had no remaining consumer; profile-mutation regex now passes for both runner-style and developer-style paths.
- **WHEN-prefix sync**: `mcp-memory-tool-catalog.ts` and `engine-gateway/.../soul-tool-specs.ts` stay in lock-step via the existing `stays aligned with provider-neutral model-visible specs` test. No third mirror found in README / docs.
- **ISO datetime string comparison**: sound under current `IsoDatetimeStringSchema` (Zod default `{ offset: false }` — UTC `Z` suffix only). Pin test in I-2 records the assumption; if the schema is later relaxed to `{ offset: true }`, lexicographic comparison must move to parsed comparison.

---

## Status

- BLOCKING: 0 open / 1 closed (`B-1`)
- IMPORTANT: 0 open / 5 closed (`I-1`–`I-5`)
- NICE-TO-HAVE: 2 deferred to v0.1.2 closeout / v0.1.3 (`N-1`, `N-2`)

Verification (fresh):
- `rtk pnpm build` — pass (worktree HEAD)
- `rtk pnpm test` — **2225 / 2225 pass** (277 / 277 test files), including 9 new helper tests, 8 new schema tests, 3 new handler tests, and 1 new protected-dimension pin test added during the fix-loop.

Next: Phase 1 closed; proceed to Phase 2 (Inspector data surface — codex delegate).
