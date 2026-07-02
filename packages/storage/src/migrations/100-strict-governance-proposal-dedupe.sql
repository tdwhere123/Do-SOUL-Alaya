WITH ranked_pending_strict_governance AS (
  SELECT
    rowid AS proposal_rowid,
    ROW_NUMBER() OVER (
      PARTITION BY workspace_id, derived_from, dossier_ref, target_object_kind
      ORDER BY COALESCE(created_at, last_updated_at) ASC, proposal_id ASC
    ) AS row_rank
  FROM proposals
  WHERE resolution_state = 'pending'
    AND dossier_ref = 'inspector.strict_governance_promotion'
    AND target_object_kind = 'path_relation'
    AND derived_from IS NOT NULL
)
UPDATE proposals
SET
  resolution_state = 'rejected',
  reviewer_identity = COALESCE(reviewer_identity, 'migration.strict_governance_dedupe')
WHERE rowid IN (
  SELECT proposal_rowid
  FROM ranked_pending_strict_governance
  WHERE row_rank > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_proposals_pending_strict_governance_unique
  ON proposals(workspace_id, derived_from, dossier_ref, target_object_kind)
  WHERE resolution_state = 'pending'
    AND dossier_ref = 'inspector.strict_governance_promotion'
    AND target_object_kind = 'path_relation'
    AND derived_from IS NOT NULL;
