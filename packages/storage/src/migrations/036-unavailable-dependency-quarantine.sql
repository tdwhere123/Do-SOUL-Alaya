-- A dependency that is already unavailable does not identify the source of its
-- descendants. Retain that uncertainty until an owning repair proves a safe
-- replacement; never create an erase barrier or infer an erased source here.
CREATE TABLE privacy_dependency_quarantine (
  workspace_id TEXT NOT NULL,
  object_kind TEXT NOT NULL,
  object_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'unavailable_dependency',
  PRIMARY KEY (workspace_id, object_kind, object_id)
) WITHOUT ROWID;

-- All edges use persisted IDs, never text, hashes, timestamps, or similarity.
CREATE VIEW privacy_dependency_candidates AS
WITH RECURSIVE
edges(workspace_id, dependency_kind, dependency_id, object_kind, object_id) AS (
  SELECT m.workspace_id, 'evidence_capsule', ref.value, 'memory_entry', m.object_id
  FROM memory_entries m, json_each(CASE WHEN json_valid(m.evidence_refs) THEN m.evidence_refs ELSE '[]' END) ref
  UNION ALL
  SELECT s.workspace_id, 'evidence_capsule', ref.value, 'synthesis_capsule', s.object_id
  FROM synthesis_capsules s, json_each(CASE WHEN json_valid(s.evidence_refs) THEN s.evidence_refs ELSE '[]' END) ref
  UNION ALL
  SELECT s.workspace_id, 'memory_entry', ref.value, 'synthesis_capsule', s.object_id
  FROM synthesis_capsules s, json_each(CASE WHEN json_valid(s.source_memory_refs) THEN s.source_memory_refs ELSE '[]' END) ref
  UNION ALL
  SELECT c.workspace_id, 'evidence_capsule', ref.value, 'claim_form', c.object_id
  FROM claim_forms c, json_each(CASE WHEN json_valid(c.evidence_refs) THEN c.evidence_refs ELSE '[]' END) ref
  UNION ALL
  SELECT c.workspace_id, kinds.kind, ref.value, 'claim_form', c.object_id
  FROM claim_forms c, json_each(CASE WHEN json_valid(c.source_object_refs) THEN c.source_object_refs ELSE '[]' END) ref
  CROSS JOIN (SELECT 'memory_entry' AS kind UNION ALL SELECT 'synthesis_capsule'
    UNION ALL SELECT 'claim_form' UNION ALL SELECT 'evidence_capsule' UNION ALL SELECT 'source_record') kinds
  UNION ALL
  SELECT h.workspace_id, 'evidence_capsule', h.evidence_id, 'memory_hq_observation', h.observation_id
  FROM memory_hq_observations h
  UNION ALL
  SELECT h.workspace_id, 'memory_entry', h.object_id, 'memory_hq_observation', h.observation_id
  FROM memory_hq_observations h
  UNION ALL
  SELECT h.workspace_id, 'memory_hq_observation', o.observation_id, 'memory_hq_projection', h.object_id
  FROM memory_hq h JOIN memory_hq_observations o ON o.workspace_id = h.workspace_id AND o.object_id = h.object_id
    AND (h.observation_id IS NULL OR h.observation_id = o.observation_id)
),
unavailable(workspace_id, object_kind, object_id) AS (
  SELECT workspace_id, 'evidence_capsule', object_id FROM evidence_capsules WHERE lifecycle_state = 'tombstone'
  UNION SELECT workspace_id, 'memory_entry', object_id FROM memory_entries WHERE lifecycle_state = 'tombstone'
  UNION SELECT workspace_id, 'synthesis_capsule', object_id FROM synthesis_capsules WHERE lifecycle_state = 'tombstone'
  UNION SELECT workspace_id, 'claim_form', object_id FROM claim_forms WHERE lifecycle_state = 'tombstone'
  UNION SELECT workspace_id, 'source_record', subject_id FROM projection_erase_barriers WHERE subject_kind = 'source_record'
  UNION SELECT workspace_id, object_kind, object_id FROM privacy_dependency_quarantine
  UNION SELECT edge.workspace_id, edge.object_kind, edge.object_id
    FROM edges edge JOIN unavailable parent
      ON parent.workspace_id = edge.workspace_id AND parent.object_kind = edge.dependency_kind
      AND parent.object_id = edge.dependency_id
),
dependent(workspace_id, object_kind, object_id) AS (
  SELECT edge.workspace_id, edge.object_kind, edge.object_id
  FROM edges edge JOIN unavailable parent
    ON parent.workspace_id = edge.workspace_id AND parent.object_kind = edge.dependency_kind
    AND parent.object_id = edge.dependency_id
  UNION SELECT workspace_id, object_kind, object_id FROM privacy_dependency_quarantine
),
unsafe(workspace_id, object_kind, object_id) AS (
  SELECT u.workspace_id, u.object_kind, u.object_id FROM dependent u
  JOIN memory_entries m ON u.object_kind = 'memory_entry' AND m.workspace_id = u.workspace_id AND m.object_id = u.object_id
  WHERE NOT COALESCE(m.lifecycle_state = 'tombstone' AND m.retention_state = 'tombstoned' AND m.content = 'erased', 0)
  UNION
  SELECT u.workspace_id, u.object_kind, u.object_id FROM dependent u
  JOIN synthesis_capsules s ON u.object_kind = 'synthesis_capsule' AND s.workspace_id = u.workspace_id AND s.object_id = u.object_id
  WHERE NOT COALESCE(s.lifecycle_state = 'tombstone' AND s.synthesis_status = 'archived' AND s.topic_key = 'erased' AND s.summary = 'erased', 0)
  UNION
  SELECT u.workspace_id, u.object_kind, u.object_id FROM dependent u
  JOIN claim_forms c ON u.object_kind = 'claim_form' AND c.workspace_id = u.workspace_id AND c.object_id = u.object_id
  WHERE NOT COALESCE(c.lifecycle_state = 'tombstone' AND c.claim_status = 'archived' AND c.proposition_digest = 'erased'
    AND CASE WHEN json_valid(c.governance_subject) THEN
      json_extract(c.governance_subject, '$.subject_domain') = 'erased'
      AND json_extract(c.governance_subject, '$.canonical_key') = 'erased'
      AND json_type(c.governance_subject, '$.subject_qualifiers') = 'object'
      AND NOT EXISTS (SELECT 1 FROM json_each(c.governance_subject, '$.subject_qualifiers'))
    ELSE 0 END, 0)
  UNION
  SELECT u.workspace_id, u.object_kind, u.object_id FROM dependent u
  JOIN memory_hq_observations h ON u.object_kind = 'memory_hq_observation'
    AND h.workspace_id = u.workspace_id AND h.observation_id = u.object_id
  WHERE NOT COALESCE(h.hqs_json = '[]' AND h.hq_content_sha256 = 'erased'
    AND h.observation_sha256 IN ('erased', 'erased:' || h.observation_id), 0)
  UNION
  SELECT u.workspace_id, u.object_kind, u.object_id FROM dependent u
  JOIN memory_hq h ON u.object_kind = 'memory_hq_projection' AND h.workspace_id = u.workspace_id AND h.object_id = u.object_id
  WHERE h.hqs_json != '[]'
)
SELECT workspace_id, object_kind, object_id FROM unsafe
UNION
SELECT s.workspace_id, 'slot', s.object_id FROM slots s
WHERE EXISTS (SELECT 1 FROM unsafe u WHERE u.workspace_id = s.workspace_id AND u.object_kind = 'claim_form'
  AND (u.object_id = s.winner_claim_id OR u.object_id = s.subject_claim_id OR (s.subject_claim_id IS NULL AND EXISTS (
    SELECT 1 FROM event_log e WHERE e.workspace_id = s.workspace_id AND e.entity_type = 'slot'
      AND e.entity_id = s.object_id AND e.event_type = 'soul.slot.created'
      AND json_valid(e.payload_json) AND json_extract(e.payload_json, '$.winner_claim_id') = u.object_id
  ))))
