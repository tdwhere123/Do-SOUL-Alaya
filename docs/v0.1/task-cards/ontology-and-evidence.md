# ALA-R2 - Ontology And Evidence

## Goal

实现 Do-SOUL Alaya 的 Memory Ontology：`EvidenceCapsule`、`MemoryEntry`、
`SynthesisCapsule`、`ClaimForm`，并把 source / evidence 作为 durable truth
写入的硬门槛。

## Source References

- `/home/tdwhere/vibe/do-what-new/README.md:56`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/envelope.ts:9`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/envelope.ts:21`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/object-kind.ts:3`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/object-kind.ts:20`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/evidence-capsule.ts:67`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/memory-entry.ts:104`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/synthesis-capsule.ts:63`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/claim-form.ts:83`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/memory-service.ts:176`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/memory-service.ts:478`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/synthesis-service.ts:113`
- `docs/handbook/architecture.md:14`
- `docs/handbook/architecture.md:20`
- `docs/handbook/architecture.md:22`
- `docs/handbook/invariants.md:7`
- `docs/handbook/invariants.md:13`
- `docs/v0.1/extraction-ledger.md:63`

## Source Classification

- `source-backed`: SOUL 三层模型、Memory Ontology 对象集合、persistent/control
  envelope 拆分、`EvidenceCapsule` / `MemoryEntry` / `SynthesisCapsule` /
  `ClaimForm` schema 字段、以及 do-what-new service 对 evidence ref 的存在性校验。
- `alaya-adapted`: do-what-new 证明了 schema 字段和 ref validation，但没有把
  “所有 durable write 必须 non-empty evidence”作为独立产品硬声明；Alaya 依据
  handbook 将其强化为任何 durable memory 写入或变更的 invariant。
- `alaya-default`: 本卡不引入新的产品默认值；缺 source / evidence 的行为是
  invariant rejection，不是可配置体验默认值。

## Dependencies

- ALA-R0 source/doc preflight.
- ALA-R1 runtime/API, storage, and audit-first mutation baseline.

## Parallel With

- ALA-R3 and ALA-R4 contract work after the persistent/runtime envelope and
  source/evidence gate are agreed.
- Not parallel with recall, provider, or integration work that needs durable
  ontology writes.

## Write Ownership

- Planned Memory Ontology schemas, evidence validation, ontology repository
  operations, runtime durable write APIs, create/update/reject audit, and
  focused tests.
- Do not own recall ranking, MCP/CLI transport, or graph inspector surfaces.

## Acceptance

- `EvidenceCapsule`、`MemoryEntry`、`SynthesisCapsule`、`ClaimForm` 使用
  durable envelope；runtime control 对象不得混入 ontology storage。
- `EvidenceCapsule` 支持 semantic / event / physical anchors、health state、
  source hash、run、workspace、surface。
- `MemoryEntry` 携带 source kind、formation kind、evidence refs、scope、
  lifecycle。
- `SynthesisCapsule` 和 `ClaimForm` 的 source/evidence 约束与 `MemoryEntry`
  等价，不能绕过 durable evidence gate。
- Alaya durable write / update 缺 source 或 non-empty evidence 时必须 reject，
  并产生可审计失败结果。

## Verification

- planned schema validation coverage。
- planned repository roundtrip coverage。
- planned missing source / missing evidence rejection coverage。
- planned audit event coverage for create/update/reject。

## Review Lens

- durable truth correctness。
- evidence sufficiency。
- source-backed vs `alaya-adapted` invariant 是否分清。
- migration compatibility。

## Stop Conditions

- 如果某类 memory 的 evidence payload 不清楚，先从 do-what-new source 扩展抽取，不问用户重设 SOUL。
- 如果实现路径允许 durable ontology 写入没有 source 或 non-empty evidence，停止并修正本卡或实现计划。

## Implementation Subcards

### ALA-R2.1 - Persistent/runtime envelopes

#### Scope

- 定义 Alaya persistent object envelope 和 runtime/control-plane envelope。
- 保证 `EvidenceCapsule`、`MemoryEntry`、`SynthesisCapsule`、`ClaimForm` 只能使用 persistent envelope。
- 保证 `ActivationCandidate`、`ContextLens`、`WorkingProjection` 等 runtime control 对象不能进入 durable ontology storage。

#### Source References

- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/envelope.ts:9`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/envelope.ts:21`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/object-kind.ts:3`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/object-kind.ts:20`
- `docs/handbook/invariants.md:7`

#### Acceptance

- Persistent envelope 至少包含 object id/kind、schema version、created/updated metadata、created_by、lifecycle state。
- Runtime envelope 至少包含 runtime id/kind、task surface ref、expiry、derived_from、retention policy。
- Schema/repo boundary 阻止 runtime object kind 写入 ontology repository。

#### Verification

- planned envelope schema tests。
- planned invalid object kind rejection tests。
- planned repository write guard tests。

#### Review Lens

- persistent vs runtime boundary。
- durable truth ownership。
- object kind closed-set drift。

#### Stop Conditions

- Stop if a runtime control object can be serialized through a persistent ontology repository.

### ALA-R2.2 - EvidenceCapsule schema and anchors

#### Scope

- 定义 `EvidenceCapsule` schema、anchors 和 health 字段。
- 支持 semantic / event / physical anchors，并保留 source hash、run、workspace、surface identity。
- 定义 evidence health state 与 invalid/broken evidence 的处理边界。

#### Source References

- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/evidence-capsule.ts:67`
- `/home/tdwhere/vibe/do-what-new/docs/archive/v0.1-v0.2-consolidated/02-soul-model.md:201`
- `/home/tdwhere/vibe/do-what-new/docs/archive/v0.1-v0.2-consolidated/02-soul-model.md:223`
- `docs/handbook/invariants.md:13`

