-- Source records, field projections, proof-effect decisions, and triggers.
CREATE TRIGGER memory_hq_reject_erased_source_content_update
BEFORE UPDATE OF hqs_json ON memory_hq
WHEN NEW.hqs_json != '[]' AND EXISTS (
  SELECT 1 FROM memory_entry_evidence_refs AS memory_ref
  JOIN source_record_evidence_refs AS source_ref
    ON source_ref.workspace_id = memory_ref.workspace_id
   AND source_ref.evidence_object_id = memory_ref.evidence_ref
  JOIN projection_erase_barriers AS barrier
    ON barrier.workspace_id = source_ref.workspace_id
   AND barrier.subject_kind = 'source_record'
   AND barrier.subject_id = source_ref.record_id
  WHERE memory_ref.workspace_id = NEW.workspace_id
    AND memory_ref.memory_id = NEW.object_id
)
BEGIN
  SELECT RAISE(ABORT, 'erased source memory HQ cannot store content');
END;

CREATE TRIGGER memory_hq_observations_reject_erased_source_content_update
BEFORE UPDATE OF hqs_json, hq_content_sha256, observation_sha256 ON memory_hq_observations
WHEN NOT (
  NEW.hqs_json = '[]' AND NEW.hq_content_sha256 = 'erased' AND
  NEW.observation_sha256 = 'erased'
) AND EXISTS (
  SELECT 1 FROM memory_entry_evidence_refs AS memory_ref
  JOIN source_record_evidence_refs AS source_ref
    ON source_ref.workspace_id = memory_ref.workspace_id
   AND source_ref.evidence_object_id = memory_ref.evidence_ref
  JOIN projection_erase_barriers AS barrier
    ON barrier.workspace_id = source_ref.workspace_id
   AND barrier.subject_kind = 'source_record'
   AND barrier.subject_id = source_ref.record_id
  WHERE memory_ref.workspace_id = NEW.workspace_id
    AND memory_ref.memory_id = NEW.object_id
)
BEGIN
  SELECT RAISE(ABORT, 'erased source memory HQ observation cannot store content');
END;

CREATE TRIGGER memory_hq_observations_reject_erased_source_insert
BEFORE INSERT ON memory_hq_observations
WHEN EXISTS (
  SELECT 1 FROM memory_entry_evidence_refs AS memory_ref
  JOIN source_record_evidence_refs AS source_ref
    ON source_ref.workspace_id = memory_ref.workspace_id
   AND source_ref.evidence_object_id = memory_ref.evidence_ref
  JOIN projection_erase_barriers AS barrier
    ON barrier.workspace_id = source_ref.workspace_id
   AND barrier.subject_kind = 'source_record'
   AND barrier.subject_id = source_ref.record_id
  WHERE memory_ref.workspace_id = NEW.workspace_id
    AND memory_ref.memory_id = NEW.object_id
)
BEGIN
  SELECT RAISE(ABORT, 'erased source memory HQ observation cannot be admitted');
END;

CREATE TRIGGER memory_object_keys_reject_erased_source_insert
BEFORE INSERT ON memory_object_keys
WHEN EXISTS (
  SELECT 1 FROM memory_entry_evidence_refs AS memory_ref
  JOIN source_record_evidence_refs AS source_ref
    ON source_ref.workspace_id = memory_ref.workspace_id
   AND source_ref.evidence_object_id = memory_ref.evidence_ref
  JOIN projection_erase_barriers AS barrier
    ON barrier.workspace_id = source_ref.workspace_id
   AND barrier.subject_kind = 'source_record'
   AND barrier.subject_id = source_ref.record_id
  WHERE memory_ref.workspace_id = NEW.workspace_id
    AND memory_ref.memory_id = NEW.owner_id
)
BEGIN
  SELECT RAISE(ABORT, 'erased source memory key cannot be admitted');
END;