UNION
SELECT e.workspace_id, 'conflict_matrix_edge', e.object_id FROM conflict_matrix_edges e
WHERE EXISTS (SELECT 1 FROM unsafe u WHERE u.workspace_id = e.workspace_id AND u.object_kind = 'claim_form'
  AND u.object_id IN (e.source_claim_id, e.target_claim_id));

INSERT OR IGNORE INTO privacy_dependency_quarantine(workspace_id, object_kind, object_id)
SELECT workspace_id, object_kind, object_id FROM privacy_dependency_candidates;

-- A subsequent tombstone can invalidate existing descendants. The same closure
-- runs inside that writer's transaction so readers cannot observe a gap.
CREATE TRIGGER quarantine_evidence_dependencies AFTER UPDATE OF lifecycle_state ON evidence_capsules
WHEN OLD.lifecycle_state != 'tombstone' AND NEW.lifecycle_state = 'tombstone' BEGIN
  INSERT OR IGNORE INTO privacy_dependency_quarantine(workspace_id, object_kind, object_id)
    SELECT workspace_id, object_kind, object_id FROM privacy_dependency_candidates WHERE workspace_id = NEW.workspace_id;
END;
CREATE TRIGGER quarantine_memory_dependencies AFTER UPDATE OF lifecycle_state ON memory_entries
WHEN OLD.lifecycle_state != 'tombstone' AND NEW.lifecycle_state = 'tombstone' BEGIN
  INSERT OR IGNORE INTO privacy_dependency_quarantine(workspace_id, object_kind, object_id)
    SELECT workspace_id, object_kind, object_id FROM privacy_dependency_candidates WHERE workspace_id = NEW.workspace_id;
