import { describe, expect, it } from "vitest";
import {
  BankruptcyAction,
  BankruptcyDossierSchema,
  BankruptcyTriggerKind,
  BudgetBankruptcyStateSchema,
  ContextLensSchema,
  ControlPlaneObjectKind,
  DYNAMICS_CONSTANTS,
  GapRecordSchema,
  GovernanceLeaseSchema,
  HandoffRecordSchema,
  ManifestationState,
  ProposalOptionKind,
  ProposalResolutionState,
  ProposalSchema,
  PromotionConditionKind,
  PromotionGateSchema,
  RecallPolicySchema,
  RetentionPolicy,
  SessionOverrideSchema,
  TaskObjectSurfaceSchema,
  VerificationResultSchema,
  WorkingProjectionSchema
} from "../../index.js";

import {
  bankruptcyDossierBase,
  budgetBankruptcyStateBase,
  contextLensBase,
  gapRecordBase,
  governanceLeaseBase,
  handoffRecordBase,
  promotionGateBase,
  proposalBase,
  recallPolicyBase,
  sessionOverrideBase,
  taskObjectSurfaceBase,
  validTimestamp,
  verificationResultBase,
  withObjectKind,
  workingProjectionBase
} from "./runtime-control-plane.fixtures.js";

describe("Runtime Control Plane Schemas", () => {
  it("parses RecallPolicy two-stage config round-trip", () => {
    expect(RecallPolicySchema.parse(recallPolicyBase)).toEqual(recallPolicyBase);
  });

  it("parses optional per-domain recall weight overrides as additive policy data", () => {
    const parsed = RecallPolicySchema.parse({
      ...recallPolicyBase,
      domain_weight_overrides: {
        research: {
          scope_match: 0.08,
          relevance: 0.2
        }
      }
    });

    expect(parsed.domain_weight_overrides?.research).toEqual({
      scope_match: 0.08,
      relevance: 0.2
    });
    expect(RecallPolicySchema.parse(recallPolicyBase).domain_weight_overrides).toBeUndefined();
    expect(
      RecallPolicySchema.safeParse({
        ...recallPolicyBase,
        domain_weight_overrides: {
          research: {
            relevance: 1.2
          }
        }
      }).success
    ).toBe(false);
    expect(Object.values(DYNAMICS_CONSTANTS.activation_weights_phase4b).reduce((sum, value) => sum + value, 0)).toBeCloseTo(
      1,
      10
    );
  });

  it("parses optional recall scoring weight overrides for bench policy construction", () => {
    const parsed = RecallPolicySchema.parse({
      ...recallPolicyBase,
      scoring_weight_overrides: {
        additive: {
          NO_EMBEDDING_RELEVANCE_DIRECT_WEIGHT: 0.2,
          CONFIDENCE_DIRECT_WEIGHT: 0.1,
          PATH_PLASTICITY_WEIGHT: 0.12
        },
        fusion_weights: {
          future_signal: 0.5
        }
      }
    });

    expect(parsed.scoring_weight_overrides?.additive).toEqual({
      NO_EMBEDDING_RELEVANCE_DIRECT_WEIGHT: 0.2,
      CONFIDENCE_DIRECT_WEIGHT: 0.1,
      PATH_PLASTICITY_WEIGHT: 0.12
    });
    expect(parsed.scoring_weight_overrides?.fusion_weights).toEqual({
      future_signal: 0.5
    });
    expect(RecallPolicySchema.parse(recallPolicyBase).scoring_weight_overrides).toBeUndefined();
    expect(
      RecallPolicySchema.safeParse({
        ...recallPolicyBase,
        scoring_weight_overrides: {
          additive: {
            CONFIDENCE_DIRECT_WEIGHT: -0.1
          }
        }
      }).success
    ).toBe(false);
    expect(
      RecallPolicySchema.safeParse({
        ...recallPolicyBase,
        scoring_weight_overrides: {
          fusion_weights: {
            future_signal: -0.5
          }
        }
      }).success
    ).toBe(false);
  });

  it("enforces [0,1] relevance_score in ContextLensEntry", () => {
    expect(ContextLensSchema.parse(contextLensBase)).toEqual(contextLensBase);
    expect(
      ContextLensSchema.safeParse({
        ...contextLensBase,
        lens_entries: [
          {
            ...contextLensBase.lens_entries[0],
            relevance_score: 1.5
          }
        ]
      }).success
    ).toBe(false);
    expect(
      ContextLensSchema.safeParse({
        ...contextLensBase,
        lens_entries: [
          {
            ...contextLensBase.lens_entries[0],
            relevance_score: -0.1
          }
        ]
      }).success
    ).toBe(false);
  });

  it("requires not_a_priority_source to stay hardcoded true", () => {
    expect(
      ContextLensSchema.safeParse({
        ...contextLensBase,
        not_a_priority_source: false
      }).success
    ).toBe(false);
  });

  it("rejects empty content_snapshot in ProjectionEntry", () => {
    expect(
      WorkingProjectionSchema.safeParse({
        ...workingProjectionBase,
        entries: [
          {
            ...workingProjectionBase.entries[0],
            content_snapshot: ""
          }
        ]
      }).success
    ).toBe(false);
  });

  it("requires BankruptcyDossier.required_actions to use finite enum values", () => {
    expect(BankruptcyDossierSchema.parse(bankruptcyDossierBase)).toEqual(bankruptcyDossierBase);
    expect(
      BankruptcyDossierSchema.safeParse({
        ...bankruptcyDossierBase,
        required_actions: ["compress", "invalid_action"]
      }).success
    ).toBe(false);
    expect(
      BankruptcyDossierSchema.safeParse({
        ...bankruptcyDossierBase,
        required_actions: []
      }).success
    ).toBe(false);
  });

  it("accepts only session_only for SessionOverride.scope", () => {
    expect(SessionOverrideSchema.parse(sessionOverrideBase)).toEqual(sessionOverrideBase);
    expect(
      SessionOverrideSchema.safeParse({
        ...sessionOverrideBase,
        scope: "run_scoped"
      }).success
    ).toBe(false);
  });

  it("exports all PromotionConditionKind values", () => {
    expect(Object.values(PromotionConditionKind)).toEqual([
      "min_evidence_count",
      "min_stability_duration",
      "no_active_contradictions",
      "scope_determined",
      "governance_subject_compilable"
    ]);
  });

  it("enforces non-negative PromotionCondition.threshold", () => {
    expect(PromotionGateSchema.parse(promotionGateBase)).toEqual(promotionGateBase);
    expect(
      PromotionGateSchema.safeParse({
        ...promotionGateBase,
        conditions: [
          {
            ...promotionGateBase.conditions[0],
            threshold: -5
          },
          ...promotionGateBase.conditions.slice(1)
        ]
      }).success
    ).toBe(false);
  });

  it("exports all ProposalResolutionState values", () => {
    expect(Object.values(ProposalResolutionState)).toEqual([
      "pending",
      "auto_applied",
      "accepted",
      "rejected",
      "expired",
      "superseded"
    ]);
  });

  it("exports all ProposalOptionKind values", () => {
    expect(Object.values(ProposalOptionKind)).toEqual([
      "trim_soft_context",
      "freeze_low_value_competition",
      "defer_noncritical_verification",
      "request_confirmation",
      "abort_high_risk_write"
    ]);
  });

  it("requires Proposal.proposal_options to be non-empty", () => {
    expect(ProposalSchema.parse(proposalBase)).toEqual(proposalBase);
    expect(
      ProposalSchema.safeParse({
        ...proposalBase,
        proposal_options: []
      }).success
    ).toBe(false);
  });

  it("exports all BankruptcyTriggerKind values", () => {
    expect(Object.values(BankruptcyTriggerKind)).toEqual([
      "token_overflow",
      "strict_conflict",
      "missing_verification",
      "safety_guard",
      "arbitration_block",
      "garden_backlog"
    ]);
  });

  it("accepts nullable upgrade-axis fields for HandoffRecord", () => {
    const parsed = HandoffRecordSchema.parse(handoffRecordBase);
    expect(parsed.recurrence_runs).toBeNull();
    expect(parsed.recurrence_surfaces).toBeNull();
    expect(parsed.governance_impact).toBeNull();
    expect(parsed.unresolved_age_ms).toBeNull();
    expect(parsed.upgrade_candidate).toBeNull();
  });

  it("accepts nullable upgrade-axis fields for GapRecord", () => {
    const parsed = GapRecordSchema.parse(gapRecordBase);
    expect(parsed.recurrence_runs).toBeNull();
    expect(parsed.recurrence_surfaces).toBeNull();
    expect(parsed.governance_impact).toBeNull();
    expect(parsed.unresolved_age_ms).toBeNull();
    expect(parsed.upgrade_candidate).toBeNull();
  });

  it("enforces VerificationResult verdict enum", () => {
    expect(VerificationResultSchema.parse(verificationResultBase)).toEqual(verificationResultBase);
    expect(
      VerificationResultSchema.safeParse({
        ...verificationResultBase,
        verdict: "maybe"
      }).success
    ).toBe(false);
  });

  it("enforces control-plane object_kind values across all objects", () => {
    const allValues = Object.values(ControlPlaneObjectKind);

    const cases = [
      { schema: TaskObjectSurfaceSchema, value: taskObjectSurfaceBase },
      { schema: RecallPolicySchema, value: recallPolicyBase },
      { schema: ContextLensSchema, value: contextLensBase },
      { schema: WorkingProjectionSchema, value: workingProjectionBase },
      { schema: VerificationResultSchema, value: verificationResultBase },
      { schema: GovernanceLeaseSchema, value: governanceLeaseBase },
      { schema: BudgetBankruptcyStateSchema, value: budgetBankruptcyStateBase },
      { schema: BankruptcyDossierSchema, value: bankruptcyDossierBase },
      { schema: ProposalSchema, value: proposalBase },
      { schema: SessionOverrideSchema, value: sessionOverrideBase },
      { schema: PromotionGateSchema, value: promotionGateBase },
      { schema: HandoffRecordSchema, value: handoffRecordBase },
      { schema: GapRecordSchema, value: gapRecordBase }
    ] as const;

    for (const { schema, value } of cases) {
      const parsed = schema.parse(value);
      expect(allValues.includes(parsed.object_kind)).toBe(true);
      expect(schema.safeParse(withObjectKind(value, "memory_entry")).success).toBe(false);
    }
  });

  it("parses all top-level runtime control-plane schemas round-trip", () => {
    const roundTripCases = [
      { schema: TaskObjectSurfaceSchema, value: taskObjectSurfaceBase },
      { schema: RecallPolicySchema, value: recallPolicyBase },
      { schema: ContextLensSchema, value: contextLensBase },
      { schema: WorkingProjectionSchema, value: workingProjectionBase },
      { schema: VerificationResultSchema, value: verificationResultBase },
      { schema: GovernanceLeaseSchema, value: governanceLeaseBase },
      { schema: BudgetBankruptcyStateSchema, value: budgetBankruptcyStateBase },
      { schema: BankruptcyDossierSchema, value: bankruptcyDossierBase },
      { schema: ProposalSchema, value: proposalBase },
      { schema: SessionOverrideSchema, value: sessionOverrideBase },
      { schema: PromotionGateSchema, value: promotionGateBase },
      { schema: HandoffRecordSchema, value: handoffRecordBase },
      { schema: GapRecordSchema, value: gapRecordBase }
    ] as const;

    for (const { schema, value } of roundTripCases) {
      expect(schema.parse(value)).toEqual(value);
    }
  });

  it("enforces GovernanceLease piercing condition kind as a closed set", () => {
    expect(
      GovernanceLeaseSchema.safeParse({
        ...governanceLeaseBase,
        piercing_conditions: [
          {
            condition_kind: "invalid_condition",
            description: "Unexpected runtime input."
          }
        ]
      }).success
    ).toBe(false);
  });
});
