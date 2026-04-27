# ALA-R2 - Ontology And Evidence

## Goal

实现 Do-SOUL Alaya 的 Memory Ontology：`EvidenceCapsule`、`MemoryEntry`、`SynthesisCapsule`、`ClaimForm`，并确保 durable memory 必须具备 source 和 evidence。

## Source References

- `/home/tdwhere/vibe/do-what-new/README.md:56`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/envelope.ts:9`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/envelope.ts:21`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/object-kind.ts:3`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/memory-entry.ts:104`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/evidence-capsule.ts:67`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/memory-service.ts:176`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/memory-service.ts:478`

## Alaya Adaptation

- Persistent ontology objects use a durable envelope.
- Runtime control objects use separate runtime envelope and cannot be stored as durable ontology.
- Evidence is a first-class object, not a freeform note.

## Non-goals

- 不实现召回排名。
- 不实现 MCP/CLI surface。
- 不实现 graph inspector。

## Scope

- ontology schemas。
- evidence validation。
- repository operations。
- runtime durable write APIs。

## Inputs

- source events / excerpts / run references。
- user/project scope。
- producer identity。

## Outputs

- durable ontology records。
- audit events for create/update/reject。
- validation errors for missing evidence/source。

## Acceptance

- durable write without source is rejected。
- durable write without required evidence is rejected。
- `EvidenceCapsule` supports semantic/event/physical anchors, health state, source hash, run, workspace, surface。
- `MemoryEntry` carries source kind, formation kind, evidence refs, scope, lifecycle。
- `SynthesisCapsule` and `ClaimForm` cannot bypass evidence validation。

## Verification

- schema tests。
- repository roundtrip tests。
- missing source/evidence rejection tests。
- audit event tests。

## Review Lens

- durable truth correctness。
- evidence sufficiency。
- migration compatibility。

## Stop Conditions

- 如果某类 memory 的 evidence payload 不清楚，先从 do-what-new source 扩展抽取，不问用户重设 SOUL。