END;
CREATE TRIGGER quarantine_synthesis_dependencies AFTER UPDATE OF lifecycle_state ON synthesis_capsules
WHEN OLD.lifecycle_state != 'tombstone' AND NEW.lifecycle_state = 'tombstone' BEGIN
  INSERT OR IGNORE INTO privacy_dependency_quarantine(workspace_id, object_kind, object_id)
    SELECT workspace_id, object_kind, object_id FROM privacy_dependency_candidates WHERE workspace_id = NEW.workspace_id;
END;
CREATE TRIGGER quarantine_claim_dependencies AFTER UPDATE OF lifecycle_state ON claim_forms
WHEN OLD.lifecycle_state != 'tombstone' AND NEW.lifecycle_state = 'tombstone' BEGIN
  INSERT OR IGNORE INTO privacy_dependency_quarantine(workspace_id, object_kind, object_id)
    SELECT workspace_id, object_kind, object_id FROM privacy_dependency_candidates WHERE workspace_id = NEW.workspace_id;
END;
CREATE TRIGGER quarantine_evidence_insert AFTER INSERT ON evidence_capsules
WHEN NEW.lifecycle_state = 'tombstone' BEGIN
  INSERT OR IGNORE INTO privacy_dependency_quarantine(workspace_id, object_kind, object_id)
    SELECT workspace_id, object_kind, object_id FROM privacy_dependency_candidates WHERE workspace_id = NEW.workspace_id;
END;
CREATE TRIGGER quarantine_memory_insert AFTER INSERT ON memory_entries
WHEN NEW.lifecycle_state = 'tombstone' BEGIN
  INSERT OR IGNORE INTO privacy_dependency_quarantine(workspace_id, object_kind, object_id)
    SELECT workspace_id, object_kind, object_id FROM privacy_dependency_candidates WHERE workspace_id = NEW.workspace_id;
END;
CREATE TRIGGER quarantine_synthesis_insert AFTER INSERT ON synthesis_capsules
WHEN NEW.lifecycle_state = 'tombstone' BEGIN
  INSERT OR IGNORE INTO privacy_dependency_quarantine(workspace_id, object_kind, object_id)
    SELECT workspace_id, object_kind, object_id FROM privacy_dependency_candidates WHERE workspace_id = NEW.workspace_id;
END;
CREATE TRIGGER quarantine_claim_insert AFTER INSERT ON claim_forms
WHEN NEW.lifecycle_state = 'tombstone' BEGIN
  INSERT OR IGNORE INTO privacy_dependency_quarantine(workspace_id, object_kind, object_id)
    SELECT workspace_id, object_kind, object_id FROM privacy_dependency_candidates WHERE workspace_id = NEW.workspace_id;
END;

