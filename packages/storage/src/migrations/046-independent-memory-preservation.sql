-- An audited GC refusal is a deferred revision, not another terminal transition
-- every sweep. Unchanged deferred rows cannot monopolize Janitor's oldest batch.
CREATE TABLE memory_gc_deferrals (
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL REFERENCES memory_entries(object_id) ON DELETE CASCADE,
  audit_event_id TEXT NOT NULL REFERENCES event_log(event_id),
  PRIMARY KEY(workspace_id,memory_id)
) WITHOUT ROWID;
CREATE TRIGGER memory_gc_deferral_reconsider AFTER UPDATE ON memory_entries
WHEN OLD.updated_at IS NOT NEW.updated_at
  OR OLD.lifecycle_state IS NOT NEW.lifecycle_state OR OLD.retention_state IS NOT NEW.retention_state
  OR OLD.decay_profile IS NOT NEW.decay_profile OR OLD.evidence_refs IS NOT NEW.evidence_refs
  OR OLD.reinforcement_count IS NOT NEW.reinforcement_count
  OR OLD.forget_disposition IS NOT NEW.forget_disposition
  OR OLD.forget_disposition_ref IS NOT NEW.forget_disposition_ref BEGIN
  DELETE FROM memory_gc_deferrals WHERE workspace_id=OLD.workspace_id AND memory_id=OLD.object_id;
END;

