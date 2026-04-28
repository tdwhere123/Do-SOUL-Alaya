# Phase 5 — Wave 5: E2E + Benchmark + Graph Contract + Final Review

Phase 5 closes v0.1 with end-to-end validation, benchmark fixtures
running on the live runtime, the graph inspector data contract derived
from real `PathRelation` data, and a final multi-lens review.

Phase 5 is mostly sequential (1 codex at a time), with the final
review being a multi-perspective sweep.

## Cards

| Card ID | Subject |
|---|---|
| P5-e2e | Full installation → configure → activate → recall → use → propose → govern → export / backup → benchmark loop. Replaces what was originally R12 "Full Product Gate" |
| P5-benchmark | Activation-mode benchmark on real runtime (Connect / Attach / Gateway). Replaces what was originally R10 "Evaluation And Benchmark", but now backed by a live daemon |
| P5-graph-contract | Graph inspector data contract derived from real PathRelation. Replaces what was originally R11. Read-only; no UI in v0.1 |
| P5-final-review | Findings-first multi-lens review + fix-loop closure. Marks v0.1 as `live-event-ready` / `mcp-consumable` / `cli-consumable` |

## Gate-5 (v0.1 release)

- Gate-4 holds (end-to-end demo still works).
- P5-e2e produces a passing E2E test that exercises the full loop.
- P5-benchmark produces baseline numbers for at least three
  activation modes on at least three task families
  (coding-continuation / review-fix-loop / long-context-recall).
- P5-graph-contract: read-only graph derivation works on real data;
  contract is frozen (suitable for future GUI consumption).
- P5-final-review: zero Blocking / Important findings.
- `docs/handbook/runtime-status.md` reflects v0.1 ready.
- `docs/handbook/backlog.md` lists any deferred-to-v0.2 items.

## Parallelism Notes

- Cards run sequentially (or with light overlap) by default.
- P5-final-review may dispatch multiple reviewer perspectives in
  parallel (security / port-discipline / live-path / docs-drift) but
  consolidates back to a single closure decision.

## Notes

Phase 5 is the only phase that did not exist in pre-reset codex
planning in any meaningful form. The pre-reset R10 / R11 / R12 cards
all assumed a contract-only system; Phase 5 here assumes a runtime
body exists (delivered by Phase 4) and validates it.
