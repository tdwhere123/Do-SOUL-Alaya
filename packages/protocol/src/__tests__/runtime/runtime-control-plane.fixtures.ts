import {
  BankruptcyAction,
  ControlPlaneObjectKind,
  ManifestationState,
  RetentionPolicy
} from "../../index.js";

export function withObjectKind<T extends { object_kind: string }>(value: T, objectKind: string): T {
  return { ...value, object_kind: objectKind } as T;
}

export const validTimestamp = "2026-03-20T00:00:00.000Z";

export const envelopeBase = {
  runtime_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
  task_surface_ref: "surface://task/main",
  expires_at: null,
  derived_from: null,
  retention_policy: RetentionPolicy.SESSION_ONLY
} as const;

export const taskObjectSurfaceBase = {
  ...envelopeBase,
  object_kind: ControlPlaneObjectKind.TASK_OBJECT_SURFACE,
  surface_kind: "chat_surface",
  display_name: "Main Chat Surface",
  context_refs: ["context-1", "context-2"]
} as const;

export const recallPolicyBase = {
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

export const contextLensBase = {
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

export const workingProjectionBase = {
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

export const verificationResultBase = {
  ...envelopeBase,
  object_kind: ControlPlaneObjectKind.VERIFICATION_RESULT,
  verdict: "go",
  micro_correction_hint: null,
  necessary_patch: null
} as const;

export const governanceLeaseBase = {
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

export const budgetBankruptcyStateBase = {
  ...envelopeBase,
  object_kind: ControlPlaneObjectKind.BUDGET_BANKRUPTCY_STATE,
  bankruptcy_id: "bankruptcy-1",
  bankruptcy_kind: "soft",
  current_mode: "lean",
  trigger_summary: "token budget exceeded",
  dossier_ref: "dossier-1",
  updated_at: validTimestamp
} as const;

export const bankruptcyDossierBase = {
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

export const proposalBase = {
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

export const sessionOverrideBase = {
  ...envelopeBase,
  object_kind: ControlPlaneObjectKind.SESSION_OVERRIDE,
  scope: "session_only",
  target_object: "memory-1",
  correction: "Prefer concise commit messages.",
  priority: 1
} as const;

export const promotionGateBase = {
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

export const handoffRecordBase = {
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

export const gapRecordBase = {
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
