# S2 — Derived SliceKey Contract

> - **Card ID:** `2026-07-10-s2-slice-key-contract`
> - **Source/Background:** concept F2 and resolved grill
> - **Target:** internal SliceKey identity and derivation contract
> - **Size:** S
> - **Tier:** Standard; AFK
> - **Prerequisite:** S1 integrated
> - **Blocks:** S3/S4
> - **Owner:** architecture worker; parent reviews
> - **Grill:** `recall-root-cause-levers`
> - **Brainstorm:** none

## 1. Background & Goal

**Goal:** define a small internal `SelectedSliceKeyV1` contract over typed `time | space | entity | semantic` seeds without adding persistence or a public API. Object anchors are provenance for entity routing, not a memory-entry-ID dimension. The dimension field remains extensible; these values are v1 producers, not a closed ontology enum.

Failure-Mode Forecast: ontology drift, optional-field misuse, non-deterministic identity, hidden fallback, or provenance making semantically equal keys impossible to intersect.
Path Map: query/memory/path projections -> normalized key sets -> three-way selector -> edge decision. Readiness: `fixture-ready`; Truth Plane: `task-worktree`.

## 2. Allowed Scope

- `packages/core/src/recall/flood/slice-key-contract.ts` (new)
- `packages/core/src/__tests__/recall/slice-key-contract.test.ts` (new)
- `.do-it/plans/claude/2026-07-10-s2-slice-key-contract.md` — evidence updates by parent only

## 3. Deferred

- Materialized index: `BL-069`.
- Learned arbitrary key taxonomy: `BL-071` until evidence/governance design exists.

## 4. Acceptance Criteria

| ID | Criterion | Evidence |
| --- | --- | --- |
| S2-AC1 | `key_id` includes schema version, workspace, dimension, normalized value, provenance, and source version; `match_id` includes only workspace, dimension, and normalized value | type and normalization tests |
| S2-AC2 | Time, space, entity, and semantic inputs retain distinct provenance; event-time is never encoded as a generic facet tag and memory-entry IDs are not routing keys | contract docs/tests |
| S2-AC3 | Empty/invalid values are rejected at derivation boundary | invalid-state tests |
| S2-AC4 | Stable sort and dedupe yield deterministic keys | permutation tests |
| S2-AC5 | Three-way routing intersects `match_id`, while diagnostics retain the matched key instances and their distinct provenance | cross-source equality tests |

## 5. Verification

- `rtk pnpm build`
- `rtk pnpm exec vitest run --project @do-soul/alaya-core packages/core/src/__tests__/recall/slice-key-contract.test.ts`

| Claim ID | Readiness target | Truth plane | Ref/path | Evidence | Result | Date | Owner | Residual risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S2 | fixture-ready | task-worktree | `recall/flood/slice-key-contract.ts` | fresh/stale tie fixed; contract + selector regressions; Heavy architecture/core re-review CLEAN | INTEGRATED | 2026-07-10 | architecture worker + parent | future taxonomy producers remain evidence-gated |

## 6. Shared File Hazards & Dependencies

No shared-file hazard: S2 uses new files only. It may run in parallel with read-only E3.
The post-code Heavy review/fix-loop is complete and clean for this contract.
