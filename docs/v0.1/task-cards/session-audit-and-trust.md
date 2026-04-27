# ALA-R7 - Session Audit And Trust

## Goal

实现 session audit 与 trust reporting，明确 installed、configured、delivered、used、skipped、unverifiable、mixed 的语义和证明要求。

## Source References

- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/runtime-port.ts:79`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/runtime-event-normalizer.ts:55`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/serial-delegation-event-intake.ts:50`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/serial-delegation-service.ts:287`
- `/home/tdwhere/vibe/do-what-new/docs/handbook/runtime-status.md:108`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/evidence-capsule.ts:6`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/memory-service.ts:176`

## Source Classification

- `source-backed`: runtime events、EventLog-backed normalization、late
  `session_finished` recovery、evidence capsule 与 memory creation evidence
  validation。
- `alaya-adapted`: 将 do-what-new 的 worker/session/run truth 经验改写为 Alaya
  local trust model：installed、configured、delivered、used、skipped、
  unverifiable、mixed。
- `alaya-default`: delivered != used 是 Alaya local trust invariant；没有直接 proof
  signal 时只能报告 `unverifiable` 或 weaker state，不能推断 `used`。

## Dependencies

- ALA-R0 source/doc preflight.
- ALA-R1 runtime event/audit baseline.
- ALA-R5 context pack delivery metadata.
- ALA-R6 proposal record ids and ALA-R8 activation-mode records where present.

## Parallel With

- ALA-R5 context assembly after context delivery record fields are agreed.
- ALA-R8 integration after installed/configured/delivered/used semantics are
  frozen.

## Write Ownership

- Planned session lifecycle events, context delivery records, usage proof
  records, trust summary, terminal event ordering, and focused tests.
- Do not own benchmark scoring, UI visualization, or claims that delivered
  context proves agent use.

## Acceptance

- installed/configured/delivered/used/skipped/unverifiable/mixed states are distinct。
- delivered context does not imply used。
- delivered != used is an Alaya local trust invariant and must be enforced by
  acceptance tests。
- `used` requires explicit proof or accepted proof signal。
- terminal event handling is deterministic and robust to late finish/error ordering。
- trust report links memory usage to context pack, evidence, and run identity。

## Verification

- session lifecycle tests。
- usage-state transition tests。
- late terminal event tests。
- trust report snapshot tests。

## Review Lens

- proof semantics。
- audit completeness。
- concurrency/ordering。

## Stop Conditions

- If the implementation infers `used` from delivery alone, stop and fix.

## Implementation Subcards

### ALA-R7.1 - Memory session lifecycle

#### Scope

- 定义 Alaya memory session lifecycle：installed、configured、session_started、
  context_requested、context_delivered、proposal_recorded、terminal_event、
  trust_summary_generated。
- session lifecycle 必须 EventLog/audit-first，run/session identity 稳定可关联。
- lifecycle 不得把 context pack、projection 或 proposal 当作 durable memory truth。

#### Source References

- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/runtime-port.ts:79`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/runtime-event-normalizer.ts:55`
- `/home/tdwhere/vibe/do-what-new/docs/handbook/runtime-status.md:108`
- `../../handbook/invariants.md`

#### Acceptance

- session states 有明确 transition rules，非法 transition fail closed 或记录
  rejected transition。
- installed/configured 只说明接入状态，不说明 context delivered 或 used。
- session lifecycle record 关联 run id、agent target、profile scope 与 activation mode。
- lifecycle events 可被 trust summary 重放。

#### Verification

- Planned tests: normal lifecycle、missing configured、duplicate started、terminal after
  terminal、replay summary。
- Planned snapshot tests: lifecycle event payload 不含 durable truth 声明。
- Planned audit tests: run/session/profile linkage 可追踪。

#### Review Lens

- lifecycle state 是否可重放。
- installed/configured 与 delivered/used 是否分离。
- event-backed audit 是否覆盖异常路径。

#### Stop Conditions

- If session state is inferred from config files alone, stop and fix.
- If lifecycle events create durable memory without governance path, stop and redesign.

### ALA-R7.2 - Context delivery and usage proof records

#### Scope

- 定义 `ContextDeliveryRecord` 与 `UsageProofRecord`：context pack id、delivery
  target、agent/session identity、delivery outcome、proof signal、proof source。
