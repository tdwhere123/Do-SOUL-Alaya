# Phase 6 — Wave 6: MCP Agent-Use Protocol + Trustworthy Memory Loop (post-v0.1.0)

Phase 6 resets v0.1.1 acceptance away from marketing benchmark output.
The active scope proves that attached agents can use Alaya correctly
over MCP/CLI, and that governed memory changes move through explicit
proposal, review, durable apply, recall, usage, and audit evidence.

## Charter

- Phase 6 is **post-release**. v0.1.0 is a complete shipped product
  before Phase 6 starts.
- Phase 6 accepts v0.1.1 only when the **MCP Agent-Use Protocol** and
  **Trustworthy Memory Loop** are implemented, tested through a real
  agent-style MCP path, and documented consistently across phase docs,
  runtime status, glossary, and README surfaces.
- Benchmark cards are retained only as **archive artifacts**; they are
  not active acceptance criteria for v0.1.1.
- Durable memory promotion remains proposal/governance/audit first:
  delivery is not usage, usage is not durable memory without explicit
  promotion.

## Active Plan

| Plan ID | Subject | Closing label |
|---|---|---|
| P6-agent-use-protocol | Define and prove the end-to-end MCP/CLI operator protocol for attach/profile/server/session usage and memory-tool flow semantics. | mcp-consumable |
| P6-governance-accept-apply | Persist `proposed_changes`; make `soul.review_memory_proposal(accept)` apply the accepted patch through controlled durable memory service code. | live-event-ready |
| P6-recall-explainability | Return stable recall explanation fields: result-level selection reason, source channels, score factors, budget state; response-level strategy mix and degradation reason. | schema-ready |
| P6-operator-control | Keep CLI/status/tool descriptions distinct for candidate signal, proposal, accepted proposal, durable memory application, recall delivery, and usage receipt. | cli-consumable |
| P6-live-agent-proof | Add a deterministic agent-path harness that proves tool discovery, ordered MCP calls, usage receipt, proposal review, durable update, and explainable recall in one daemon lifetime. | live-event-ready |
| P6-contract-parity-reset | Align README, README.zh-CN, v0.1 INDEX, runtime-status, and glossary to one source of truth for Phase 6 acceptance. | docs-truth-ready |

## Archived Benchmark Cards (historical only)

- `_archive/task-p6-bench-adapter.md`
- `_archive/task-p6-bench-harness.md`
- `_archive/task-p6-bench-baselines.md`
- `_archive/task-p6-bench-resume.md`
- `_archive/task-p6-bench-readme.md`

## Prerequisites

- **Gate-5 passed** (v0.1.0 released; this is non-negotiable — the
  Phase 6 proof wave is for an already-shipped product).
- **Gate-5F passed**: backlog Open count for `#BL-025` through
  `#BL-036` is zero, final review has zero Blocking / Important
  findings, and the full verification gate passes.

## Gate-6 (v0.1.1 release)

- Gate-5 and Gate-5F guarantees remain true.
- Active docs define Phase 6 as MCP Agent-Use Protocol + Trustworthy
  Memory Loop (not benchmark leaderboard acceptance).
- The live proof covers tools/list discovery, CLI fallback parity,
  pre-task recall, pointer open, usage receipt, candidate signal,
  memory proposal, explicit review, durable memory application, and
  post-apply recall explainability.
- `soul.review_memory_proposal(accept)` is accept-as-apply for
  proposals created by `soul.propose_memory_update`; reject leaves
  durable memory untouched.
- README + README.zh-CN + v0.1 INDEX + runtime-status + glossary use
  the same domain sequence and trust language.
- No active acceptance text requires benchmark numbers, benchmark
  harness execution, or benchmark leaderboard publication.

## Out Of Scope

- Any new benchmark implementation claim.
- Any claim that benchmark cards are a live blocker for v0.1.1.
