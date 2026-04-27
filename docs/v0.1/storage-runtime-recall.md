# v0.1 Storage, Runtime, And Recall Execution Brief

Status: execution brief. Stable durable-truth rules live in
[Architecture](../handbook/architecture.md) and
[Invariants](../handbook/invariants.md).

This file coordinates storage/runtime/recall implementation cards without
claiming current implementation exists.

## Execution Ownership

| Area | Owning cards | Acceptance focus |
|---|---|---|
| Runtime truth gate | [ALA-R1](task-cards/runtime-truth-kernel.md) | Runtime owns validation, audit, and durable write orchestration. |
| Durable concepts | [ALA-R2](task-cards/ontology-and-evidence.md) | Evidence, memory, synthesis, claim, lifecycle, and source/evidence requirements. |
| Structure registry | [ALA-R3](task-cards/structure-registry-and-paths.md) | Path relation lifecycle, activation candidates, and manifestation boundaries. |
| Governance and promotion | [ALA-R4](task-cards/governance-and-promotion.md) | Candidate/draft/durable promotion, HITL, conflict, and audit. |
| Recall assembly | [ALA-R5](task-cards/recall-and-context.md) | Structured, lexical, path-aware, embedding, and agent-assisted routes. |
| Provider proposal routes | [ALA-R6](task-cards/provider-and-agent-proposal.md) | Provider capability boundaries and proposal-only semantics. |
| Session audit | [ALA-R7](task-cards/session-audit-and-trust.md) | Context-pack delivery, recall exclusions, usage, ingest, and degradation proof. |

## Implementation Order

1. Define the runtime/API boundary before storage repositories or adapters.
2. Define durable ontology and evidence tables before recall routes can persist
   results.
3. Define path/governance rules before embedding or agent-assisted recall can
   influence candidate ranking.
4. Add degradation metadata before any recall route can claim full coverage.
5. Add session usage proof before agent integration can claim memory was used.

## Verification Expectations

Storage/runtime/recall cards must provide evidence that:

- adapters cannot directly mutate durable storage;
- degraded recall routes are explicit, not silent;
- embedding score alone cannot create durable truth;
- agent-assisted recall cannot bypass scope, sensitivity, or governance;
- audit data is sufficient to explain included and excluded context.

## Stop Conditions

Stop and report if a proposed implementation depends on historical prototype
code, a missing current package surface, or a source reference that contradicts
the handbook invariants.
