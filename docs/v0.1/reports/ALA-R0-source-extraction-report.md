# ALA-R0 Source Extraction Report

Status: closed for docs/source preflight on 2026-04-27.

This report closes [ALA-R0 - Source Extraction](../task-cards/source-extraction.md).
The closeout is limited to source references, task-card schema, source
classification, link hygiene, stale-marker cleanup, and product-default
containment. It does not make the repository runtime-ready.

## Closeout Verdict

ALA-R0 Source gate is complete for v0.1 docs/source preflight.

The next executable card is
[ALA-R1 - Runtime Truth Kernel](../task-cards/runtime-truth-kernel.md). ALA-R1
is the foundation spine because it introduces the package, runtime/API
boundary, audit write discipline, storage baseline, and doctor/status plan.
ALA-R2, ALA-R3, and ALA-R4 should wait for ALA-R1's runtime/API boundary before
parallel implementation starts.

## Evidence Summary

| Check | Evidence | Result |
|---|---|---|
| Root-card schema | `rtk node -e "<schema check>"` | 13 root task cards checked; no required heading is missing. |
| Absolute source refs | `rtk node -e "<source-ref check>"` | 222 `/home/tdwhere/vibe/do-what-new/...:<line>` refs checked; every file exists and every line is in range. |
| Relative Markdown links | `rtk node -e "<relative-link check>"` | No broken relative Markdown links found in `docs/v0.1` or `docs/handbook`. |
| Task-marker scan | uppercase task-marker scan across `docs/v0.1` and `docs/handbook` | No matches. |
| Stale decision wording | targeted stale-decision scan across `docs/v0.1` and `docs/handbook` | Matches are limited to explicit anti-pattern, stop-condition, or review-gate wording; no pending decision list was found. |
| Source-gap/keychain wording | targeted source-gap and keychain scan across `docs/v0.1` and `docs/handbook` | Matches preserve the intended policy: source gaps are not product blockers, and OS keychain remains deferred behind abstract secret refs plus env/local-file adapter. |
| Diff/status scope | `rtk git diff -- docs/v0.1 docs/handbook` plus `rtk git status --short` | Modified files and the new report are limited to `docs/v0.1` and `docs/handbook`. No implementation, package, archive, or generated state changes. |

## Defaults Confirmation

Product defaults remain centralized in
[product-alignment-defaults.md](../task-cards/product-alignment-defaults.md):

- Attach/Profile conflict UX: preview-only diff plus explicit per-target
  confirmation.
- Gateway strictness: default audit mode; strict blocking only with an explicit
  command flag or benchmark profile.
- Secret storage: abstract secret refs plus env/local-file adapter; OS keychain
  deferred.
- Benchmark suite: coding continuation, review/fix-loop, long-context recall.
- Inspector visual direction: Phase 2 point/network graph; v0.1 freezes only the
  data contract.

No new product default is introduced by this report.

## Build, Test, CLI, And MCP Status

Build, test, CLI, MCP, doctor, and smoke commands were not run because the
current repository has no `@do-soul/alaya` package implementation surface,
runtime/API implementation, storage implementation, CLI protocol, MCP adapter,
Gateway, or benchmark harness.

That boundary is owned by the current
[Runtime Status](../../handbook/runtime-status.md): until a package/runtime
surface exists, R0 can only verify documentation/source preflight evidence.

## Final Diff Summary

- Added this R0 closeout report under `docs/v0.1/reports/`.
- Updated the reports index so the directory no longer claims that no reports
  exist.
- Marked ALA-R0 as closed for docs/source preflight in the task-card index.
- Updated the handbook code map to include the new report path.

This closeout does not edit archive material, restore deleted prototype source,
or claim runtime readiness.
