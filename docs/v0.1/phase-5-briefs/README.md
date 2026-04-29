# Phase 5 — Wave 5: E2E + Benchmark + Graph Contract + Final Review

Phase 5 closes v0.1 with end-to-end validation, benchmark fixtures
running on the live runtime, the graph inspector data contract derived
from real `PathRelation` data, and a final multi-lens review.

Phase 5 is mostly sequential (1 codex at a time), with the final
review being a multi-perspective sweep.

## Cards

| Card ID | Subject | Port mode | Closing label |
|---|---|---|---|
| P5-e2e | Full installation → configure → attach → MCP tools/list → recall → open pointer → report usage → propose → govern → export / backup loop. Replaces what was originally R12 "Full Product Gate". E2E test lives at `apps/core-daemon/src/__tests__/e2e/v0.1-release-loop.test.ts`. | requires-redesign | live-event-ready |
| P5-benchmark | Activation-mode benchmark on real runtime (Connect / Attach / Gateway). Fixture suite for at least three task families: coding-continuation, review-fix-loop, long-context-recall. Replaces what was originally R10. | requires-redesign | implementation-ready |
| P5-graph-contract | Graph inspector data contract derived from real PathRelation rows + path-graph snapshots. Read-only; no UI in v0.1. | adapt-and-port | schema-ready |
| P5-final-review | Findings-first multi-lens review + fix-loop closure. Marks v0.1 as `live-event-ready` / `mcp-consumable` / `cli-consumable` only after evidence supports it. | requires-redesign | mcp-consumable |

## Prerequisites

Per review I9:

- **P5-graph-contract** depends on P1-topology + P2-repos-batch-3
  (path-relation-repo + path-graph-snapshot-repo) +
  P2-garden-batch-3 (path-graph-snapshotter wiring) being
  `live-event-ready`. The card consumes real path snapshots; without
  them it falls back to schema-only and trips R3.
- **P5-benchmark** depends on Gate-4 closure (real daemon).
- **P5-e2e** depends on Gate-4 closure and on P5-benchmark having a
  fixture format the E2E test can reference. It must also prove the
  P4-mcp-memory-tools contract through a real attached-agent
  `tools/list -> soul.recall -> soul.open_pointer ->
  soul.report_context_usage` chain.
- **P5-final-review** depends on the above three.

## Gate-5 (v0.1 release)

- Gate-4 holds (end-to-end demo still works).
- P5-e2e produces a passing E2E test that exercises the full loop,
  including MCP memory tool discovery, recall delivery, pointer open,
  usage proof, proposal, and governance rejection.
- P5-benchmark produces baseline numbers for at least three
  activation modes on at least three task families.
- P5-graph-contract: read-only graph derivation works on real data;
  contract is frozen (suitable for future GUI consumption).
- P5-final-review: zero Blocking / Important findings.
- `docs/handbook/runtime-status.md` reflects v0.1 ready.
- `docs/handbook/backlog.md` lists any deferred-to-v0.2 items.

## Parallelism Notes

- P5-graph-contract can start in parallel with P5-benchmark once
  Gate-4 closes (different write sets).
- P5-e2e runs after both above land (it composes their fixtures).
- P5-final-review may dispatch multiple reviewer perspectives in
  parallel (security / port-discipline / live-path / docs-drift)
  but consolidates back to a single closure decision.