-- Lossless historical retention, not semantic compression or a storage-savings claim.
-- No legacy proof backfill and no release of existing quarantine.
CREATE TABLE preservation_capsule_revisions (
  workspace_id TEXT NOT NULL, capsule_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0),
  PRIMARY KEY(workspace_id,capsule_id)
) WITHOUT ROWID;
INSERT INTO preservation_capsule_revisions SELECT workspace_id,object_id,0 FROM synthesis_capsules;
CREATE TABLE historical_memory_captures (
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL, capsule_id TEXT NOT NULL, capture_id TEXT NOT NULL,
  capsule_revision INTEGER NOT NULL, evidence_id TEXT NOT NULL, terminal_updated_at TEXT NOT NULL,
  source_roots_json TEXT NOT NULL CHECK(json_valid(source_roots_json) AND json_array_length(source_roots_json)>0),
  material_json TEXT, audit_event_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('active','invalidated','erased')),
  PRIMARY KEY(workspace_id,memory_id,capsule_id),
  UNIQUE(workspace_id,capture_id),
  CHECK((state='erased' AND material_json IS NULL) OR
    (state<>'erased' AND json_valid(material_json)
      AND json_extract(material_json,'$.kind')='historical_memory_capture'
      AND json_extract(material_json,'$.schema_version')=1
      AND json_extract(material_json,'$.workspace_id')=workspace_id
      AND json_extract(material_json,'$.member.object_id')=memory_id
      AND json_extract(material_json,'$.capsule_id')=capsule_id
      AND json_extract(material_json,'$.capture_id')=capture_id
      AND json_extract(material_json,'$.capsule_revision')=capsule_revision
      AND json_extract(material_json,'$.evidence_id')=evidence_id
      AND json_extract(material_json,'$.terminal_updated_at')=terminal_updated_at
      AND json(json_extract(material_json,'$.source_roots'))=json(source_roots_json)))
) WITHOUT ROWID;
CREATE INDEX historical_capture_capsule ON historical_memory_captures(workspace_id,capsule_id);
CREATE INDEX historical_capture_evidence ON historical_memory_captures(workspace_id,evidence_id);
-- This index is a projection of immutable capture lineage, never memory-row-owned.
CREATE TABLE historical_memory_capture_sources (
  workspace_id TEXT NOT NULL, memory_id TEXT NOT NULL, capsule_id TEXT NOT NULL,
  record_id TEXT NOT NULL, source_id TEXT NOT NULL, source_version TEXT NOT NULL, content_digest TEXT NOT NULL,
  PRIMARY KEY(workspace_id,memory_id,capsule_id,record_id),
  FOREIGN KEY(workspace_id,memory_id,capsule_id)
    REFERENCES historical_memory_captures(workspace_id,memory_id,capsule_id) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX historical_capture_source ON historical_memory_capture_sources(workspace_id,record_id);
CREATE INDEX historical_capture_source_head ON historical_memory_capture_sources(workspace_id,source_id);

-- Current-source ordering is the raw source owner's UTC-instant / record-id order.
-- Historical material owns only its member and explicit source closure. The capsule
-- digest is an adoption witness, not a revocable lease on already retained bytes.
CREATE VIEW historical_preservation_available AS
SELECT p.* FROM historical_memory_captures p
WHERE p.state='active' AND p.material_json IS NOT NULL
  AND EXISTS(SELECT 1 FROM evidence_capsules e WHERE e.workspace_id=p.workspace_id
    AND e.object_id=p.evidence_id AND e.lifecycle_state='active')
  AND EXISTS(SELECT 1 FROM source_statement_artifacts a WHERE a.workspace_id=p.workspace_id AND a.artifact_id=p.evidence_id)
  AND NOT EXISTS(SELECT 1 FROM json_each(p.source_roots_json) root WHERE
    json_extract(root.value,'$.workspace_id')<>p.workspace_id OR NOT EXISTS(
      SELECT 1 FROM source_records source WHERE source.workspace_id=p.workspace_id
        AND source.record_id=json_extract(root.value,'$.root_id')
        AND source.source_id=json_extract(root.value,'$.source_id')
        AND source.source_version=json_extract(root.value,'$.source_version')
        AND source.content_digest=json_extract(root.value,'$.content_digest')
        AND source.source_body IS NOT NULL AND source.record_id=(
          SELECT source_records.record_id FROM source_records
          WHERE source_records.workspace_id=source.workspace_id AND source_records.source_id=source.source_id
          ORDER BY alaya_utc_order_key(source_records.recorded_at) DESC,source_records.record_id DESC LIMIT 1))
    OR EXISTS(SELECT 1 FROM projection_erase_barriers b WHERE b.workspace_id=p.workspace_id
      AND b.subject_kind='source_record' AND b.subject_id=json_extract(root.value,'$.root_id')));

-- Only the current, unchanged owning capsule can substitute its dependency edge.
-- A historical reader never reads capsule summary, membership or sibling material.
CREATE VIEW independent_preservation_available AS
SELECT p.* FROM historical_preservation_available p
JOIN synthesis_capsules s ON s.workspace_id=p.workspace_id AND s.object_id=p.capsule_id
JOIN preservation_capsule_revisions r ON r.workspace_id=p.workspace_id AND r.capsule_id=p.capsule_id
WHERE r.revision=p.capsule_revision AND s.lifecycle_state<>'tombstone' AND s.synthesis_status<>'archived'
  AND EXISTS(SELECT 1 FROM json_each(s.source_memory_refs) WHERE value=p.memory_id)
  AND NOT EXISTS(SELECT 1 FROM privacy_dependency_quarantine q
    WHERE q.workspace_id=p.workspace_id AND q.object_kind='synthesis_capsule' AND q.object_id=p.capsule_id);

DROP VIEW privacy_dependency_candidates;
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
  WHERE NOT EXISTS (SELECT 1 FROM independent_preservation_available p
    WHERE p.workspace_id=s.workspace_id AND p.capsule_id=s.object_id AND p.memory_id=ref.value)
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


CREATE TRIGGER historical_capture_insert_guard BEFORE INSERT ON historical_memory_captures BEGIN
  SELECT CASE WHEN NEW.state<>'active' OR NEW.audit_event_id IS NOT NULL OR NOT EXISTS(
    SELECT 1 FROM memory_entries m WHERE m.workspace_id=NEW.workspace_id AND m.object_id=NEW.memory_id
      AND m.lifecycle_state='dormant' AND COALESCE(m.retention_state,'') NOT IN ('canon','consolidated','tombstoned')
      AND COALESCE(m.decay_profile,'') NOT IN ('pinned','hazard'))
    THEN RAISE(ABORT,'historical capture requires a new guarded dormant adoption') END;
END;
CREATE TRIGGER historical_capture_index AFTER INSERT ON historical_memory_captures BEGIN
  INSERT INTO historical_memory_capture_sources SELECT NEW.workspace_id,NEW.memory_id,NEW.capsule_id,
    json_extract(value,'$.root_id'),json_extract(value,'$.source_id'),
    json_extract(value,'$.source_version'),json_extract(value,'$.content_digest') FROM json_each(NEW.source_roots_json);
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM independent_preservation_available
    WHERE workspace_id=NEW.workspace_id AND capture_id=NEW.capture_id)
    THEN RAISE(ABORT,'historical capture source or capsule unavailable') END;
