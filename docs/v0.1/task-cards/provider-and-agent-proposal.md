# ALA-R6 - Provider And Agent-Assisted Proposal

## Goal

实现 provider capability model、Garden/agent-assisted proposal route、provider health/degradation，以及 LLM/agent 候选生成的 runtime gate。

## Source References

- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/compute-routing.ts:4`
- `/home/tdwhere/vibe/do-what-new/packages/soul/src/garden/compute-routing-service.ts:24`
- `/home/tdwhere/vibe/do-what-new/packages/soul/src/garden/compute-routing-service.ts:104`
- `/home/tdwhere/vibe/do-what-new/apps/core-daemon/src/index.ts:767`
- `/home/tdwhere/vibe/do-what-new/packages/soul/src/garden/compute-provider.ts:208`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/conversation-service.ts:1298`
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/phase-a2a-briefs/README.md:73`
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/phase-a2a-briefs/README.md:99`

## Source Classification

- `source-backed`: provider routing priority、routing decision schema、Garden
  provider priority、AI SDK boundary normalization 与 MCP/tool execute 禁止绕过
  Core/SOUL 的治理纪律。
- `alaya-adapted`: 将 do-what-new Garden/provider/compute-routing 改写为
  Alaya provider capability registry、deterministic provider selection、health
  state 与 proposal-only route。
- `alaya-default`: provider capabilities 使用 embedding、rerank、proposal、
  explain；agent/provider output 只能进入 proposal/candidate/gate route；
  不移植 do-what-new 的 Garden direct materialization shortcut。

## Dependencies

- ALA-R0 source/doc preflight.
- ALA-R1 runtime/API and audit baseline.
- ALA-R4 governance/promotion gate for proposal acceptance.
- ALA-R5 embedding supplement constraints where provider output feeds recall.

## Parallel With

- ALA-R5 recall integration after capability identifiers and degradation
  metadata are agreed.
- ALA-R7 audit/trust work after proposal and provider decision record ids are
  stable.

## Write Ownership

- Planned provider capability schema, provider registry, health/status,
  proposal route, background Garden-style job interface, and focused tests.
- Do not own provider-specific SDK leakage through public contracts, direct
  durable materialization, or full custom provider implementations beyond port
  contracts.

## Acceptance

- provider selection is deterministic by priority and tie-break。
- missing required capability fails closed or degrades only where policy allows。
- proposal candidates pass scope/governance/runtime validation before candidate/draft。
- provider status distinguishes configured/enabled/unavailable/degraded。
- no provider SDK type leaks through public runtime/API contracts。

## Verification

- provider registry tests。
- capability selection tests。
- provider failure/degradation tests。
- proposal validation tests。

## Review Lens

- provider boundary。
- governance passthrough risk。
- async/background safety。

## Stop Conditions

- If a provider can mutate storage directly, stop and fix boundary.

## Implementation Subcards

### ALA-R6.1 - Provider capability registry

#### Scope

- 定义 Alaya provider registry：provider id、kind、priority、capabilities、
  model refs、config refs、health state、last checked metadata。
- capabilities 使用 canonical English identifiers：`embedding`、`rerank`、
  `proposal`、`explain`。
- provider SDK type 与 provider-specific config 留在 provider port 内，不泄漏到
  public runtime/API contracts。

#### Source References

- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/compute-routing.ts:4`
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/phase-a2a-briefs/README.md:73`
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/phase-a2a-briefs/README.md:99`
- `../extraction-ledger.md`

#### Acceptance

- registry 能按 capability 查询 provider，并返回 deterministic candidate set。
- missing required capability fail closed；optional capability 可按 policy degrade。
- public contracts 不出现 OpenAI、Anthropic、AI SDK 或 provider SDK 结构类型。
- provider config 使用 refs，不把 secret value 写入 task card 或 audit payload。

#### Verification

- Planned schema tests: capability enum、provider refs、health fields。
- Planned contract tests: SDK-specific input/output 不越过 provider port。
- Planned selection tests: required/optional capability 查询行为。

#### Review Lens

- provider boundary 是否干净。
- capability 与 provider kind 是否解耦。
- secret/config refs 是否可审计但不泄露。

#### Stop Conditions

- If provider SDK types leak through public runtime/API contracts, stop and redesign.
- If registry stores raw secrets, stop and fix.

### ALA-R6.2 - Deterministic provider selection and health

#### Scope

- 实现 deterministic provider selection：priority、capability match、target scope、
  stable tie-break。
- provider health 区分 `configured`、`enabled`、`unavailable`、`degraded`，并记录
  reason 与 checked_at。
- selection result 必须能被 recall/proposal/session audit 引用。

#### Source References

- `/home/tdwhere/vibe/do-what-new/packages/soul/src/garden/compute-routing-service.ts:24`
- `/home/tdwhere/vibe/do-what-new/packages/soul/src/garden/compute-routing-service.ts:104`
- `/home/tdwhere/vibe/do-what-new/apps/core-daemon/src/index.ts:767`
- `../extraction-ledger.md`

#### Acceptance

- 相同 provider registry 与 request 得到相同 selected provider。
- no configured provider 时 fail closed；optional supplement 可记录 degraded fallback。
- health state 改变不直接写 durable memory truth。
- selection reason 包含 priority、capability、health 与 tie-break 信息。

#### Verification

- Planned tests: priority order、stable tie-break、no provider、degraded provider、
  disabled provider。
- Planned snapshot tests: selection reason 与 health metadata。
- Planned audit tests: provider decision id 可关联 proposal/degradation 记录。

#### Review Lens

- selection 是否 deterministic。
- health/degradation 是否清楚区分。
- fail-closed 与 optional degrade 策略是否正确。

#### Stop Conditions

- If provider selection depends on nondeterministic iteration/order without tie-break, stop and fix.
- If unavailable provider can still be selected for required capability, stop and fix.

### ALA-R6.3 - Agent/provider proposal route

#### Scope

- 定义 LLM、connected agent、subagent、provider output 的 proposal route。
- output 先进入 `ProposalRecord` 或 equivalent candidate input，再通过 scope、
  evidence、governance、runtime validation，才可进入 candidate/draft。
- 明确禁止 provider/agent 直接写 `MemoryEntry`、`EvidenceCapsule` 或 durable
  ontology。

#### Source References

- `/home/tdwhere/vibe/do-what-new/packages/core/src/conversation-service.ts:1298`
- `/home/tdwhere/vibe/do-what-new/packages/soul/src/garden/compute-provider.ts:208`
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/phase-a2a-briefs/README.md:99`
- `../../handbook/invariants.md`

#### Acceptance

- provider/agent proposal 必须带 source、scope、evidence pointer 或 rejection reason。
- proposal validation 失败时生成 auditable rejected proposal，不静默丢弃。
- accepted proposal 仍只是 candidate/draft，不是 durable truth。
- 所有 durable 化必须走 ALA-R4 governance/promotion gate。

#### Verification

- Planned tests: valid proposal、missing evidence、scope mismatch、governance reject、
  accepted candidate。
- Planned boundary tests: provider/agent 无 storage mutation port。
- Planned audit tests: rejection reason 和 candidate lineage 可追踪。

#### Review Lens

- proposal/candidate/durable 三段边界。
- evidence 与 source 是否显式。
- provider/agent 是否可能绕过 runtime gate。

#### Stop Conditions

- If provider or agent output can become durable memory without governance gate, stop and fix.
- If missing source/evidence is accepted silently, stop and redesign.

### ALA-R6.4 - Background Garden-style proposal jobs without durable bypass

#### Scope

- 定义 background Garden-style proposal jobs：enqueue、run、provider call、proposal
  result、degradation/failure、audit record。
- background jobs 不阻塞 main turn；也不得绕过 proposal route 直接 materialize
  durable memory。
- job lifecycle 必须能与 provider decision、session/run id、scope 与 governance
  outcome 关联。

#### Source References

- `/home/tdwhere/vibe/do-what-new/packages/core/src/conversation-service.ts:1298`
- `/home/tdwhere/vibe/do-what-new/packages/soul/src/garden/compute-routing-service.ts:24`
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/phase-a2a-briefs/README.md:99`
- `../extraction-ledger.md`

#### Acceptance

- background job fire-and-forget 不改变 main turn success/failure 语义。
- job output 只产生 proposal records 或 rejected proposal records。
- job failure/degradation 有 audit trail，不影响 baseline recall 或 session trust。
- direct materialization shortcut 被显式禁止并有 test/review 检查点。

#### Verification

- Planned tests: enqueue/run/success/failure/degraded job lifecycle。
- Planned boundary tests: job output 不能调用 durable memory write path。
- Planned async tests: background failure 不破坏 main turn response。

#### Review Lens

- async/background safety。
- durable bypass risk。
- job audit 与 provider decision lineage。

#### Stop Conditions

- If background job can mutate durable ontology directly, stop and fix.
- If Garden-style proposal failure blocks main turn without explicit strict policy, stop and redesign.
