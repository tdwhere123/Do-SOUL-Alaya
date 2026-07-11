# S0 — Concept and Handbook Lock

> - **Card ID:** `2026-07-10-s0-concept-handbook-lock`
> - **Source/Background:** resolved grill `recall-root-cause-levers`
> - **Target:** concept card and `docs/handbook/`
> - **Size:** S
> - **Tier:** Standard; AFK
> - **Prerequisite:** E2 baseline captured
> - **Blocks:** S1-S4 implementation claims
> - **Owner:** parent/docs worker
> - **Grill:** `recall-root-cause-levers`
> - **Brainstorm:** none

## 1. Background & Goal

**Goal:** make durable project truth distinguish PathRelation, flood transfer, shore reading, and derived SliceKey without changing runtime behavior.

Failure-Mode Forecast: contract drift between plan terms, handbook invariants, and runtime ownership.
Path Map: docs definition -> implementation card -> contract tests. Readiness: `docs-truth-ready`; Truth Plane: `task-worktree`.

## 2. Allowed Scope

- `.do-it/plans/claude/2026-07-09-flood-path-slice-concept-lock.md` — resolved terminology and decisions.
- `docs/handbook/invariants.md` — add the runtime-vs-durable distinction without weakening existing invariants.
- `docs/handbook/architecture.md` — place SliceKey in runtime routing/projection and flood transfer in recall control.

Any other file requires parent card amendment.

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| ID | Criterion | Evidence |
| --- | --- | --- |
| S0-AC1 | PathRelation is durable structure; transfer and score are runtime projections | matching handbook paragraphs |
| S0-AC2 | SliceKey is rebuildable routing, not ontology | invariants and architecture agree |
| S0-AC3 | Single-hop-first and evidence-gated two-hop are explicit | concept decision F6 |

## 5. Verification

- `rtk rg -n "PathRelation|Flood transfer|SliceKey|shore reading|two-hop" docs/handbook .do-it/plans/claude/2026-07-09-flood-path-slice-concept-lock.md`

| Claim ID | Readiness target | Truth plane | Ref/path | Evidence | Result | Date | Owner | Residual risk |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S0 | docs-truth-ready | task-worktree | `docs/handbook/invariants.md`, `docs/handbook/architecture.md`, concept card | durable/runtime/projection and typed SliceKey terminology cross-check | VERIFIED | 2026-07-10 | parent | algorithm/product promotion still depends on S4-S5/E4 |

## 6. Shared File Hazards & Dependencies

Handbook and concept card are parent-owned; no other lane may edit them.
