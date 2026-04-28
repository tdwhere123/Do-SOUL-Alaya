import { describe, expect, it } from "vitest";
import {
  BankruptcyAction,
  BankruptcyDossierSchema,
  BankruptcyTriggerKind,
  BudgetBankruptcyStateSchema,
  ContextLensSchema,
  ControlPlaneObjectKind,
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
} from "../index.js";

function withObjectKind<T extends { object_kind: string }>(value: T, objectKind: string): T {
  return { ...value, object_kind: objectKind } as T;
}

const validTimestamp = "2026-03-20T00:00:00.000Z";

const envelopeBase = {
  runtime_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
  task_surface_ref: "surface://task/main",
  expires_at: null,
  derived_from: null,
  retention_policy: RetentionPolicy.SESSION_ONLY
} as const;

const taskObjectSurfaceBase = {
  ...envelopeBase,
  object_kind: ControlPlaneObjectKind.TASK_OBJECT_SURFACE,
  surface_kind: "chat_surface",
  display_name: "Main Chat Surface",
  context_refs: ["context-1", "context-2"]
} as const;

const recallPolicyBase = {
  ...envelopeBase,
  object_kind: ControlPlaneObjectKind.RECALL_POLICY,
  coarse_filter: {
    deterministic_match: {
      scope_filter: ["project"],
      dimension_filter: ["preference", "constraint"],
      domain_tag_filter: ["repo", "workflow"]
    },
    precomputed_rank: {
      max_candidates: 20,
      min_activation_score: 0.2
    },
    semantic_supplement: {
      enabled: true,
      max_supplement: 5,
      embedding_enabled: false
    }
  },
  fine_assessment: {
    budgets: {
      max_total_tokens: 3000,
      max_entries: 25,
      per_dimension_limits: {
        preference: 10,
        constraint: 5
      }
    },
    conflict_awareness: true
  }
} as const;

const contextLensBase = {
  ...envelopeBase,
  object_kind: ControlPlaneObjectKind.CONTEXT_LENS,
  lens_entries: [
    {
      object_id: "memory-1",
      object_kind: "memory_entry",
      relevance_score: 0.95,
      manifestation: ManifestationState.EXCERPT
    }
  ],
  not_a_priority_source: true
} as const;

const workingProjectionBase = {
  ...envelopeBase,
  object_kind: ControlPlaneObjectKind.WORKING_PROJECTION,
  entries: [
    {
      object_id: "memory-1",
      object_kind: "memory_entry",
      content_snapshot: "Use pnpm for workspace commands.",
      token_estimate: 8
    }
  ],
  total_token_estimate: 8,
  recall_policy_ref: "recall-policy-1"
} as const;

const verificationResultBase = {
  ...envelopeBase,
  object_kind: ControlPlaneObjectKind.VERIFICATION_RESULT,
  verdict: "go",
  micro_correction_hint: null,
  necessary_patch: null
} as const;

const governanceLeaseBase = {
  ...envelopeBase,
  object_kind: ControlPlaneObjectKind.GOVERNANCE_LEASE,
  lease_id: "lease-1",
  holder: "review",
  piercing_conditions: [
    {
      condition_kind: "severe_diagnostic_jump",
      description: "Diagnostics crossed configured risk threshold."
    }
  ]
} as const;

const budgetBankruptcyStateBase = {
  ...envelopeBase,
  object_kind: ControlPlaneObjectKind.BUDGET_BANKRUPTCY_STATE,
  bankruptcy_id: "bankruptcy-1",
  bankruptcy_kind: "soft",
  current_mode: "lean",
  trigger_summary: "token budget exceeded",
  dossier_ref: "dossier-1",
  updated_at: validTimestamp
} as const;

const bankruptcyDossierBase = {
  ...envelopeBase,
  object_kind: ControlPlaneObjectKind.BANKRUPTCY_DOSSIER,
  bankruptcy_id: "bankruptcy-1",
  bankruptcy_kind: "soft",
  trigger_kind: "token_overflow",
  mode_at_trigger: "lean",
  task_surface_ref: "surface://task/main",
  protected_constraints_preserved: ["constraint-1"],
  dropped_candidates: ["memory-2"],
  unresolved_conflicts: ["conflict-1"],
  required_actions: [BankruptcyAction.COMPRESS, BankruptcyAction.VERIFY],
  created_at: validTimestamp
} as const;

const proposalBase = {
  ...envelopeBase,
  object_kind: ControlPlaneObjectKind.PROPOSAL,
  proposal_id: "proposal-1",
  dossier_ref: "dossier-1",
  recommended_option_id: "option-1",
  proposal_options: [
    {
      option_id: "option-1",
      option_kind: "trim_soft_context",
      preserves_protected_constraints: true,
      dropped_candidates: ["memory-2"],
      unresolved_after_apply: [],
      requires_confirmation: false
    }
  ],
  resolution_state: "pending",
  expires_at: validTimestamp,
  last_updated_at: validTimestamp
} as const;

const sessionOverrideBase = {
  ...envelopeBase,
  object_kind: ControlPlaneObjectKind.SESSION_OVERRIDE,
  scope: "session_only",
  target_object: "memory-1",
  correction: "Prefer concise commit messages.",
  priority: 1
} as const;

const promotionGateBase = {
  ...envelopeBase,
  object_kind: ControlPlaneObjectKind.PROMOTION_GATE,
  conditions: [
    {
      condition_kind: "min_evidence_count",
      threshold: 2,
      required: true
    },
    {
      condition_kind: "scope_determined",
      threshold: null,
      required: true
    }
  ],
  per_dimension_defaults: {
    preference: [
      {
        condition_kind: "no_active_contradictions",
        threshold: null,
        required: true
      }
    ]
  }
} as const;

const handoffRecordBase = {
  ...envelopeBase,
  object_kind: ControlPlaneObjectKind.HANDOFF_RECORD,
  handoff_kind: "run_transfer",
  source_run_id: "run-1",
  target_run_id: null,
  surface_id: "surface://task/main",
  ttl_ms: null,
  recurrence_runs: null,
  recurrence_surfaces: null,
  governance_impact: null,
  unresolved_age_ms: null,
  upgrade_candidate: null
} as const;

const gapRecordBase = {
  ...envelopeBase,
  object_kind: ControlPlaneObjectKind.GAP_RECORD,
  gap_kind: "missing_verification",
  detected_in_run_id: "run-1",
  surface_id: null,
  description: "No verification result for strict change.",
  ttl_ms: 300000,
  recurrence_runs: null,
  recurrence_surfaces: null,
  governance_impact: null,
  unresolved_age_ms: null,
  upgrade_candidate: null
} as const;

describe("Runtime Control Plane Schemas", () => {
  it("parses RecallPolicy two-stage config round-trip", () => {
    expect(RecallPolicySchema.parse(recallPolicyBase)).toEqual(recallPolicyBase);
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
