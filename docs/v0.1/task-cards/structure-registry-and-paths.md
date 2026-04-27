# ALA-R3 - Structure Registry And Paths

## Goal

实现 Structure Registry 的根对象和 runtime path manifestation：`PathRelation` 持久化，`ActivationCandidate` turn-scoped，manifestation/context projection 不成为 durable truth。

## Source References

- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/path-relation.ts:143`
- `/home/tdwhere/vibe/do-what-new/packages/storage/src/migrations/042-path-relations.sql:1`
- `/home/tdwhere/vibe/do-what-new/packages/storage/src/repos/path-relation-repo.ts:13`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/activation-candidate.ts:12`
- `/home/tdwhere/vibe/do-what-new/docs/handbook/invariants.md:51`
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/phase-c-briefs/task-c3-consolidation-loop.md:479`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/manifestation-budget.ts:8`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/manifestation-resolver.ts:80`

## Alaya Adaptation

- `PathRelation` 是 durable structure truth。
- `ActivationCandidate` 是 runtime control output，只能被当前 run 消费。
- manifestation decisions 必须可审计；candidate creation 本身不写 durable truth。

## Non-goals

- 不实现完整 graph inspector UI。
- 不把 topology snapshot 当成 path source of truth。

## Scope

- PathRelation schema/repo。
- ActivationCandidate schema。
- manifestation budget/resolver。
- path lifecycle audit。

## Inputs

- ontology object refs。
- path anchors。
- path constitution / effect vector / plasticity / legitimacy。
- current task/run context。

## Outputs

- persisted PathRelation。
- runtime ActivationCandidate list。
- manifestation decisions。
- path lifecycle audit events。

## Acceptance

- PathRelation survives across runs and supports active lookup。
- ActivationCandidate is never persisted as durable storage。
- manifestation requires task coupling, confidence/pressure, budget, and governance ceiling。
- derived topology/graph reads active PathRelation and does not mutate state。

## Verification

- PathRelation migration/repo tests。
- ActivationCandidate non-persistence tests。
- manifestation resolver tests。
- topology read-only tests。

## Review Lens

- structure registry ownership。
- runtime vs durable separation。
- deterministic ordering。

## Stop Conditions

- 如果 implementation would store runtime candidate durably, stop and redesign.
