# v0.1.2 Inspector & MCP UX Uplift — Phase 4 Review

**Diff range**: `db9bb2a..HEAD` (Phase 4 NL + time search + classifier follow-on + this fix-loop)
**Lenses**: Claude `reviewer` agent + Codex `codex:codex-rescue` second opinion. Live operator probe revealed the codex bulk-import classifier blind spot (commit `328d838`).
**Verdict before fix-loop**: 1 BLOCKING + 6 IMPORTANT + 1 NICE-TO-HAVE
**Verdict after fix-loop**: 0 BLOCKING + 0 IMPORTANT + 2 deferred user-decision opportunities (I2 chrono lazy split, I3 chronological-sort UX) — both surfaced explicitly, neither swept into a backlog.

---

## Findings (merged)

### BLOCKING — closed

#### B-1 — classifier substring branches outranked the user_origin guard
- **Lens**: Claude + Codex (independent confirm).
- **Where**: `apps/core-daemon/src/daemon-runtime-support.ts` `classifySoulGraphOriginKind` after commit `328d838`.
- **Impact**: the new `domain_tags` / `run_id` / `content` substring checks added to recover engineering attribution for codex bulk-import rows fired BEFORE the `isUserOrigin` branch. A user-curated memory whose content quoted `~/.codex/memories`, or carried a tag like `codex-memory-import-feedback`, or used a run_id that included `codex-memory-import`, would silently be re-attributed to `engineering_chunk` (or `reviewed_engineering_chunk` after a reviewer accept) — exactly the regression the Phase 2 M-6 reviewed_engineering_chunk split was meant to prevent.
- **Fix**: the user_origin branch now executes first. `source_kind="user"` and `source_kind="review"` always resolve to `user_memory` — no soft signal can override an explicit user-curated source. The substring branches still recover `engineering_chunk` for the bulk-import shape (`source_kind="compiler"` / `formation_kind="extracted"`) where they remain the only attribution signal.
- **Test**: new boundary case `keeps source_kind=user as user_memory even when content / tags / run_id mention codex` covers all three substring vectors.
- **Status**: ✅ Fixed

### IMPORTANT — all 6 closed

#### M-NL-1 — zh-CN parser prefered single-day over multi-day on conflict
- **Lens**: Codex.
- **Where**: `apps/inspector/web/src/utils/parse-search-query.ts`.
- **Impact**: `"5月20号 上周"` matched the single-day `M月D号` branch first and returned, silently dropping the broader `上周` window. Operators with both signals in the same query saw a one-day result set.
- **Fix**: the multi-day relative-range loop now runs BEFORE the single-day matcher. Pinned by new test `prefers a multi-day window over a single-day window when both match`.
- **Status**: ✅ Fixed

#### M-VAL-1 — route silently coerced malformed since/until/time_field to undefined
- **Lens**: Codex.
- **Where**: `apps/core-daemon/src/routes/soul-search.ts`.
- **Impact**: a non-string `since`, a non-`"created_at"|"last_used_at"` `time_field`, or any of the malformed shapes the route received would be coerced to `undefined` and bypass the recall-side schema validation. Bad shapes silently became unfiltered queries instead of returning 400.
- **Fix**: `parseOptionalIsoDatetime` now throws on non-string-non-null input; `time_field` validation rejects unknown values explicitly with 400. Empty-string `since`/`until` collapse to `null` (open-ended), preserving operator intent.
- **Test**: new daemon route test `rejects malformed since / until / time_field with 400 instead of silent coerce` exercises both branches; confirms the MCP handler is never called when the route rejects.
- **Status**: ✅ Fixed

#### M-FB-1 — fallback substring used the raw query with the time prefix still inside
- **Lens**: Claude.
- **Where**: `apps/inspector/web/src/pages/Graph.tsx` matchIds memo before fix.
- **Impact**: when the daemon errored and the front-end fell back to in-memory substring matching, the matcher still saw `"5月20号 inspector"` rather than `"inspector"` — almost guaranteeing zero matches even when keyword recovery was possible.
- **Fix**: the parser already returns `parsed.text` (the keyword remainder after the time expression is stripped). The component now stores it in `searchKeywordFallback` state and the substring scan uses that when `searchTimeHits` is null.
- **Status**: ✅ Fixed

#### M-T-1 — daemon `/soul/search` route had no test
- **Lens**: Codex (also called out in plan §Tests).
- **Where**: `apps/core-daemon/src/__tests__/routes-soul-search.test.ts` (new).
- **Coverage**: 5 cases — happy path threading text/since/until/time_field/max_results to soul.recall, empty-text rejection, malformed-input rejection, max_results clamp [1, 100], non-object body rejection.
- **Status**: ✅ Fixed