-- A physically scrubbed object is readable as its explicit tombstone, while
-- its durable quarantine record remains as history until an owner repairs it.
CREATE VIEW privacy_current_quarantine AS
SELECT q.workspace_id, q.object_kind, q.object_id, q.reason
FROM privacy_dependency_quarantine q
WHERE NOT (
  q.object_kind = 'memory_entry' AND EXISTS (
    SELECT 1 FROM memory_entries m WHERE m.workspace_id = q.workspace_id AND m.object_id = q.object_id
      AND m.lifecycle_state = 'tombstone' AND m.retention_state = 'tombstoned' AND m.content = 'erased'
  )
) AND NOT (
  q.object_kind = 'memory_hq_projection' AND EXISTS (
    SELECT 1 FROM memory_hq h WHERE h.workspace_id = q.workspace_id AND h.object_id = q.object_id AND h.hqs_json = '[]'
  )
) AND NOT (
  q.object_kind = 'synthesis_capsule' AND EXISTS (
    SELECT 1 FROM synthesis_capsules s WHERE s.workspace_id = q.workspace_id AND s.object_id = q.object_id
      AND s.lifecycle_state = 'tombstone' AND s.synthesis_status = 'archived' AND s.topic_key = 'erased' AND s.summary = 'erased'
  )
) AND NOT (
  q.object_kind = 'claim_form' AND EXISTS (
    SELECT 1 FROM claim_forms c WHERE c.workspace_id = q.workspace_id AND c.object_id = q.object_id
      AND c.lifecycle_state = 'tombstone' AND c.claim_status = 'archived' AND c.proposition_digest = 'erased'
      AND CASE WHEN json_valid(c.governance_subject) THEN
        json_extract(c.governance_subject, '$.subject_domain') = 'erased'
        AND json_extract(c.governance_subject, '$.canonical_key') = 'erased'
        AND json_type(c.governance_subject, '$.subject_qualifiers') = 'object'
        AND NOT EXISTS (SELECT 1 FROM json_each(c.governance_subject, '$.subject_qualifiers'))
      ELSE 0 END
  )
);

-- Retained unknown payloads cannot be served through a mutation return value.
-- Canonical scrub remains available to the source-erasure owner; reference
-- removal alone does not release the durable quarantine.
DROP TRIGGER memory_hq_observations_reject_erased_source_content_update;
CREATE TRIGGER memory_hq_observations_reject_erased_source_content_update
BEFORE UPDATE OF hqs_json, hq_content_sha256, observation_sha256 ON memory_hq_observations
WHEN NOT (NEW.hqs_json = '[]' AND NEW.hq_content_sha256 = 'erased'
  AND NEW.observation_sha256 IN ('erased', 'erased:' || NEW.observation_id)) AND EXISTS (
  SELECT 1 FROM memory_entry_evidence_refs memory_ref
  JOIN source_record_evidence_refs source_ref ON source_ref.workspace_id = memory_ref.workspace_id
    AND source_ref.evidence_object_id = memory_ref.evidence_ref
  JOIN projection_erase_barriers barrier ON barrier.workspace_id = source_ref.workspace_id
    AND barrier.subject_kind = 'source_record' AND barrier.subject_id = source_ref.record_id
  WHERE memory_ref.workspace_id = NEW.workspace_id AND memory_ref.memory_id = NEW.object_id
) BEGIN SELECT RAISE(ABORT, 'erased source memory HQ observation cannot store content'); END;
CREATE TRIGGER quarantine_memory_reject_mutation BEFORE UPDATE OF content, lifecycle_state, retention_state,
  storage_tier, activation_score, retention_score, manifestation_state, decay_profile, confidence,
  last_used_at, last_hit_at, reinforcement_count, contradiction_count, superseded_by, domain_tags ON memory_entries
WHEN EXISTS (SELECT 1 FROM privacy_current_quarantine q WHERE q.workspace_id = OLD.workspace_id
  AND q.object_kind = 'memory_entry' AND q.object_id = OLD.object_id)
  AND NOT COALESCE(NEW.lifecycle_state = 'tombstone' AND NEW.retention_state = 'tombstoned' AND NEW.content = 'erased', 0)
BEGIN SELECT RAISE(ABORT, 'memory provenance unavailable'); END;
CREATE TRIGGER quarantine_claim_reject_mutation BEFORE UPDATE OF governance_subject, proposition_digest, claim_status, lifecycle_state ON claim_forms
WHEN EXISTS (SELECT 1 FROM privacy_current_quarantine q WHERE q.workspace_id = OLD.workspace_id
  AND q.object_kind = 'claim_form' AND q.object_id = OLD.object_id)
  AND NOT COALESCE(NEW.lifecycle_state = 'tombstone' AND NEW.claim_status = 'archived' AND NEW.proposition_digest = 'erased'
    AND CASE WHEN json_valid(NEW.governance_subject) THEN
      json_extract(NEW.governance_subject, '$.subject_domain') = 'erased'
      AND json_extract(NEW.governance_subject, '$.canonical_key') = 'erased'
      AND json_type(NEW.governance_subject, '$.subject_qualifiers') = 'object'
      AND NOT EXISTS (SELECT 1 FROM json_each(NEW.governance_subject, '$.subject_qualifiers')) ELSE 0 END, 0)
