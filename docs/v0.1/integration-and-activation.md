# v0.1 Integration And Activation Execution Brief

Status: execution brief. Stable surface boundaries live in
[Surface Strategy](../handbook/surface-strategy.md) and
[Runtime Status](../handbook/runtime-status.md).

This file coordinates implementation tasks for agent access and activation. It
does not claim any adapter is currently implemented.

## Execution Ownership

| Area | Owning cards | Acceptance focus |
|---|---|---|
| Session contract | [ALA-R7](task-cards/session-audit-and-trust.md) | Distinguishes configured, delivered, used, skipped, unverifiable, and mixed states. |
| MCP and CLI fallback | [ALA-R8](task-cards/agent-integration.md) | Both paths call the same runtime/API contract. |
| Attach/Profile installer | [ALA-R8](task-cards/agent-integration.md), [ALA-R9](task-cards/operations-and-portability.md) | Profile writes are previewed, consented, scoped, and audited. |
| Gateway mode | [ALA-R8](task-cards/agent-integration.md), [ALA-R10](task-cards/evaluation-and-benchmark.md) | Gateway provides stronger proof for evaluation without redefining durable truth. |
| Configuration and portability | [ALA-R9](task-cards/operations-and-portability.md) | User/project scope, provider policy, import/export, backup, and restore remain auditable. |

## Dependency Rules

- ALA-R8 cannot claim adapter acceptance until ALA-R1 defines the runtime/API
  boundary.
- ALA-R8 cannot claim usage proof until ALA-R7 defines session audit semantics.
- ALA-R9 must align profile, secret reference, import/export, and backup
  behavior with governance rules from ALA-R4.
- ALA-R10 can compare activation modes only after ALA-R7 and ALA-R8 expose
  evidence for delivered/used/skipped/unverifiable states.

## Review Focus

Review integration work for:

- MCP being described as a capability surface, not a usage guarantee;
- Attach/Profile being best-effort unless Gateway mode is explicitly selected;
- CLI fallback preserving audit and governance semantics;
- global or project profile changes requiring explicit preview and consent;
- installed-but-unused sessions remaining observable.

## Stop Conditions

Return `BLOCKED` if implementation would hide profile mutations, weaken audit in
fallback mode, or let an adapter bypass the runtime truth gate.
