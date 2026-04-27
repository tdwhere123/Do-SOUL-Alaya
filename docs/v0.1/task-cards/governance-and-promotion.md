# ALA-R4 - Governance And Promotion

## Goal

实现 candidate/draft/durable lifecycle、Promotion Gate、HITL governance、operator reason policy 和 bypass prevention。

## Source References

- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/session-override.ts:6`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/session-override-service.ts:29`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/session-override-service.ts:78`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/session-override-service.ts:227`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/events/phase-3b.ts:29`
- `/home/tdwhere/vibe/do-what-new/packages/soul/src/garden/session-override-remediation.ts:163`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/tool-governance.ts:31`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/dirty-state-dossier.ts:4`

## Alaya Adaptation

- session override 是临时 control-plane，不直接 durable。
- Promotion Gate 负责把候选升格为 durable、candidate、pending_review 或 not_promoted。
- hazard/safety/global/cross-project/override/strengthen 默认进入 HITL 或 pending review。

## Non-goals

- 不实现 UI review queue。
- 不实现 agent integration surface。

## Scope

- candidate/draft/durable state machine。
- Promotion Gate。
- governance action API。
- HITL gate。
- governance audit。

## Inputs

- candidate memory/path/governance action。
- evidence/source refs。
- scope impact。
- sensitivity/risk classification。
- operator reason when required。

## Outputs

- durable write / draft / candidate / pending review / rejected / not promoted。
- audit trail。
- bypass violation events。

## Acceptance

- low-risk candidates may silently enter candidate/draft with audit。
- high-risk candidates cannot become durable without HITL approval。
- hazards do not become durable from low-confidence override; they enter pending review。
- destructive/global/cross-project/strengthening actions require operator reason。
- governance bypass creates blocking audit signal。

## Verification

- lifecycle tests。
- promotion outcome tests。
- high-risk HITL tests。
- governance bypass regression tests。

## Review Lens

- security/trust。
- audit completeness。
- promotion correctness。

## Stop Conditions

- If a branch writes durable truth without source/evidence/governance, stop and fix before continuing.
