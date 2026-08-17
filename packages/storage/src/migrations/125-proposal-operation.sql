-- Proposal operation is durable routing authority for review-time side effects.
-- NULL is retained for legacy and non-memory proposal families; new memory
-- mutation proposals persist one of the two explicit operations.
ALTER TABLE proposals ADD COLUMN proposal_operation TEXT
  CHECK (proposal_operation IS NULL OR proposal_operation IN ('memory_update', 'privacy_erase'));

CREATE TRIGGER proposals_validate_privacy_erase_insert
BEFORE INSERT ON proposals
WHEN NEW.proposal_operation = 'privacy_erase' AND NOT (
  NEW.target_object_kind = 'source_record' AND
  NEW.proposed_changes IS NULL AND
  NEW.proposed_change_summary IN (
    'user_requested_deletion', 'retention_expired', 'legal_erasure'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid privacy erase proposal payload');
END;

CREATE TRIGGER proposals_validate_privacy_erase_update
BEFORE UPDATE OF proposal_operation, target_object_kind, proposed_changes, proposed_change_summary
ON proposals
WHEN NEW.proposal_operation = 'privacy_erase' AND NOT (
  NEW.target_object_kind = 'source_record' AND
  NEW.proposed_changes IS NULL AND
  NEW.proposed_change_summary IN (
    'user_requested_deletion', 'retention_expired', 'legal_erasure'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid privacy erase proposal payload');
END;