CREATE TRIGGER synthesis_capsules_reject_erased_source_content_update
BEFORE UPDATE OF lifecycle_state, synthesis_status, topic_key, summary ON synthesis_capsules
WHEN NOT (
  NEW.lifecycle_state = 'tombstone' AND NEW.synthesis_status = 'archived' AND
  NEW.topic_key = 'erased' AND NEW.summary = 'erased'
)
AND (
  EXISTS (
    SELECT 1 FROM json_each(NEW.evidence_refs) AS ref
    JOIN source_record_evidence_refs AS source_ref
      ON source_ref.workspace_id = NEW.workspace_id
     AND source_ref.evidence_object_id = ref.value
    JOIN projection_erase_barriers AS barrier
      ON barrier.workspace_id = source_ref.workspace_id
     AND barrier.subject_kind = 'source_record'
     AND barrier.subject_id = source_ref.record_id
  ) OR EXISTS (
    SELECT 1 FROM json_each(NEW.source_memory_refs) AS ref
    JOIN memory_entry_evidence_refs AS memory_ref
      ON memory_ref.workspace_id = NEW.workspace_id
     AND memory_ref.memory_id = ref.value
    JOIN source_record_evidence_refs AS source_ref
      ON source_ref.workspace_id = memory_ref.workspace_id
     AND source_ref.evidence_object_id = memory_ref.evidence_ref
    JOIN projection_erase_barriers AS barrier
      ON barrier.workspace_id = source_ref.workspace_id
     AND barrier.subject_kind = 'source_record'
     AND barrier.subject_id = source_ref.record_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'erased source synthesis cannot store content');
END;

CREATE TRIGGER synthesis_capsules_reject_erased_source_insert
BEFORE INSERT ON synthesis_capsules
WHEN EXISTS (
    SELECT 1 FROM json_each(NEW.evidence_refs) AS ref
    JOIN source_record_evidence_refs AS source_ref
      ON source_ref.workspace_id = NEW.workspace_id
     AND source_ref.evidence_object_id = ref.value
    JOIN projection_erase_barriers AS barrier
      ON barrier.workspace_id = source_ref.workspace_id
     AND barrier.subject_kind = 'source_record'
     AND barrier.subject_id = source_ref.record_id
  ) OR EXISTS (
    SELECT 1 FROM json_each(NEW.source_memory_refs) AS ref
    JOIN memory_entry_evidence_refs AS memory_ref
      ON memory_ref.workspace_id = NEW.workspace_id
     AND memory_ref.memory_id = ref.value
    JOIN source_record_evidence_refs AS source_ref
      ON source_ref.workspace_id = memory_ref.workspace_id
     AND source_ref.evidence_object_id = memory_ref.evidence_ref
    JOIN projection_erase_barriers AS barrier
      ON barrier.workspace_id = source_ref.workspace_id
     AND barrier.subject_kind = 'source_record'
     AND barrier.subject_id = source_ref.record_id
  )
BEGIN
  SELECT RAISE(ABORT, 'erased source synthesis cannot be admitted');
END;

CREATE TRIGGER recall_routing_key_owners_reject_erased_source_insert
BEFORE INSERT ON recall_routing_key_owners
WHEN (
  NEW.owner_kind = 'memory_entry' AND EXISTS (
    SELECT 1 FROM memory_entry_evidence_refs AS memory_ref
    JOIN source_record_evidence_refs AS source_ref
      ON source_ref.workspace_id = memory_ref.workspace_id
     AND source_ref.evidence_object_id = memory_ref.evidence_ref
    JOIN projection_erase_barriers AS barrier
      ON barrier.workspace_id = source_ref.workspace_id
     AND barrier.subject_kind = 'source_record'
     AND barrier.subject_id = source_ref.record_id
    WHERE memory_ref.workspace_id = NEW.workspace_id
      AND memory_ref.memory_id = NEW.owner_id
  )
) OR (
  NEW.owner_kind = 'synthesis_capsule' AND EXISTS (
    SELECT 1 FROM synthesis_capsules AS capsule, json_each(capsule.evidence_refs) AS ref
    JOIN source_record_evidence_refs AS source_ref
      ON source_ref.workspace_id = capsule.workspace_id
     AND source_ref.evidence_object_id = ref.value
    JOIN projection_erase_barriers AS barrier
      ON barrier.workspace_id = source_ref.workspace_id
     AND barrier.subject_kind = 'source_record'
     AND barrier.subject_id = source_ref.record_id
    WHERE capsule.workspace_id = NEW.workspace_id AND capsule.object_id = NEW.owner_id
  ) OR NEW.owner_kind = 'synthesis_capsule' AND EXISTS (
    SELECT 1 FROM synthesis_capsules AS capsule,
      json_each(capsule.source_memory_refs) AS ref
    JOIN memory_entry_evidence_refs AS memory_ref
      ON memory_ref.workspace_id = capsule.workspace_id
     AND memory_ref.memory_id = ref.value
    JOIN source_record_evidence_refs AS source_ref
      ON source_ref.workspace_id = memory_ref.workspace_id
     AND source_ref.evidence_object_id = memory_ref.evidence_ref
    JOIN projection_erase_barriers AS barrier
      ON barrier.workspace_id = source_ref.workspace_id
     AND barrier.subject_kind = 'source_record'
     AND barrier.subject_id = source_ref.record_id
    WHERE capsule.workspace_id = NEW.workspace_id AND capsule.object_id = NEW.owner_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'erased source routing owner cannot be admitted');
END;

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
