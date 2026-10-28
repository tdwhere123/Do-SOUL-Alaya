-- A slot subject is copied from one claim at creation or at a later verified
-- erase repair. NULL means historic subject provenance is unavailable.
ALTER TABLE slots ADD COLUMN subject_claim_id TEXT;
UPDATE slots SET subject_claim_id = CASE WHEN (
  SELECT COUNT(*) FROM event_log event WHERE event.workspace_id = slots.workspace_id
    AND event.entity_type = 'slot' AND event.entity_id = slots.object_id
    AND event.event_type = 'soul.slot.created'
) = 1 THEN (
  SELECT json_extract(event.payload_json, '$.winner_claim_id') FROM event_log event
  WHERE event.workspace_id = slots.workspace_id AND event.entity_type = 'slot'
    AND event.entity_id = slots.object_id AND event.event_type = 'soul.slot.created'
    AND CASE WHEN json_valid(event.payload_json) AND json_valid(slots.governance_subject) THEN
      json_type(event.payload_json, '$.winner_claim_id') = 'text'
      AND json_extract(event.payload_json, '$.object_id') = slots.object_id
      AND json_extract(event.payload_json, '$.workspace_id') = slots.workspace_id
      AND json_extract(event.payload_json, '$.claim_kind') = slots.claim_kind
      AND json_extract(event.payload_json, '$.scope_class') = slots.scope_class
      AND json_extract(event.payload_json, '$.governance_subject') = json(slots.governance_subject)
      ELSE 0 END
) ELSE NULL END;

-- Tombstoned evidence cannot be reattached by a delayed synthesis write.
CREATE TRIGGER synthesis_capsules_reject_tombstoned_evidence_insert
BEFORE INSERT ON synthesis_capsules
WHEN NOT (NEW.lifecycle_state = 'tombstone' AND NEW.synthesis_status = 'archived'
  AND NEW.topic_key = 'erased' AND NEW.summary = 'erased')
AND (EXISTS (
  SELECT 1 FROM json_each(NEW.evidence_refs) AS ref
  JOIN evidence_capsules AS evidence ON evidence.workspace_id = NEW.workspace_id AND evidence.object_id = ref.value
  WHERE evidence.lifecycle_state = 'tombstone'
) OR EXISTS (
  SELECT 1 FROM json_each(NEW.source_memory_refs) AS ref
  JOIN memory_entries AS memory ON memory.workspace_id = NEW.workspace_id AND memory.object_id = ref.value
  WHERE memory.lifecycle_state = 'tombstone'
))
BEGIN
  SELECT RAISE(ABORT, 'tombstoned evidence cannot be attached to synthesis');
END;

CREATE TRIGGER claim_forms_reject_tombstoned_content_update
BEFORE UPDATE OF evidence_refs, source_object_refs, proposition_digest, governance_subject, lifecycle_state, claim_status ON claim_forms
WHEN OLD.lifecycle_state = 'tombstone'
  AND (NEW.evidence_refs IS NOT OLD.evidence_refs OR NEW.source_object_refs IS NOT OLD.source_object_refs
    OR NEW.proposition_digest IS NOT OLD.proposition_digest OR NEW.governance_subject IS NOT OLD.governance_subject
    OR NEW.lifecycle_state IS NOT OLD.lifecycle_state OR NEW.claim_status IS NOT OLD.claim_status)
  AND NOT (NEW.lifecycle_state = 'tombstone' AND NEW.claim_status = 'archived'
    AND NEW.proposition_digest = 'erased'
    AND NEW.governance_subject = '{"subject_domain":"erased","subject_qualifiers":{},"canonical_key":"erased"}'
    AND NEW.evidence_refs IS OLD.evidence_refs AND NEW.source_object_refs IS OLD.source_object_refs
    AND (OLD.claim_status IS NOT 'archived' OR OLD.proposition_digest IS NOT 'erased'
      OR OLD.governance_subject IS NOT NEW.governance_subject))
BEGIN
  SELECT RAISE(ABORT, 'tombstoned claim content cannot be changed');
END;

CREATE TRIGGER synthesis_capsules_reject_tombstoned_content_update
BEFORE UPDATE OF evidence_refs, source_memory_refs, summary, topic_key, lifecycle_state, synthesis_status ON synthesis_capsules
WHEN OLD.lifecycle_state = 'tombstone'
  AND (NEW.evidence_refs IS NOT OLD.evidence_refs OR NEW.source_memory_refs IS NOT OLD.source_memory_refs
    OR NEW.summary IS NOT OLD.summary OR NEW.topic_key IS NOT OLD.topic_key
    OR NEW.lifecycle_state IS NOT OLD.lifecycle_state OR NEW.synthesis_status IS NOT OLD.synthesis_status)
  AND NOT (NEW.lifecycle_state = 'tombstone' AND NEW.synthesis_status = 'archived'
    AND NEW.topic_key = 'erased' AND NEW.summary = 'erased'
    AND NEW.evidence_refs IS OLD.evidence_refs AND NEW.source_memory_refs IS OLD.source_memory_refs
    AND (OLD.synthesis_status IS NOT 'archived' OR OLD.topic_key IS NOT 'erased' OR OLD.summary IS NOT 'erased'))