#### M-T-2 — Graph search fetch + highlight had no test
- **Lens**: Codex (also called out in plan §Tests).
- **Where**: `apps/inspector/web/src/pages/Graph.test.tsx` (extended).
- **Coverage**: typing `"yesterday auth"` triggers a POST to `/api/soul/search/ws-1`, the chip mounts with `1 hits`, and the chip text uses the actual returned ids count (not `total_count`).
- **Status**: ✅ Fixed

#### NTH-CHIP — chip displayed daemon `total_count` while highlight only used returned ids
- **Lens**: Codex (NICE-TO-HAVE → fixed in this loop because trivial).
- **Where**: `apps/inspector/web/src/pages/Graph.tsx` chip render.
- **Impact**: the MCP handler slices `results` to `max_results` but reports the unsliced `fine_assessment_count` as `total_count`. The chip could say "showing 上周 · 50 hits" while actually highlighting 30 nodes.
- **Fix**: `searchTimeHits` no longer carries `total`; chip renders `searchTimeHits.ids.size` so the count and the spotlight always agree. Daemon-side `total_count` is still returned in the envelope for any future "show more" UX.
- **Status**: ✅ Fixed

### NICE-TO-HAVE — surface to user (no defer commitment in this loop)

#### O-2 — chrono-node still ships in the main entry chunk
- **Lens**: Claude I2 + Codex implicit confirm.
- **Where**: `apps/inspector/web/src/pages/Graph.tsx` static `import { parseSearchQuery }` chain.
- **Status**: open. Main bundle is 517 kB / 153 kB gzipped; chrono-node is roughly 80 kB minified. Lazy-importing parseSearchQuery only on the first time-shaped keystroke is feasible (defer the `await import("../utils/parse-search-query")` into the search effect) but adds a network-roundtrip lag on the operator's first time-search of a session. Surface to user — defer if 153 kB gzip is acceptable, fix if smaller initial paint matters.

#### O-3 — pure time queries (e.g. `"昨天"`) hand `query="昨天"` to recall, so ranking is semantic-relevance to the literal string, not chronological
- **Lens**: Claude I3 + Codex implicit overlap.
- **Where**: `apps/inspector/web/src/pages/Graph.tsx` and `apps/core-daemon/src/routes/soul-search.ts` flow.
- **Status**: open. The recall pipeline ranks by `path_plasticity / activation / relevance` — when the operator's intent is "everything that happened yesterday in time order", the result set is correct (within the window) but not chronologically sorted. Two paths exist: (a) accept this — the operator can already use the full graph layout to see chronology by `created_at` proximity; or (b) add a "sort by time" toggle next to the chip when a window is active. Surface to user — UX product decision.

### OK and pinned (verified by both lenses)

- **Single code path**: route forwards through `mcpMemoryToolHandler.call({ toolName: "soul.recall", … })`, the same path attached agents use. No new ranking. No new governance.
- **Time-zone**: zh-CN single-day windows compute `new Date(year, month-1, day, 0/23, …)` in the operator's local time, then `.toISOString()` produces UTC `Z` bounds equal to the operator's local-day. `entryMatchesTimeFilter` lexicographic comparison stays sound because every comparison input ends in `Z`.
- **chrono-node behaviour**: targeted runtime probe of `chrono-node@2.9.1` — `"may i borrow"` matches nothing; `"may 20"` and `"May 20"` correctly match May 20.
- **zh-CN year boundary**: `1月3号` in late December resolves to January 3 of the same calendar year (uses `ref.getFullYear()`), not next or last year — explicit and pinned.
- **Spotlight chip / fallback**: `searchTimeHits` is cleared on daemon error; substring fallback runs against `parsed.text` (M-FB-1); the error chip explicitly notes the fallback so the operator is not confused.
- **Route registration**: middleware (drain-state, request-protection, CORS) is global `app.use("*", …)` and applies to the new route without ordering hazard.

---

## Status

- BLOCKING: 0 open / 1 closed (B-1)
- IMPORTANT: 0 open / 6 closed (M-NL-1, M-VAL-1, M-FB-1, M-T-1, M-T-2, NTH-CHIP)
- NICE-TO-HAVE: 0 self-deferred, 2 surfaced for user decision (O-2, O-3)

Verification (fresh):
- `rtk pnpm build` — pass; main bundle 517 kB / 153 kB gzipped, lazy 3D split preserved.
- `rtk pnpm test` — **2275 / 2275 pass** (282 / 282 test files), including 5 new daemon search-route cases, 1 new Graph search-fetch case, 1 new parser ordering case, and 3 new classifier user-vs-engineering precedence cases.

Next: Phase 4 closed pending user decisions on O-2 / O-3. Phase 5 (closeout — README + scripts + alaya status hint, npm publish auth fix, do-it-branch-closeout, merge to main, tag v0.1.2).
