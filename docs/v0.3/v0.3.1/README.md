# v0.3.1 Patch — Recall Quality Foundation

v0.3.1 is a patch-safe internal quality pass. It improves
maintainability around recall and MCP memory handling while keeping every
public surface byte-compatible:

- no MCP tool name or description changes;
- no MCP request / response schema changes;
- no EventLog payload schema changes;
- no runtime config schema changes;
- no storage migrations.

The release is intentionally smaller than the v0.3.2 read/write
integration track. v0.3.1 creates the code seams and regression evidence
needed before that larger work can safely touch write-path memory
semantics.

## Task Cards

| Slice | Card | Size | Prereq | Status |
|---|---|---:|---|---|
| 1 | Internal recall candidate builder | S | none | done |
| 2 | Storage keyword-search plumbing cleanup | S | none | done |
| 3 | Daemon recall result shaping split | S | none | done |
| 4 | Recall baseline and verification report | S | slices 1-3 | done |

## Slice 1 — Internal Recall Candidate Builder

### Scope

- Extract candidate construction, source-channel shaping, selection
  reasons, additive-candidate budget checks, and delivery-budget rebuild
  from `RecallService` into a core-internal helper module.
- Keep `RecallService.recall()` and `RecallResult` unchanged.

### Acceptance

- Existing recall ranking, embedding supplement, path plasticity,
  tier-cascade, and global-recall tests remain green.
- A focused helper test pins explainability and delivery budget state.
- No protocol snapshots move.

## Slice 2 — Storage Keyword-Search Cleanup

### Scope

- Keep both public repo methods:
  `searchByKeyword(...)` and `searchByKeywordWithinObjectIds(...)`.
- Route both through one private row-search implementation so token
  splitting, short-token exact matching, trigram FTS, and merge ranking
  cannot drift separately.

### Acceptance

- `memory-entry-repo` tests for short-token fallback, tombstone
  exclusion, filtered candidate sets, and normalized ranks remain green.
- No SQLite migration or repo interface change.

## Slice 3 — Daemon Recall Result Shaping Split

### Scope

- Extract MCP recall result shaping and fallback explainability from the
  large MCP memory handler into an adjacent daemon-internal helper.
- Keep call order unchanged:
  `soul.recall` -> core recall -> trust delivery -> optional
  POST_TURN_EXTRACT enqueue -> recall-delivered telemetry -> response.

### Acceptance

- MCP handler tests still prove recall, report-context-usage validation,
  POST_TURN_EXTRACT behavior, Garden task tools, and host-autonomy
  witness replay.
- No MCP tool catalog or protocol schema changes.

## Slice 4 — Baseline And Report

### Scope

- Record the verification evidence for the patch.
- Treat recall efficiency claims as measured only when backed by test or
  telemetry output. Do not claim paper-level quality gains in this
  patch.

### Required Verification

```bash
rtk pnpm exec vitest run --project @do-soul/alaya-core -- recall-candidate-builder recall-service recall-service-tier-cascade embedding-recall-service
rtk pnpm exec vitest run --project @do-soul/alaya-storage -- memory-entry-repo
rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -- mcp-memory-tool-handler post-turn-extract-task recall-utilization-service garden-mcp-tools host-autonomy-witness
rtk pnpm build
rtk pnpm run hygiene:unused
```

## Review Gate

Run a review/fix loop before closeout. Closure requires zero unresolved
Blocking or Important findings. Any review finding must follow
`docs/handbook/workflow/review-protocol.md`.

## Closeout

Closeout result (2026-05-13): v0.3.1 closed as a patch-safe internal
quality release. Workspace packages were bumped `0.3.0` -> `0.3.1`.
See `release-notes.md` and `reports/v0.3.1-closeout.md`.