END;
CREATE TRIGGER historical_capture_immutable BEFORE UPDATE ON historical_memory_captures BEGIN
  SELECT CASE WHEN (NEW.workspace_id,NEW.memory_id,NEW.capsule_id,NEW.capture_id,NEW.capsule_revision,
    NEW.evidence_id,NEW.terminal_updated_at,NEW.source_roots_json) IS NOT
    (OLD.workspace_id,OLD.memory_id,OLD.capsule_id,OLD.capture_id,OLD.capsule_revision,
    OLD.evidence_id,OLD.terminal_updated_at,OLD.source_roots_json)
    OR (NEW.material_json IS NOT OLD.material_json AND NOT (NEW.state='erased' AND NEW.material_json IS NULL))
    OR (OLD.state<>'active' AND NEW.state='active') OR (OLD.state='erased' AND NEW.state<>'erased')
    OR (OLD.audit_event_id IS NOT NULL AND NEW.audit_event_id IS NOT OLD.audit_event_id)
    THEN RAISE(ABORT,'historical capture is immutable and cannot be restored') END;
  SELECT CASE WHEN NEW.audit_event_id IS NOT OLD.audit_event_id AND NOT EXISTS(
    SELECT 1 FROM event_log e WHERE e.event_id=NEW.audit_event_id AND e.workspace_id=NEW.workspace_id
      AND e.entity_type='memory_entry' AND e.entity_id=NEW.memory_id AND e.event_type='soul.memory.state_changed'
      AND json_extract(e.payload_json,'$.preservation.capture_id')=NEW.capture_id
      AND json_extract(e.payload_json,'$.to_state')='tombstone')
    THEN RAISE(ABORT,'historical capture requires its committed transition audit') END;
END;
CREATE TRIGGER historical_capture_no_delete BEFORE DELETE ON historical_memory_captures
WHEN EXISTS(SELECT 1 FROM workspaces WHERE workspace_id=OLD.workspace_id) BEGIN
  SELECT RAISE(ABORT,'historical capture lineage cannot be deleted');
END;
CREATE TRIGGER historical_capture_source_insert_guard BEFORE INSERT ON historical_memory_capture_sources
WHEN NOT EXISTS(SELECT 1 FROM historical_memory_captures p, json_each(p.source_roots_json) root
  WHERE p.workspace_id=NEW.workspace_id AND p.memory_id=NEW.memory_id AND p.capsule_id=NEW.capsule_id
    AND json_extract(root.value,'$.root_id')=NEW.record_id
    AND json_extract(root.value,'$.source_id')=NEW.source_id
    AND json_extract(root.value,'$.source_version')=NEW.source_version
    AND json_extract(root.value,'$.content_digest')=NEW.content_digest)
BEGIN SELECT RAISE(ABORT,'historical capture source index must match immutable lineage'); END;
CREATE TRIGGER historical_capture_source_immutable BEFORE UPDATE ON historical_memory_capture_sources BEGIN
  SELECT RAISE(ABORT,'historical capture source lineage is immutable');