BEGIN SELECT RAISE(ABORT, 'claim provenance unavailable'); END;
CREATE TRIGGER quarantine_synthesis_reject_mutation BEFORE UPDATE OF topic_key, summary, synthesis_status, lifecycle_state ON synthesis_capsules
WHEN EXISTS (SELECT 1 FROM privacy_current_quarantine q WHERE q.workspace_id = OLD.workspace_id
  AND q.object_kind = 'synthesis_capsule' AND q.object_id = OLD.object_id)
  AND NOT COALESCE(NEW.lifecycle_state = 'tombstone' AND NEW.synthesis_status = 'archived'
    AND NEW.topic_key = 'erased' AND NEW.summary = 'erased', 0)
BEGIN SELECT RAISE(ABORT, 'synthesis provenance unavailable'); END;

-- New dependencies may not attach to an unresolved legacy object. These gates
-- run in the writer's SQLite transaction and do not manufacture erase facts.
CREATE TRIGGER quarantine_memory_reject_insert BEFORE INSERT ON memory_entries
WHEN EXISTS (SELECT 1 FROM privacy_current_quarantine q WHERE q.workspace_id = NEW.workspace_id
  AND q.object_kind = 'memory_entry' AND q.object_id = NEW.object_id)
BEGIN SELECT RAISE(ABORT, 'memory provenance unavailable'); END;
CREATE TRIGGER quarantine_memory_key_reject_insert BEFORE INSERT ON memory_object_keys
WHEN EXISTS (SELECT 1 FROM privacy_current_quarantine q WHERE q.workspace_id = NEW.workspace_id
  AND q.object_kind = 'memory_entry' AND q.object_id = NEW.owner_id)
BEGIN SELECT RAISE(ABORT, 'memory key provenance unavailable'); END;
CREATE TRIGGER quarantine_hq_reject_insert BEFORE INSERT ON memory_hq_observations
WHEN EXISTS (SELECT 1 FROM privacy_current_quarantine q WHERE q.workspace_id = NEW.workspace_id
  AND ((q.object_kind = 'memory_entry' AND q.object_id = NEW.object_id)
    OR (q.object_kind = 'memory_hq_observation' AND q.object_id = NEW.observation_id)))
  OR EXISTS (SELECT 1 FROM evidence_capsules e WHERE e.workspace_id = NEW.workspace_id
    AND e.object_id = NEW.evidence_id AND e.lifecycle_state = 'tombstone')
BEGIN SELECT RAISE(ABORT, 'HQ provenance unavailable'); END;
CREATE TRIGGER quarantine_hq_reject_update BEFORE UPDATE OF hqs_json, hq_content_sha256, observation_sha256 ON memory_hq_observations
WHEN (EXISTS (SELECT 1 FROM privacy_current_quarantine q WHERE q.workspace_id = OLD.workspace_id
  AND q.object_kind = 'memory_hq_observation' AND q.object_id = OLD.observation_id)
  OR (OLD.hqs_json = '[]' AND OLD.hq_content_sha256 = 'erased'
    AND OLD.observation_sha256 IN ('erased', 'erased:' || OLD.observation_id)))
  AND NOT (NEW.hqs_json = '[]' AND NEW.hq_content_sha256 = 'erased'
    AND NEW.observation_sha256 IN ('erased', 'erased:' || NEW.observation_id))