BEGIN
  SELECT RAISE(ABORT, 'tombstoned synthesis content cannot be changed');
END;

CREATE TRIGGER conflict_edges_reject_tombstoned_claim_insert
BEFORE INSERT ON conflict_matrix_edges
WHEN EXISTS (
  SELECT 1 FROM claim_forms claim WHERE claim.workspace_id = NEW.workspace_id
    AND claim.object_id IN (NEW.source_claim_id, NEW.target_claim_id) AND claim.lifecycle_state = 'tombstone'
)
BEGIN
  SELECT RAISE(ABORT, 'tombstoned claim cannot be attached to conflict edge');
END;

CREATE TRIGGER conflict_edges_reject_tombstoned_claim_update
BEFORE UPDATE OF source_claim_id, target_claim_id ON conflict_matrix_edges
WHEN EXISTS (
  SELECT 1 FROM claim_forms claim WHERE claim.workspace_id = NEW.workspace_id
    AND claim.object_id IN (NEW.source_claim_id, NEW.target_claim_id) AND claim.lifecycle_state = 'tombstone'
)
BEGIN
  SELECT RAISE(ABORT, 'tombstoned claim cannot be attached to conflict edge');
END;

CREATE TRIGGER synthesis_capsules_reject_tombstoned_evidence_update
BEFORE UPDATE OF evidence_refs, source_memory_refs, summary, topic_key, lifecycle_state, synthesis_status ON synthesis_capsules
WHEN NOT (NEW.lifecycle_state = 'tombstone' AND NEW.synthesis_status = 'archived'
  AND NEW.topic_key = 'erased' AND NEW.summary = 'erased')
AND (EXISTS (
  SELECT 1 FROM json_each(NEW.evidence_refs) AS ref
  JOIN evidence_capsules AS evidence ON evidence.workspace_id = NEW.workspace_id AND evidence.object_id = ref.value
  WHERE evidence.lifecycle_state = 'tombstone'
) OR EXISTS (
  SELECT 1 FROM json_each(NEW.source_memory_refs) AS ref
  JOIN memory_entries AS memory ON memory.workspace_id = NEW.workspace_id AND memory.object_id = ref.value
  WHERE memory.lifecycle_state = 'tombstone'
))
BEGIN
  SELECT RAISE(ABORT, 'tombstoned evidence cannot be attached to synthesis');
END;

-- Claim materialization may follow memory creation across an async boundary.
CREATE TRIGGER claim_forms_reject_tombstoned_dependencies_insert
BEFORE INSERT ON claim_forms
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.evidence_refs) AS ref
  JOIN evidence_capsules AS evidence ON evidence.workspace_id = NEW.workspace_id AND evidence.object_id = ref.value
  WHERE evidence.lifecycle_state = 'tombstone'
) OR EXISTS (
  SELECT 1 FROM json_each(NEW.source_object_refs) AS ref
  LEFT JOIN memory_entries AS memory ON memory.workspace_id = NEW.workspace_id AND memory.object_id = ref.value
  LEFT JOIN synthesis_capsules AS synthesis ON synthesis.workspace_id = NEW.workspace_id AND synthesis.object_id = ref.value
  LEFT JOIN evidence_capsules AS evidence ON evidence.workspace_id = NEW.workspace_id AND evidence.object_id = ref.value
  LEFT JOIN claim_forms AS source_claim ON source_claim.workspace_id = NEW.workspace_id AND source_claim.object_id = ref.value
  WHERE memory.lifecycle_state = 'tombstone' OR synthesis.lifecycle_state = 'tombstone'
    OR evidence.lifecycle_state = 'tombstone' OR source_claim.lifecycle_state = 'tombstone'
    OR EXISTS (SELECT 1 FROM projection_erase_barriers barrier WHERE barrier.workspace_id = NEW.workspace_id
      AND barrier.subject_id = ref.value)
)
BEGIN
  SELECT RAISE(ABORT, 'tombstoned dependency cannot be attached to claim');
END;

CREATE TRIGGER claim_forms_reject_tombstoned_dependencies_update
BEFORE UPDATE OF evidence_refs, source_object_refs, proposition_digest, governance_subject, lifecycle_state, claim_status ON claim_forms
WHEN NOT (NEW.lifecycle_state = 'tombstone' AND NEW.claim_status = 'archived' AND NEW.proposition_digest = 'erased'
  AND NEW.governance_subject = '{"subject_domain":"erased","subject_qualifiers":{},"canonical_key":"erased"}'
  AND NEW.evidence_refs IS OLD.evidence_refs AND NEW.source_object_refs IS OLD.source_object_refs)