- delivered context 只证明 context 被送达，不证明 agent 使用。
- `used` 只可由 explicit proof signal 或被 Alaya 接受的 proof adapter 产生。

#### Source References

- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/evidence-capsule.ts:6`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/memory-service.ts:176`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/runtime-port.ts:79`
- `../extraction-ledger.md`

#### Acceptance

- delivered != used 作为 invariant 在 schema、transition 与 tests 中体现。
- direct proof 缺失时，不允许从 delivery、prompt injection、context pack presence
  推断 used。
- usage proof 必须说明 proof kind、source、confidence/strength 与对应 memory/context
  ids。
- weak proof 只能产生 weaker state 或 `mixed`，不能升级为 full `used`。

#### Verification

- Planned tests: delivered-only => not used；explicit proof => used；weak proof =>
  unverifiable/mixed。
- Planned schema tests: proof source/evidence refs 必填。
- Planned report tests: context pack id 与 memory ids 可追踪。

#### Review Lens

- proof semantics 是否严格。
- delivered-only 是否被错误升级。
- evidence/source 是否满足 durable trust 审计。

#### Stop Conditions

- If any path infers `used` from delivery alone, stop and fix.
- If proof records lack source/evidence linkage, stop and redesign.

### ALA-R7.3 - Trust state summary

#### Scope

- 生成 session/run/project 级 trust summary：installed、configured、delivered、
  used、skipped、unverifiable、mixed。
- summary 只汇总 auditable records，不创造新的事实。
- summary 必须能说明 weaker state 的原因，例如 no delivery、no proof、late terminal、
  skipped by policy、provider degraded。

#### Source References

- `/home/tdwhere/vibe/do-what-new/docs/handbook/runtime-status.md:108`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/runtime-event-normalizer.ts:55`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/evidence-capsule.ts:6`
- `../extraction-ledger.md`

#### Acceptance

- 七种 trust states 相互区分，且每个 state 有 required evidence。
- summary 显示 delivered count 与 used proof count，不把二者合并。
- `unverifiable` 有 explicit reason，不能显示成 success。
- `mixed` 能表达一组 memory/context 中部分有 proof、部分无 proof。

#### Verification

- Planned transition matrix tests: every state and invalid transition。
- Planned summary snapshot tests: counts、reasons、evidence links。
- Planned replay tests: same audit log 生成 same trust summary。

#### Review Lens

- trust labels 是否过度乐观。
- summary 是否从 audit records 推导而非手写状态。
- unverifiable/mixed 是否对 operator 可解释。

#### Stop Conditions

- If trust summary hides unverifiable records behind success wording, stop and fix.
- If summary cannot be reproduced from audit records, stop and redesign.

### ALA-R7.4 - Late terminal event and unverifiable handling

#### Scope

- 处理 late terminal events、duplicate terminal events、finish/error ordering、
  runtime adapter disconnect 与 proof signal after terminal。
- late/duplicate terminal 不得腐蚀 trust state；unverifiable 必须保留足够原因。
- 终态 recovery 必须 deterministic，并可被 audit replay。

#### Source References

- `/home/tdwhere/vibe/do-what-new/packages/core/src/serial-delegation-event-intake.ts:50`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/serial-delegation-service.ts:287`
- `/home/tdwhere/vibe/do-what-new/docs/handbook/runtime-status.md:108`
- `../../handbook/invariants.md`

#### Acceptance

- late `session_finished` 与 duplicate terminal event 有 deterministic handling。
- terminal 后到达的 usage proof 需要 explicit policy：accept-with-late-marker、
  reject 或 mark unverifiable。
- adapter disconnect 或 missing terminal 不得自动升级为 used。
- recovery path 记录 reason，并保留 operator review 所需 metadata。

#### Verification

- Planned tests: finish-before-error、error-before-finish、duplicate finish、
  proof-after-terminal、missing terminal。
- Planned replay tests: event order permutations 生成稳定 trust state。
- Planned audit tests: late/unverifiable reasons 可见。

#### Review Lens

- terminal ordering 是否 deterministic。
- recovery 是否 fail closed。
- unverifiable 是否不会被掩盖成 used。

#### Stop Conditions

- If late terminal handling can flip delivered-only to used without proof, stop and fix.
- If duplicate terminal events corrupt summary counts, stop and fix.