END;
CREATE TRIGGER historical_capture_source_no_delete BEFORE DELETE ON historical_memory_capture_sources
WHEN EXISTS(SELECT 1 FROM historical_memory_captures p WHERE p.workspace_id=OLD.workspace_id
  AND p.memory_id=OLD.memory_id AND p.capsule_id=OLD.capsule_id) BEGIN
  SELECT RAISE(ABORT,'historical capture source lineage cannot be deleted');
END;
CREATE TRIGGER historical_capture_invalidated AFTER UPDATE OF state ON historical_memory_captures
WHEN NEW.state<>'active' AND OLD.state='active' BEGIN
  INSERT OR IGNORE INTO privacy_dependency_quarantine(workspace_id,object_kind,object_id)
    VALUES(NEW.workspace_id,'synthesis_capsule',NEW.capsule_id);
  INSERT OR IGNORE INTO privacy_dependency_quarantine(workspace_id,object_kind,object_id)
    SELECT workspace_id,object_kind,object_id FROM privacy_dependency_candidates WHERE workspace_id=NEW.workspace_id;
END;
CREATE TRIGGER preservation_capsule_created AFTER INSERT ON synthesis_capsules BEGIN
  INSERT INTO preservation_capsule_revisions VALUES(NEW.workspace_id,NEW.object_id,0)
    ON CONFLICT(workspace_id,capsule_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER preservation_capsule_changed AFTER UPDATE ON synthesis_capsules BEGIN
  UPDATE preservation_capsule_revisions SET revision=revision+1 WHERE workspace_id=OLD.workspace_id AND capsule_id=OLD.object_id;
  INSERT OR IGNORE INTO privacy_dependency_quarantine(workspace_id,object_kind,object_id)
    SELECT workspace_id,object_kind,object_id FROM privacy_dependency_candidates WHERE workspace_id=NEW.workspace_id;
END;

-- Exactly the terminal transition may change the captured member's five lifecycle fields.
-- A later write cannot restore certificate validity, even if it restores old values.
CREATE TRIGGER preservation_member_changed AFTER UPDATE ON memory_entries BEGIN
  UPDATE historical_memory_captures SET state='invalidated'
    WHERE workspace_id=OLD.workspace_id AND memory_id=OLD.object_id AND state='active' AND NOT (
      OLD.lifecycle_state='dormant' AND NEW.lifecycle_state='tombstone' AND NEW.retention_state='tombstoned'
      AND NEW.forget_disposition='compressed' AND NEW.forget_disposition_ref=capsule_id
      AND NEW.updated_at=terminal_updated_at
      AND (NEW.object_id,NEW.object_kind,NEW.schema_version,NEW.created_at,NEW.created_by,NEW.dimension,NEW.source_kind,NEW.formation_kind,NEW.scope_class,NEW.content,NEW.domain_tags,NEW.evidence_refs,NEW.workspace_id,NEW.run_id,NEW.surface_id,NEW.storage_tier,NEW.activation_score,NEW.retention_score,NEW.manifestation_state,NEW.decay_profile,NEW.confidence,NEW.last_used_at,NEW.last_hit_at,NEW.reinforcement_count,NEW.contradiction_count,NEW.superseded_by,NEW.projection_schema_version,NEW.event_time_start,NEW.event_time_end,NEW.valid_from,NEW.valid_to,NEW.time_precision,NEW.time_source,NEW.preference_subject,NEW.preference_predicate,NEW.preference_object,NEW.preference_category,NEW.preference_polarity,NEW.facet_tags,NEW.canonical_entities) IS (OLD.object_id,OLD.object_kind,OLD.schema_version,OLD.created_at,OLD.created_by,OLD.dimension,OLD.source_kind,OLD.formation_kind,OLD.scope_class,OLD.content,OLD.domain_tags,OLD.evidence_refs,OLD.workspace_id,OLD.run_id,OLD.surface_id,OLD.storage_tier,OLD.activation_score,OLD.retention_score,OLD.manifestation_state,OLD.decay_profile,OLD.confidence,OLD.last_used_at,OLD.last_hit_at,OLD.reinforcement_count,OLD.contradiction_count,OLD.superseded_by,OLD.projection_schema_version,OLD.event_time_start,OLD.event_time_end,OLD.valid_from,OLD.valid_to,OLD.time_precision,OLD.time_source,OLD.preference_subject,OLD.preference_predicate,OLD.preference_object,OLD.preference_category,OLD.preference_polarity,OLD.facet_tags,OLD.canonical_entities));
END;
CREATE TRIGGER preservation_evidence_capsules_update AFTER UPDATE ON evidence_capsules
WHEN (NEW.lifecycle_state,NEW.gist,NEW.excerpt,NEW.source_hash,NEW.evidence_health_state,NEW.updated_at)
  IS NOT (OLD.lifecycle_state,OLD.gist,OLD.excerpt,OLD.source_hash,OLD.evidence_health_state,OLD.updated_at) BEGIN
  UPDATE historical_memory_captures SET state='invalidated'
    WHERE workspace_id=OLD.workspace_id AND evidence_id=OLD.object_id AND state='active';
END;
CREATE TRIGGER preservation_evidence_capsules_delete AFTER DELETE ON evidence_capsules BEGIN
  UPDATE historical_memory_captures SET state='invalidated'
    WHERE workspace_id=OLD.workspace_id AND evidence_id=OLD.object_id AND state='active';
END;
CREATE TRIGGER preservation_source_statement_artifacts_delete AFTER DELETE ON source_statement_artifacts BEGIN
  UPDATE historical_memory_captures SET state='invalidated'
    WHERE workspace_id=OLD.workspace_id AND evidence_id=OLD.artifact_id AND state='active';
END;
CREATE TRIGGER preservation_statement_dependencies_insert AFTER INSERT ON source_statement_dependencies BEGIN
  UPDATE historical_memory_captures SET state='invalidated'
    WHERE workspace_id=NEW.workspace_id AND evidence_id=NEW.artifact_id AND state='active';
END;
CREATE TRIGGER preservation_statement_dependencies_delete AFTER DELETE ON source_statement_dependencies BEGIN
  UPDATE historical_memory_captures SET state='invalidated'
    WHERE workspace_id=OLD.workspace_id AND evidence_id=OLD.artifact_id AND state='active';
END;
CREATE TRIGGER preservation_source_insert AFTER INSERT ON source_records BEGIN
  UPDATE historical_memory_captures SET state='invalidated'
    WHERE historical_memory_captures.workspace_id=NEW.workspace_id AND historical_memory_captures.state='active'
      AND EXISTS(SELECT 1 FROM historical_memory_capture_sources root WHERE root.workspace_id=historical_memory_captures.workspace_id
        AND root.memory_id=historical_memory_captures.memory_id AND root.capsule_id=historical_memory_captures.capsule_id AND root.source_id=NEW.source_id)
      AND NOT EXISTS(SELECT 1 FROM historical_preservation_available ready
        WHERE ready.workspace_id=historical_memory_captures.workspace_id AND ready.capture_id=historical_memory_captures.capture_id);
END;
CREATE TRIGGER preservation_source_update AFTER UPDATE ON source_records BEGIN
  UPDATE historical_memory_captures SET state='invalidated'
    WHERE historical_memory_captures.workspace_id=NEW.workspace_id AND historical_memory_captures.state='active'
      AND EXISTS(SELECT 1 FROM historical_memory_capture_sources root WHERE root.workspace_id=historical_memory_captures.workspace_id
        AND root.memory_id=historical_memory_captures.memory_id AND root.capsule_id=historical_memory_captures.capsule_id AND root.source_id=NEW.source_id)
      AND NOT EXISTS(SELECT 1 FROM historical_preservation_available ready
        WHERE ready.workspace_id=historical_memory_captures.workspace_id AND ready.capture_id=historical_memory_captures.capture_id);
END;
CREATE TRIGGER preservation_source_delete AFTER DELETE ON source_records BEGIN
  UPDATE historical_memory_captures SET state='invalidated'
    WHERE historical_memory_captures.workspace_id=OLD.workspace_id AND historical_memory_captures.state='active'
      AND EXISTS(SELECT 1 FROM historical_memory_capture_sources root WHERE root.workspace_id=historical_memory_captures.workspace_id
        AND root.memory_id=historical_memory_captures.memory_id AND root.capsule_id=historical_memory_captures.capsule_id AND root.source_id=OLD.source_id)
      AND NOT EXISTS(SELECT 1 FROM historical_preservation_available ready
        WHERE ready.workspace_id=historical_memory_captures.workspace_id AND ready.capture_id=historical_memory_captures.capture_id);
END;
CREATE TRIGGER preservation_source_erased AFTER INSERT ON projection_erase_barriers
WHEN NEW.subject_kind='source_record' BEGIN
  UPDATE historical_memory_captures SET state='invalidated'
    WHERE historical_memory_captures.workspace_id=NEW.workspace_id AND historical_memory_captures.state='active'
      AND EXISTS(SELECT 1 FROM historical_memory_capture_sources root WHERE root.workspace_id=historical_memory_captures.workspace_id
        AND root.memory_id=historical_memory_captures.memory_id AND root.capsule_id=historical_memory_captures.capsule_id AND root.record_id=NEW.subject_id);
END;
CREATE TRIGGER preservation_source_repair_dirty AFTER INSERT ON historical_memory_capture_sources
WHEN (SELECT repairing FROM source_erase_repair_control WHERE singleton=1)=0 BEGIN
  UPDATE source_erase_closure_progress SET data_revision=data_revision+1,dirty=1
    WHERE workspace_id=NEW.workspace_id AND barrier_id IN (
      SELECT barrier_id FROM projection_erase_barriers WHERE workspace_id=NEW.workspace_id
        AND subject_kind='source_record' AND subject_id=NEW.record_id);
END;
CREATE TRIGGER preservation_payload_repair_dirty AFTER UPDATE ON historical_memory_captures
WHEN (SELECT repairing FROM source_erase_repair_control WHERE singleton=1)=0 BEGIN
  UPDATE source_erase_closure_progress SET data_revision=data_revision+1,dirty=1
    WHERE workspace_id=NEW.workspace_id AND barrier_id IN (
      SELECT barrier_id FROM projection_erase_barriers WHERE workspace_id=NEW.workspace_id
        AND subject_kind='source_record' AND subject_id IN (
          SELECT record_id FROM historical_memory_capture_sources WHERE workspace_id=NEW.workspace_id
            AND memory_id=NEW.memory_id AND capsule_id=NEW.capsule_id));
END;
CREATE TRIGGER preserved_member_claim_insert BEFORE INSERT ON claim_forms
WHEN EXISTS(SELECT 1 FROM json_each(NEW.source_object_refs) ref
  JOIN historical_memory_capture_sources root ON root.workspace_id=NEW.workspace_id
    AND ref.value IN (root.memory_id,root.capsule_id)
  JOIN projection_erase_barriers barrier ON barrier.workspace_id=root.workspace_id
    AND barrier.subject_kind='source_record' AND barrier.subject_id=root.record_id)
  AND NOT COALESCE(NEW.lifecycle_state='tombstone' AND NEW.proposition_digest='erased',0)
BEGIN SELECT RAISE(ABORT,'erased historical member cannot be restored through a claim'); END;
CREATE TRIGGER preserved_member_claim_update BEFORE UPDATE OF source_object_refs ON claim_forms
WHEN EXISTS(SELECT 1 FROM json_each(NEW.source_object_refs) ref
  JOIN historical_memory_capture_sources root ON root.workspace_id=NEW.workspace_id
    AND ref.value IN (root.memory_id,root.capsule_id)
  JOIN projection_erase_barriers barrier ON barrier.workspace_id=root.workspace_id
    AND barrier.subject_kind='source_record' AND barrier.subject_id=root.record_id)
  AND NOT COALESCE(NEW.lifecycle_state='tombstone' AND NEW.proposition_digest='erased',0)
BEGIN SELECT RAISE(ABORT,'erased historical member cannot be restored through a claim'); END;
-- GC removes live dependency indexes, not the erased identity's obligations. Stripping
-- references or reusing its identifier must not turn a retained descendant into independent data.
CREATE VIEW erased_historical_memory_identities AS
SELECT DISTINCT root.workspace_id,root.memory_id,root.capsule_id
FROM historical_memory_capture_sources root JOIN projection_erase_barriers barrier
  ON barrier.workspace_id=root.workspace_id AND barrier.subject_kind='source_record'
    AND barrier.subject_id=root.record_id;
CREATE TRIGGER preserved_memory_insert_guard BEFORE INSERT ON memory_entries
WHEN EXISTS(SELECT 1 FROM erased_historical_memory_identities erased
  WHERE erased.workspace_id=NEW.workspace_id AND erased.memory_id=NEW.object_id)
  AND NOT COALESCE(NEW.lifecycle_state='tombstone' AND NEW.retention_state='tombstoned' AND NEW.content='erased',0)
BEGIN SELECT RAISE(ABORT,'erased historical memory identity cannot be restored'); END;
CREATE TRIGGER preserved_memory_update_guard BEFORE UPDATE ON memory_entries
WHEN EXISTS(SELECT 1 FROM erased_historical_memory_identities erased
  WHERE erased.workspace_id=NEW.workspace_id AND erased.memory_id=NEW.object_id)
  AND NOT COALESCE(NEW.lifecycle_state='tombstone' AND NEW.retention_state='tombstoned' AND NEW.content='erased',0)
BEGIN SELECT RAISE(ABORT,'erased historical memory identity cannot be restored'); END;
CREATE TRIGGER preserved_capsule_insert_guard BEFORE INSERT ON synthesis_capsules
WHEN EXISTS(SELECT 1 FROM erased_historical_memory_identities erased
  WHERE erased.workspace_id=NEW.workspace_id AND erased.capsule_id=NEW.object_id)
  AND NOT COALESCE(NEW.lifecycle_state='tombstone' AND NEW.synthesis_status='archived'
    AND NEW.topic_key='erased' AND NEW.summary='erased',0)
BEGIN SELECT RAISE(ABORT,'erased historical capsule identity cannot be restored'); END;
CREATE TRIGGER preserved_capsule_update_guard BEFORE UPDATE ON synthesis_capsules
WHEN EXISTS(SELECT 1 FROM erased_historical_memory_identities erased
  WHERE erased.workspace_id=NEW.workspace_id AND erased.capsule_id=NEW.object_id)
  AND NOT COALESCE(NEW.lifecycle_state='tombstone' AND NEW.synthesis_status='archived'
    AND NEW.topic_key='erased' AND NEW.summary='erased',0)
BEGIN SELECT RAISE(ABORT,'erased historical capsule identity cannot be restored'); END;

-- A removed or rewritten audit cannot leave an independently readable certificate.
CREATE TRIGGER preservation_audit_deleted AFTER DELETE ON event_log BEGIN
  UPDATE historical_memory_captures SET state='invalidated' WHERE audit_event_id=OLD.event_id AND state='active';
END;
CREATE TRIGGER preservation_audit_changed AFTER UPDATE ON event_log
WHEN NEW.payload_json IS NOT OLD.payload_json OR NEW.event_type IS NOT OLD.event_type
  OR NEW.entity_id IS NOT OLD.entity_id OR NEW.workspace_id IS NOT OLD.workspace_id BEGIN
  UPDATE historical_memory_captures SET state='invalidated' WHERE audit_event_id=OLD.event_id AND state='active';
END;
