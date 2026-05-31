# Phase 5 — Wave 5: E2E + Graph Contract + Final Review (release acceptance)

Phase 5 closes **v0.1.0** with end-to-end validation, the graph
inspector data contract derived from real `PathRelation` data, and a
final multi-lens review. This is the **release acceptance** phase: it
proves the plugin is architecturally complete and works end-to-end.

The previous P5-benchmark card is archived as future evidence-harness
material. Active Phase 6 is the MCP Agent-Use Protocol + Trustworthy
Memory Loop (`v0.1.1`), not a marketing benchmark wave.

Phase 5 is mostly sequential (1 codex at a time), with the final
review being a multi-perspective sweep.

## Cards

| Card ID | Subject | Port mode | Closing label |
|---|---|---|---|
| P5-e2e | Full installation → configure → attach → MCP tools/list → recall → open pointer → report usage → propose → govern → export / backup loop. Replaces what was originally R12 "Full Product Gate". E2E test lives at `apps/core-daemon/src/__tests__/e2e/release-loop.test.ts`. | requires-redesign | live-event-ready |
| P5-graph-contract | Graph inspector data contract derived from real PathRelation rows + path-graph snapshots. Read-only; no UI in v0.1. | adapt-and-port | schema-ready |
| P5-final-review | Findings-first multi-lens review + fix-loop closure. Marks v0.1.0 as `live-event-ready` / `mcp-consumable` / `cli-consumable` only after evidence supports it. | requires-redesign | mcp-consumable |

## Prerequisites

Per review I9:

- **P5-graph-contract** depends on P1-topology + P2-repos-batch-2
  (path-relation-repo + path-graph-snapshot-repo) +
  P2-garden-batch-3 (path-graph-snapshotter wiring) being
  `implementation-ready`. The card derives a read-only schema-ready
  contract from active path relations and optional snapshot history;
  it must not claim Inspector or daemon live wiring.
- **P5-e2e** depends on Gate-4 closure and must start only after
  P5-graph-contract closes. It must also prove the P4-mcp-memory-tools
  contract through a real attached-agent `tools/list -> soul.recall ->
  soul.open_pointer -> soul.report_context_usage` chain.
- **P5-final-review** depends on the above two.

## Gate-5 (v0.1.0 release)

- Gate-4 holds (end-to-end demo still works).
- P5-e2e produces a passing E2E test that exercises the full loop,
  including MCP memory tool discovery, recall delivery, pointer open,
  usage proof, proposal, and governance rejection.
- P5-graph-contract: read-only graph derivation works on real data;
  contract is frozen (suitable for future GUI consumption).
- P5-final-review: zero Blocking / Important findings.
- `docs/handbook/runtime-status.md` reflects v0.1.0 ready.
- `docs/handbook/backlog.md` lists any deferred-to-v0.1.1 / v0.2 items.

Gate-5 does **not** require benchmark numbers in the README. Active
Phase 6 / Gate-6 / `v0.1.1` proves the MCP agent-use loop and
accept-as-apply governance path; benchmark cards remain archived.

## Parallelism Notes

- P5-graph-contract runs before P5-e2e so the E2E card consumes the
  frozen schema-ready graph contract rather than racing a contract
  change.
- P5-final-review runs after both above land.
- P5-final-review may dispatch multiple reviewer perspectives in
  parallel (security / port-discipline / live-path / docs-drift)
  but consolidates back to a single closure decision.
