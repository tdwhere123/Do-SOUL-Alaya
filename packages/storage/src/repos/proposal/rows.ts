export const PROPOSAL_SELECT_COLUMNS = `
        runtime_id,
        object_kind,
        proposal_id,
        task_surface_ref,
        derived_from,
        retention_policy,
        dossier_ref,
        recommended_option_id,
        proposal_options,
        resolution_state,
        expires_at,
        last_updated_at,
        workspace_id,
        run_id,
        reviewer_identity,
        target_object_kind,
        proposed_change_summary,
        proposed_changes,
        proposed_path_relation,
        created_at,
        target_baseline_updated_at,
        source_delivery_ids
`;

export interface ProposalRow {
  readonly runtime_id: string;
  readonly object_kind: string;
  readonly proposal_id: string;
  readonly task_surface_ref: string | null;
  readonly derived_from: string | null;
  readonly retention_policy: string;
  readonly dossier_ref: string | null;
  readonly recommended_option_id: string | null;
  readonly proposal_options: string;
  readonly resolution_state: string;
  readonly expires_at: string | null;
  readonly last_updated_at: string;
  // Scope metadata is available for workspace validation, not exposed in domain type.
  readonly workspace_id: string;
  readonly run_id: string | null;
  // Review identity + HITL summary projection columns.
  readonly reviewer_identity: string | null;
  readonly target_object_kind: string;
  readonly proposed_change_summary: string;
  readonly proposed_changes: string | null;
  readonly proposed_path_relation: string | null;
  readonly created_at: string | null;
  readonly target_baseline_updated_at: string | null;
  readonly source_delivery_ids: string | null;
}

export interface ProposalPathRelationRow {
  readonly path_id: string;
  readonly workspace_id: string;
  readonly anchors_json: string;
  readonly constitution_json: string;
  readonly effect_vector_json: string;
  readonly plasticity_state_json: string;
  readonly lifecycle_json: string;
  readonly legitimacy_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ProposalReviewerAssignmentRow {
  readonly proposal_id: string;
  readonly reviewer_identity: string;
  readonly assigned_at: string;
  readonly deadline_at: string | null;
  readonly escalation_after_ms: number | null;
}

export interface PendingProposalSummaryRow extends ProposalRow {
  readonly assigned_reviewer_identity: string | null;
  readonly assigned_at: string | null;
  readonly deadline_at: string | null;
  readonly is_overdue: 0 | 1;
}

export interface RevokableGreenStatusRow {
  readonly object_id: string;
}