#### Acceptance

- Evidence is a first-class ontology object, not a freeform note attached to memory。
- semantic anchor 是最低可用证明锚点；event/physical anchors 可增强可追溯性。
- source hash / run / workspace / surface 字段可用于后续审计和重新核验。
- invalid 或 broken evidence 不得继续支撑新的 durable write。

#### Verification

- planned EvidenceCapsule schema tests。
- planned anchor variant validation tests。
- planned invalid evidence rejection tests。

#### Review Lens

- evidence sufficiency。
- anchor semantics。
- stale/broken evidence handling。

#### Stop Conditions

- Stop if evidence can be represented only as unstructured text without source anchor metadata.

### ALA-R2.3 - MemoryEntry lifecycle and source/evidence validation

#### Scope

- 定义 `MemoryEntry` schema、source kind、formation kind、scope、lifecycle、evidence refs。
- 实现 create/update validation：source 与 non-empty evidence refs 都是 Alaya durable write gate。
- 为 create/update/reject 写入 audit result。

#### Source References

- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/memory-entry.ts:104`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/memory-service.ts:176`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/memory-service.ts:478`
- `docs/handbook/architecture.md:22`
- `docs/handbook/invariants.md:13`

#### Acceptance

- `MemoryEntry` create 缺 source kind、formation kind、scope、workspace/run 或 non-empty evidence refs 时 reject。
- `MemoryEntry` update 如果改变 durable semantic content，同样需要 source 与 non-empty evidence。
- Evidence refs 必须解析到存在且可用的 `EvidenceCapsule`。
- Rejected write produces deterministic validation error and audit signal。

#### Verification

- planned MemoryEntry schema tests。
- planned missing source/evidence rejection tests。
- planned missing evidence ref rejection tests。
- planned audit failure coverage。

#### Review Lens

- source/evidence gate completeness。
- update path parity with create path。
- no silent durable mutation before validation。

#### Stop Conditions

- Stop if an update path can alter durable content without fresh source/evidence validation.

### ALA-R2.4 - SynthesisCapsule and ClaimForm evidence gate

#### Scope

- 定义 `SynthesisCapsule` 和 `ClaimForm` schema。
- 将 source/evidence gate 复用到 synthesis 和 governance claim 写入。
- 保证 synthesis/claim 不能借由更高层语义绕过 `EvidenceCapsule`。

#### Source References

- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/synthesis-capsule.ts:63`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/claim-form.ts:83`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/synthesis-service.ts:113`
- `/home/tdwhere/vibe/do-what-new/packages/soul/src/garden/session-override-remediation.ts:189`
- `docs/handbook/invariants.md:8`
- `docs/handbook/invariants.md:13`

#### Acceptance

- `SynthesisCapsule` requires non-empty evidence refs and source memory refs before durable create。
- `ClaimForm` requires non-empty evidence refs and source object refs before durable create。
- Promotion or governance code cannot create synthesis/claim records with empty evidence。
- Claim lifecycle starts from draft/candidate state until promotion/governance conditions are satisfied。

#### Verification

- planned SynthesisCapsule schema and service validation tests。
- planned ClaimForm schema and service validation tests。
- planned promotion bypass regression tests。

#### Review Lens

- synthesis does not legislate durable claim by itself。
- claim source/evidence sufficiency。
- governance side-door risk。

#### Stop Conditions

- Stop if synthesis or claim creation can become durable without evidence refs and source refs.
