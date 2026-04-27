# ALA-R12 - Full Product Gate

## Goal

验证 Do-SOUL Alaya 完整产品闭环：
install -> activate -> recall -> use -> propose -> govern -> inspect/export。

## Source References

- `docs/v0.1/full-product-loop.md`
- `docs/v0.1/task-cards/runtime-truth-kernel.md`
- `docs/v0.1/task-cards/ontology-and-evidence.md`
- `docs/v0.1/task-cards/governance-and-promotion.md`
- `docs/v0.1/task-cards/recall-and-context.md`
- `docs/v0.1/task-cards/session-audit-and-trust.md`
- `docs/v0.1/task-cards/agent-integration.md`
- `docs/v0.1/task-cards/evaluation-and-benchmark.md`

## Alaya Adaptation

- This is the product gate, not another implementation slice.
- It must prove the memory system works as a complete local product for CLI agents.

## Non-goals

- 不新增未在前置卡片实现的功能。
- 不把 Inspector UI 作为 v0.1 blocker；只要求 graph data contract ready。

## Scope

- install/profile。
- daemon/runtime。
- MCP/CLI/Gateway activation。
- recall/context delivery。
- candidate proposal。
- governance/promotion。
- session trust report。
- export/backup。
- benchmark report。

## Inputs

- clean temp data dir。
- sample user/project profile。
- scripted CLI agent command。
- memory fixture bundle。

## Outputs

- full smoke report。
- trust report。
- benchmark report。
- export bundle。
- review closeout。

## Acceptance

- User can install/configure Alaya for a CLI agent。
- Agent can receive context through MCP or CLI fallback。
- Session audit distinguishes delivered/used/skipped/unverifiable。
- Candidate proposal goes through runtime/governance before durable truth。
- High-risk writes cannot bypass confirmation。
- Gateway can compare/enforce activation mode behavior。
- Export/backup preserves source/evidence/governance。
- Operator can explain what was recalled, what was used, what changed, and why。

## Verification

- package build/test。
- doctor smoke。
- MCP smoke。
- CLI fallback smoke。
- Gateway smoke。
- benchmark fixture run。
- export/import roundtrip。

## Review Lens

- correctness。
- architecture。
- trust/security。
- install/release。
- domain language。

## Stop Conditions

- If any path can write durable truth without runtime/governance/evidence, gate fails.
