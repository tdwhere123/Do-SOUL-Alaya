# ALA-R3 - Structure Registry And Paths

## Goal

实现 Structure Registry 的根对象和 runtime path manifestation：`PathRelation`
持久化，`ActivationCandidate` turn-scoped，manifestation/context projection 不成为
durable truth，topology 只能作为 read-only derived view。

## Source References

- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/path-relation.ts:143`
- `/home/tdwhere/vibe/do-what-new/packages/storage/src/migrations/042-path-relations.sql:1`
- `/home/tdwhere/vibe/do-what-new/packages/storage/src/repos/path-relation-repo.ts:13`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/activation-candidate.ts:12`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/manifestation-budget.ts:8`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/manifestation-resolver.ts:80`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/manifestation-resolver.ts:114`
- `/home/tdwhere/vibe/do-what-new/docs/handbook/invariants.md:51`
- `/home/tdwhere/vibe/do-what-new/docs/archive/v0.1-v0.2-consolidated/02-soul-model.md:1238`
- `/home/tdwhere/vibe/do-what-new/docs/archive/v0.1-v0.2-consolidated/02-soul-model.md:1311`
- `/home/tdwhere/vibe/do-what-new/docs/archive/v0.1-v0.2-consolidated/02-soul-model.md:1367`
- `/home/tdwhere/vibe/do-what-new/docs/archive/v0.1-v0.2-consolidated/02-soul-model.md:1565`
- `/home/tdwhere/vibe/do-what-new/docs/archive/v0.1-v0.2-consolidated/02-soul-model.md:1623`
- `/home/tdwhere/vibe/do-what-new/docs/archive/v0.1-v0.2-consolidated/02-soul-model.md:1678`
- `docs/handbook/architecture.md:15`
- `docs/handbook/architecture.md:16`
- `docs/handbook/invariants.md:19`
- `docs/handbook/invariants.md:31`
- `docs/v0.1/extraction-ledger.md:64`
- `docs/v0.1/extraction-ledger.md:65`

## Source Classification

- `source-backed`: `PathRelation` schema/repo/migration、`ActivationCandidate`
  runtime schema、manifestation budget/resolver、以及 topology 只能 derived-read 的
  SOUL source truth。
- `alaya-adapted`: Alaya 保留 path constitution 与 manifestation discipline，但把实现边界改写为
  `@do-soul/alaya` 独立 storage/runtime/API；topology 读模型服务于 Phase 2 inspector，
  不继承 do-what-new package/runtime code。
- `alaya-default`: 本卡不选择 graph inspector UI 默认值；只冻结 read-only topology contract，
  具体点状连接图展示在 ALA-R11。

## Dependencies

- ALA-R0 source/doc preflight.
- ALA-R1 runtime/API and storage baseline.
- ALA-R2 ontology object refs and persistent/runtime envelope boundary.

## Parallel With

- ALA-R4 governance policy work after candidate/draft/durable terms are aligned.
- ALA-R11 contract drafting after topology is explicitly read-only and derived.

## Write Ownership

- Planned Structure Registry path schema/repository, `ActivationCandidate`
  runtime schema, manifestation budget/resolver, path lifecycle audit, read-only
  topology projection contract, and focused tests.
- Do not own recall ranking, context pack assembly, visual Inspector UI, or
  topology as durable source truth.

## Acceptance

- `PathRelation` survives across runs and supports active lookup。
- `ActivationCandidate` is never persisted as durable storage。
- Manifestation requires task coupling, confidence/pressure, budget, and governance ceiling。
- Manifestation decisions are auditable; individual candidate creation is runtime-only。
- Derived topology/graph reads active `PathRelation` and does not mutate durable state。

## Verification

- planned `PathRelation` migration/repo tests。
- planned `ActivationCandidate` non-persistence tests。
- planned manifestation resolver tests。
- planned topology read-only tests。

## Review Lens

- structure registry ownership。
- runtime vs durable separation。
- deterministic ordering。
- topology derived-read purity。

## Stop Conditions

- 如果 implementation would store runtime candidate durably, stop and redesign.
- 如果 topology path requires mutation or becomes source of truth, stop and return to ALA-R3/R11 boundary.

## Implementation Subcards

### ALA-R3.1 - PathRelation schema/repo

#### Scope

- 定义 `PathRelation` schema：anchors、constitution、effect vector、plasticity state、lifecycle、legitimacy。
- 建立 durable storage migration 和 repository。
- 支持 by id、workspace、anchor、active lookup。

#### Source References

- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/path-relation.ts:143`
- `/home/tdwhere/vibe/do-what-new/packages/storage/src/migrations/042-path-relations.sql:1`
- `/home/tdwhere/vibe/do-what-new/packages/storage/src/repos/path-relation-repo.ts:13`
- `/home/tdwhere/vibe/do-what-new/docs/archive/v0.1-v0.2-consolidated/02-soul-model.md:1311`