BEGIN SELECT RAISE(ABORT, 'HQ provenance unavailable'); END;
CREATE TRIGGER quarantine_hq_projection_reject_insert BEFORE INSERT ON memory_hq
WHEN EXISTS (SELECT 1 FROM privacy_current_quarantine q WHERE q.workspace_id = NEW.workspace_id
  AND ((q.object_kind = 'memory_entry' AND q.object_id = NEW.object_id)
    OR (q.object_kind = 'memory_hq_observation' AND q.object_id = NEW.observation_id)
    OR (q.object_kind = 'memory_hq_projection' AND q.object_id = NEW.object_id))) OR EXISTS (
  SELECT 1 FROM memory_hq_observations o JOIN evidence_capsules e ON e.object_id = o.evidence_id AND e.workspace_id = o.workspace_id
  WHERE o.workspace_id = NEW.workspace_id AND o.observation_id = NEW.observation_id
    AND (e.lifecycle_state = 'tombstone' OR (o.hqs_json = '[]' AND o.hq_content_sha256 = 'erased'
      AND o.observation_sha256 IN ('erased', 'erased:' || o.observation_id)))
)
BEGIN SELECT RAISE(ABORT, 'HQ provenance unavailable'); END;
CREATE TRIGGER quarantine_hq_projection_reject_update BEFORE UPDATE OF hqs_json, observation_id ON memory_hq
WHEN NEW.hqs_json != '[]' AND (EXISTS (SELECT 1 FROM privacy_current_quarantine q WHERE q.workspace_id = NEW.workspace_id
  AND ((q.object_kind = 'memory_entry' AND q.object_id = NEW.object_id)
    OR (q.object_kind = 'memory_hq_observation' AND q.object_id = NEW.observation_id)
    OR (q.object_kind = 'memory_hq_projection' AND q.object_id = NEW.object_id))) OR EXISTS (
  SELECT 1 FROM memory_hq_observations o JOIN evidence_capsules e ON e.object_id = o.evidence_id AND e.workspace_id = o.workspace_id
  WHERE o.workspace_id = NEW.workspace_id AND o.observation_id = NEW.observation_id
    AND (e.lifecycle_state = 'tombstone' OR (o.hqs_json = '[]' AND o.hq_content_sha256 = 'erased'
      AND o.observation_sha256 IN ('erased', 'erased:' || o.observation_id)))
))
BEGIN SELECT RAISE(ABORT, 'HQ provenance unavailable'); END;
CREATE TRIGGER quarantine_embedding_reject_insert BEFORE INSERT ON memory_embeddings
WHEN EXISTS (SELECT 1 FROM privacy_current_quarantine q WHERE q.workspace_id = NEW.workspace_id
  AND q.object_kind = 'memory_entry' AND q.object_id = NEW.object_id)
BEGIN SELECT RAISE(ABORT, 'embedding provenance unavailable'); END;
CREATE TRIGGER quarantine_embedding_reject_update BEFORE UPDATE ON memory_embeddings
WHEN EXISTS (SELECT 1 FROM privacy_current_quarantine q WHERE q.workspace_id = NEW.workspace_id
  AND q.object_kind = 'memory_entry' AND q.object_id = NEW.object_id)
BEGIN SELECT RAISE(ABORT, 'embedding provenance unavailable'); END;
CREATE TRIGGER claim_reject_unknown_dependency_insert BEFORE INSERT ON claim_forms
WHEN EXISTS (SELECT 1 FROM privacy_current_quarantine q WHERE q.workspace_id = NEW.workspace_id
  AND q.object_kind = 'claim_form' AND q.object_id = NEW.object_id) OR EXISTS (
  SELECT 1 FROM json_each(CASE WHEN json_valid(NEW.source_object_refs) THEN NEW.source_object_refs ELSE '[]' END) ref
  JOIN privacy_current_quarantine q ON q.workspace_id = NEW.workspace_id AND q.object_id = ref.value
    AND q.object_kind IN ('memory_entry', 'synthesis_capsule', 'claim_form')
) BEGIN SELECT RAISE(ABORT, 'claim dependency provenance unavailable'); END;
CREATE TRIGGER claim_reject_unknown_dependency_update BEFORE UPDATE OF source_object_refs ON claim_forms
WHEN NOT COALESCE(NEW.lifecycle_state = 'tombstone' AND NEW.claim_status = 'archived'
  AND NEW.proposition_digest = 'erased' AND CASE WHEN json_valid(NEW.governance_subject) THEN
    json_extract(NEW.governance_subject, '$.subject_domain') = 'erased'
    AND json_extract(NEW.governance_subject, '$.canonical_key') = 'erased'
    AND json_type(NEW.governance_subject, '$.subject_qualifiers') = 'object'
    AND NOT EXISTS (SELECT 1 FROM json_each(NEW.governance_subject, '$.subject_qualifiers')) ELSE 0 END, 0)
