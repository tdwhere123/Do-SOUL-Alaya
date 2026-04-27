# ALA-R4 - Governance And Promotion

## Goal

实现 candidate/draft/durable lifecycle、`PromotionGate`、HITL governance、
operator reason policy 和 governance bypass prevention，确保任何 durable truth
升格都经过 source/evidence/governance gate。

## Source References

- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/session-override.ts:6`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/session-override-service.ts:29`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/session-override-service.ts:78`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/session-override-service.ts:227`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/promotion-gate.ts:31`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/events/phase-3b.ts:29`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/claim-form.ts:15`
- `/home/tdwhere/vibe/do-what-new/packages/soul/src/garden/session-override-remediation.ts:150`
- `/home/tdwhere/vibe/do-what-new/packages/soul/src/garden/session-override-remediation.ts:163`
- `/home/tdwhere/vibe/do-what-new/packages/soul/src/garden/session-override-remediation.ts:208`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/tool-governance.ts:31`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/dirty-state-dossier.ts:4`
- `/home/tdwhere/vibe/do-what-new/docs/archive/v0.1-v0.2-consolidated/02-soul-model.md:792`
- `docs/handbook/architecture.md:21`
- `docs/handbook/architecture.md:22`
- `docs/handbook/invariants.md:13`
- `docs/handbook/invariants.md:15`
- `docs/v0.1/extraction-ledger.md:65`
- `docs/v0.1/extraction-ledger.md:66`

## Source Classification

- `source-backed`: session override 是 control-plane 对象、EventLog-backed
  rehydration、`PromotionGate` 条件 schema、promotion outcomes
  (`durable` / `candidate` / `pending_review` / `not_promoted`)、hazard pending-review
  策略、tool governance decision 与 governance bypass panic trigger。
- `alaya-adapted`: HITL gate、operator reason policy、global/cross-project/destructive/
  strengthening action 的 fail-closed bypass prevention 是 Alaya 对 do-what-new
  高风险治理经验的产品化强化，不是 do-what-new 直接命名的完整产品能力。
- `alaya-default`: 本卡不选择 UI review queue 默认值；默认行为是 high-risk action
  进入 `pending_review` 或 fail-closed rejection，后续 surface 由 ALA-R8/R11 决定。

## Dependencies

- ALA-R0 source/doc preflight.
- ALA-R1 runtime/API and audit baseline.
- ALA-R2 source/evidence gate for durable ontology records.

## Parallel With

- ALA-R3 lifecycle/path work after shared candidate/draft/durable vocabulary is
  stable.
- ALA-R6 proposal route planning, provided provider output remains proposal-only.

## Write Ownership

- Planned candidate/draft/durable lifecycle, `PromotionGate`, governance action
  API, HITL gate, operator reason policy, governance audit/bypass signal, and
  focused tests.
- Do not own UI review queue, agent integration transport, or provider proposal
  generation logic.

## Acceptance

- Low-risk candidates may silently enter candidate/draft with audit。
- High-risk candidates cannot become durable without HITL approval。
- Hazards do not become durable from low-confidence override; they enter pending review。
- Destructive/global/cross-project/strengthening actions require operator reason。
- Governance bypass creates blocking audit signal and fails closed。
- All durable promotion paths also satisfy ALA-R2 source/evidence gate。

## Verification

- planned lifecycle tests。
- planned promotion outcome tests。
- planned high-risk HITL tests。
- planned operator reason tests。
- planned governance bypass regression tests。

## Review Lens

- security/trust。
- audit completeness。
- promotion correctness。
- source-backed vs `alaya-adapted` governance 是否分清。

## Stop Conditions

- If a branch writes durable truth without source/evidence/governance, stop and fix before continuing.
- If requested governance policy cannot be reconciled with source/adaptation classification, return `NEEDS_CONTEXT`.

## Implementation Subcards

### ALA-R4.1 - Candidate/draft/durable lifecycle

#### Scope

- 定义 candidate、draft、pending_review、durable、rejected、not_promoted lifecycle。
- 抽取 session override 到 durable promotion 的状态语义。
- 对 `ClaimForm` draft lifecycle 与 memory/path candidate lifecycle 做一致命名。

#### Source References

- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/session-override.ts:6`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/session-override-service.ts:29`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/session-override-service.ts:227`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/claim-form.ts:15`
- `/home/tdwhere/vibe/do-what-new/docs/archive/v0.1-v0.2-consolidated/02-soul-model.md:792`

#### Acceptance

- Session override remains runtime/control-plane until promotion path explicitly creates durable ontology/governance record。
- Candidate/draft states are auditable and not treated as durable truth。
- Durable state can only be reached after source/evidence/governance validation。
- Expired or unmet candidates become audit records, not silent durable memory。

#### Verification

- planned lifecycle transition tests。
- planned session override rehydration tests。
- planned expired candidate audit tests。

#### Review Lens

- temporary vs durable state boundary。
- lifecycle naming consistency。
- no silent promotion。

#### Stop Conditions

- Stop if candidate or draft state is consumed as durable truth before promotion.

### ALA-R4.2 - Promotion Gate outcomes

#### Scope

- 实现 `PromotionGate` schema and policy evaluation。
- 支持 `durable`、`candidate`、`pending_review`、`not_promoted` outcomes。
- 对 preference/fact/constraint/procedure/hazard 等维度应用 promotion defaults。

#### Source References

- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/promotion-gate.ts:31`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/events/phase-3b.ts:29`
- `/home/tdwhere/vibe/do-what-new/packages/soul/src/garden/session-override-remediation.ts:150`
- `/home/tdwhere/vibe/do-what-new/packages/soul/src/garden/session-override-remediation.ts:163`
- `/home/tdwhere/vibe/do-what-new/packages/soul/src/garden/session-override-remediation.ts:208`
- `/home/tdwhere/vibe/do-what-new/docs/archive/v0.1-v0.2-consolidated/02-soul-model.md:808`

#### Acceptance

- Gate conditions include evidence count/stability/no active contradictions/scope/governance subject readiness where applicable。
- `preference` may become durable only when source/evidence and scope are clear。
- `fact` / `constraint` / `procedure` default to candidate unless active verification or repeated evidence satisfies gate。
- `hazard` / safety content defaults to `pending_review` unless stronger Alaya governance explicitly approves。
- Every outcome writes an audit event with reason。

#### Verification

- planned gate condition tests。
- planned outcome matrix tests。
- planned hazard pending-review tests。
- planned audit reason tests。

#### Review Lens

- promotion correctness。
- evidence threshold discipline。
- dimension-specific risk。

#### Stop Conditions

- Stop if a high-risk dimension can produce `durable` without explicit gate satisfaction.

### ALA-R4.3 - HITL and operator reason policy

#### Scope

- Define HITL-required action classes。
- Require non-empty operator reason for destructive/global/cross-project/strengthening actions。
- Keep HITL/operator reason policy independent from transport surface。

#### Source References

- `/home/tdwhere/vibe/do-what-new/docs/archive/v0.1-v0.2-consolidated/02-soul-model.md:825`
- `docs/v0.1/extraction-ledger.md:66`
- `docs/handbook/invariants.md:13`
- `docs/handbook/invariants.md:15`

#### Acceptance

- High-risk memory/path/governance action cannot become durable without HITL approval。
- Operator reason is required for destructive, global, cross-project, override, and strengthening governance changes。
- Missing operator reason produces deterministic rejection or pending_review, not silent fallback。
- HITL decision records actor, reason, source/evidence refs, timestamp, and outcome。

#### Verification

- planned HITL-required policy tests。
- planned missing operator reason rejection tests。
- planned approval audit tests。

#### Review Lens

- trust boundary。
- reason sufficiency。
- transport-independent governance。

#### Stop Conditions

- Stop if high-risk governance depends on UI presence instead of runtime policy.

### ALA-R4.4 - Governance bypass audit/fail-closed behavior

#### Scope

- Detect attempts to mutate durable governance or memory state outside runtime/governance gates。
- Emit blocking audit signal for bypass attempts。
- Fail closed when governance validation cannot complete。

#### Source References

- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/tool-governance.ts:31`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/dirty-state-dossier.ts:4`
- `docs/handbook/architecture.md:21`
- `docs/handbook/architecture.md:22`
- `docs/handbook/invariants.md:15`
- `docs/v0.1/extraction-ledger.md:66`

#### Acceptance

- Bypass attempts are classified as blocking audit events。
- Fail-closed behavior prevents durable mutation when governance status is missing, malformed, or unverifiable。
- Bypass audit includes affected scope, trigger/reason, actor/source, and recoverability signal。
- Tool/governance decisions cannot suppress evidence/source validation。

#### Verification

- planned bypass detection tests。
- planned fail-closed validation tests。
- planned audit payload tests。
- planned governance/source/evidence ordering tests。

#### Review Lens

- bypass prevention。
- audit completeness。
- fail-closed correctness。

#### Stop Conditions

- Stop if any durable mutation path can continue after governance validation fails or is unavailable.