#### Acceptance

- `PathRelation` is durable Structure Registry truth, not a recall edge or graph-only edge。
- Six constitution groups are represented and validated。
- Repository roundtrip preserves anchors/effect/plasticity/lifecycle/legitimacy without lossy serialization。
- Active lookup is deterministic and workspace-scoped。

#### Verification

- planned schema validation tests。
- planned migration/repository roundtrip tests。
- planned active lookup tests。

#### Review Lens

- path constitution completeness。
- storage fidelity。
- repo/API ownership。

#### Stop Conditions

- Stop if path is represented as only source/target/weight without constitution or legitimacy.

### ALA-R3.2 - ActivationCandidate runtime-only contract

#### Scope

- 定义 `ActivationCandidate` runtime schema。
- 确保 candidate 是 current run / turn scoped control-plane output。
- 阻止 candidate 进入 durable storage、ontology repository 或 topology source。

#### Source References

- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/activation-candidate.ts:12`
- `/home/tdwhere/vibe/do-what-new/docs/handbook/invariants.md:51`
- `/home/tdwhere/vibe/do-what-new/docs/archive/v0.1-v0.2-consolidated/02-soul-model.md:1565`
- `docs/handbook/invariants.md:8`

#### Acceptance

- Candidate carries path id、anchors、why_now、effect vector snapshot、pressure/confidence、governance ceiling、run/workspace metadata。
- Candidate creation does not write durable truth。
- Candidate disposal occurs after manifestation/context assembly decision。
- Any durable promotion must route through governance/promotion, not candidate persistence。

#### Verification

- planned runtime schema tests。
- planned non-persistence tests。
- planned candidate disposal tests。

#### Review Lens

- runtime-only discipline。
- current-turn scoping。
- accidental durable promotion risk。

#### Stop Conditions

- Stop if any API exposes candidate create/update as durable storage operation.

### ALA-R3.3 - Manifestation resolver and budget

#### Scope

- 实现 manifestation budget config、remaining budget、decision schema。
- 实现 resolver：根据 task coupling、pressure、confidence、governance ceiling、budget 输出 `stance_bias` / `dialogue_nudge` / `lens_entry` / discarded。
- 记录 aggregate budget evaluation and decision events。

#### Source References

- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/manifestation-budget.ts:8`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/manifestation-budget.ts:51`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/manifestation-resolver.ts:80`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/manifestation-resolver.ts:114`
- `/home/tdwhere/vibe/do-what-new/docs/archive/v0.1-v0.2-consolidated/02-soul-model.md:1623`

#### Acceptance

- Resolver filters candidates by workspace/run before deciding。
- Deterministic ordering is stable for equal inputs。
- `lens_entry` requires task coupling, sufficient pressure/confidence, governance ceiling, and available budget。
- Decision batch is auditable without persisting individual candidate creation。

#### Verification

- planned resolver eligibility tests。
- planned budget exhaustion tests。
- planned deterministic ordering tests。
- planned audit event tests。

#### Review Lens

- budget safety。
- governance ceiling enforcement。
- runtime decision auditability。

#### Stop Conditions

- Stop if resolver can promote to `lens_entry` without budget or governance ceiling checks.

### ALA-R3.4 - Read-only topology projection

#### Scope

- 定义 topology projection as read-only derived view。
- Projection reads active `PathRelation` and ontology refs but does not create/update/delete durable state。
- Expose enough data for Phase 2 inspector without turning graph/topology into source truth。

#### Source References

- `/home/tdwhere/vibe/do-what-new/docs/archive/v0.1-v0.2-consolidated/02-soul-model.md:1367`
- `/home/tdwhere/vibe/do-what-new/docs/archive/v0.1-v0.2-consolidated/02-soul-model.md:1678`
- `docs/handbook/invariants.md:31`
- `docs/v0.1/extraction-ledger.md:52`

#### Acceptance

- Topology read returns derived nodes/edges from active durable sources。
- Topology query may be audited, but the read operation itself is side-effect free。
- Projection output identifies derivation source refs and does not claim durable truth ownership。
- Inspector-oriented fields remain Phase 2 contract material, not R3 durable state。

#### Verification

- planned read-only projection tests。
- planned no-mutation tests around topology reads。
- planned derivation-source tests。

#### Review Lens

- graph-first drift risk。
- derived view purity。
- R3/R11 boundary clarity。

#### Stop Conditions

- Stop if topology storage becomes the canonical path source or mutates `PathRelation`.