AND (EXISTS (
  SELECT 1 FROM json_each(NEW.evidence_refs) AS ref
  JOIN evidence_capsules AS evidence ON evidence.workspace_id = NEW.workspace_id AND evidence.object_id = ref.value
  WHERE evidence.lifecycle_state = 'tombstone'
) OR EXISTS (
  SELECT 1 FROM json_each(NEW.source_object_refs) AS ref
  LEFT JOIN memory_entries AS memory ON memory.workspace_id = NEW.workspace_id AND memory.object_id = ref.value
  LEFT JOIN synthesis_capsules AS synthesis ON synthesis.workspace_id = NEW.workspace_id AND synthesis.object_id = ref.value
  LEFT JOIN evidence_capsules AS evidence ON evidence.workspace_id = NEW.workspace_id AND evidence.object_id = ref.value
  LEFT JOIN claim_forms AS source_claim ON source_claim.workspace_id = NEW.workspace_id AND source_claim.object_id = ref.value
  WHERE memory.lifecycle_state = 'tombstone' OR synthesis.lifecycle_state = 'tombstone'
    OR evidence.lifecycle_state = 'tombstone' OR source_claim.lifecycle_state = 'tombstone'
    OR EXISTS (SELECT 1 FROM projection_erase_barriers barrier WHERE barrier.workspace_id = NEW.workspace_id
      AND barrier.subject_id = ref.value)
))
BEGIN
  SELECT RAISE(ABORT, 'tombstoned dependency cannot be attached to claim');
END;

CREATE TRIGGER slots_reject_tombstoned_winner_insert
BEFORE INSERT ON slots
WHEN EXISTS (SELECT 1 FROM claim_forms claim WHERE claim.workspace_id = NEW.workspace_id
  AND claim.object_id IN (NEW.winner_claim_id, NEW.subject_claim_id) AND claim.lifecycle_state = 'tombstone')
BEGIN
  SELECT RAISE(ABORT, 'tombstoned claim cannot win a slot');
END;

CREATE TRIGGER slots_reject_tombstoned_winner_update
BEFORE UPDATE OF winner_claim_id, subject_claim_id ON slots
WHEN EXISTS (SELECT 1 FROM claim_forms claim WHERE claim.workspace_id = NEW.workspace_id
  AND claim.lifecycle_state = 'tombstone' AND (
    claim.object_id = NEW.winner_claim_id OR (NEW.subject_claim_id IS NOT OLD.subject_claim_id
      AND claim.object_id = NEW.subject_claim_id)))
BEGIN
  SELECT RAISE(ABORT, 'tombstoned claim cannot win a slot');
END;

-- Subject provenance is admitted only with the claim and the creation event
-- that actually supplied the subject. NULL deliberately remains unknown.
CREATE TRIGGER slots_require_subject_creation_provenance
BEFORE INSERT ON slots WHEN NEW.subject_claim_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM claim_forms claim JOIN event_log event
    ON event.workspace_id = NEW.workspace_id AND event.entity_type = 'slot'
    AND event.entity_id = NEW.object_id AND event.event_type = 'soul.slot.created'
  WHERE claim.workspace_id = NEW.workspace_id AND claim.object_id = NEW.subject_claim_id
    AND NEW.winner_claim_id = claim.object_id AND claim.lifecycle_state = 'active'
    AND claim.claim_status IN ('active', 'winner')
    AND claim.claim_kind = NEW.claim_kind AND claim.scope_class = NEW.scope_class
    AND CASE WHEN json_valid(claim.governance_subject) AND json_valid(NEW.governance_subject)
      AND json_valid(event.payload_json) THEN
      json(claim.governance_subject) = json(NEW.governance_subject)
      AND json_extract(event.payload_json, '$.object_id') = NEW.object_id
      AND json_extract(event.payload_json, '$.workspace_id') = NEW.workspace_id
      AND json_extract(event.payload_json, '$.winner_claim_id') = claim.object_id
      AND json_extract(event.payload_json, '$.claim_kind') = NEW.claim_kind
      AND json_extract(event.payload_json, '$.scope_class') = NEW.scope_class
      AND json_extract(event.payload_json, '$.governance_subject') = json(NEW.governance_subject)
      ELSE 0 END
)
BEGIN
  SELECT RAISE(ABORT, 'slot subject requires its creation provenance');
END;

CREATE TRIGGER slots_require_subject_rebuild_provenance
BEFORE UPDATE OF subject_claim_id ON slots
WHEN NEW.subject_claim_id IS NOT OLD.subject_claim_id AND NEW.subject_claim_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM claim_forms claim WHERE claim.workspace_id = NEW.workspace_id
    AND claim.object_id = NEW.subject_claim_id AND NEW.winner_claim_id = claim.object_id
    AND claim.lifecycle_state = 'active' AND claim.claim_status IN ('active', 'winner')
    AND claim.claim_kind = NEW.claim_kind AND claim.scope_class = NEW.scope_class
    AND CASE WHEN json_valid(claim.governance_subject) AND json_valid(NEW.governance_subject)
      THEN json(claim.governance_subject) = json(NEW.governance_subject) ELSE 0 END
)
BEGIN
  SELECT RAISE(ABORT, 'slot subject rebuild requires its winner');
END;