AND EXISTS (
  SELECT 1 FROM json_each(CASE WHEN json_valid(NEW.source_object_refs) THEN NEW.source_object_refs ELSE '[]' END) ref
  JOIN privacy_current_quarantine q ON q.workspace_id = NEW.workspace_id AND q.object_id = ref.value
    AND q.object_kind IN ('memory_entry', 'synthesis_capsule', 'claim_form')
) BEGIN SELECT RAISE(ABORT, 'claim dependency provenance unavailable'); END;
CREATE TRIGGER synthesis_reject_unknown_dependency_insert BEFORE INSERT ON synthesis_capsules
WHEN EXISTS (SELECT 1 FROM privacy_current_quarantine q WHERE q.workspace_id = NEW.workspace_id
  AND q.object_kind = 'synthesis_capsule' AND q.object_id = NEW.object_id) OR EXISTS (
  SELECT 1 FROM json_each(CASE WHEN json_valid(NEW.source_memory_refs) THEN NEW.source_memory_refs ELSE '[]' END) ref
  JOIN privacy_current_quarantine q ON q.workspace_id = NEW.workspace_id AND q.object_kind = 'memory_entry' AND q.object_id = ref.value
) BEGIN SELECT RAISE(ABORT, 'synthesis dependency provenance unavailable'); END;
CREATE TRIGGER synthesis_reject_unknown_dependency_update BEFORE UPDATE OF source_memory_refs ON synthesis_capsules
WHEN NOT COALESCE(NEW.lifecycle_state = 'tombstone' AND NEW.synthesis_status = 'archived'
  AND NEW.topic_key = 'erased' AND NEW.summary = 'erased', 0)
AND EXISTS (
  SELECT 1 FROM json_each(CASE WHEN json_valid(NEW.source_memory_refs) THEN NEW.source_memory_refs ELSE '[]' END) ref
  JOIN privacy_current_quarantine q ON q.workspace_id = NEW.workspace_id AND q.object_kind = 'memory_entry' AND q.object_id = ref.value
) BEGIN SELECT RAISE(ABORT, 'synthesis dependency provenance unavailable'); END;
CREATE TRIGGER slot_reject_unknown_winner_insert BEFORE INSERT ON slots
WHEN EXISTS (SELECT 1 FROM privacy_current_quarantine q WHERE q.workspace_id = NEW.workspace_id
  AND ((q.object_kind = 'claim_form' AND q.object_id IN (NEW.winner_claim_id, NEW.subject_claim_id))
    OR (q.object_kind = 'slot' AND q.object_id = NEW.object_id)))
BEGIN SELECT RAISE(ABORT, 'slot provenance unavailable'); END;
CREATE TRIGGER slot_reject_unknown_winner_update BEFORE UPDATE OF winner_claim_id, subject_claim_id, governance_subject ON slots
WHEN EXISTS (SELECT 1 FROM privacy_current_quarantine q WHERE q.workspace_id = NEW.workspace_id
  AND ((q.object_kind = 'claim_form' AND
       ((q.object_id = NEW.winner_claim_id AND NEW.winner_claim_id IS NOT OLD.winner_claim_id)
         OR (q.object_id = NEW.subject_claim_id AND NEW.subject_claim_id IS NOT OLD.subject_claim_id)))
    OR (q.object_kind = 'slot' AND q.object_id = NEW.object_id AND NOT (
      NEW.winner_claim_id IS NULL AND NEW.subject_claim_id IS OLD.subject_claim_id
      AND NEW.governance_subject = OLD.governance_subject))))
BEGIN SELECT RAISE(ABORT, 'slot provenance unavailable'); END;
CREATE TRIGGER edge_reject_unknown_claim_insert BEFORE INSERT ON conflict_matrix_edges
WHEN EXISTS (SELECT 1 FROM privacy_current_quarantine q WHERE q.workspace_id = NEW.workspace_id
  AND ((q.object_kind = 'claim_form' AND q.object_id IN (NEW.source_claim_id, NEW.target_claim_id))
    OR (q.object_kind = 'conflict_matrix_edge' AND q.object_id = NEW.object_id)))
BEGIN SELECT RAISE(ABORT, 'conflict claim provenance unavailable'); END;
CREATE TRIGGER edge_reject_unknown_claim_update BEFORE UPDATE OF source_claim_id, target_claim_id ON conflict_matrix_edges
WHEN EXISTS (SELECT 1 FROM privacy_current_quarantine q WHERE q.workspace_id = NEW.workspace_id
  AND ((q.object_kind = 'claim_form' AND q.object_id IN (NEW.source_claim_id, NEW.target_claim_id))
    OR (q.object_kind = 'conflict_matrix_edge' AND q.object_id = NEW.object_id)))
BEGIN SELECT RAISE(ABORT, 'conflict claim provenance unavailable'); END;
