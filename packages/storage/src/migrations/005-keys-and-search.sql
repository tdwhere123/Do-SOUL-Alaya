-- Object keys, search projections, and formation receipts.
CREATE TRIGGER synthesis_capsule_fts_ai
AFTER INSERT ON synthesis_capsules
BEGIN
  INSERT INTO synthesis_capsule_fts (rowid, object_id, workspace_id, content)
  VALUES (new.rowid, new.object_id, new.workspace_id, new.summary);
  INSERT INTO synthesis_capsule_fts_trigram (rowid, object_id, workspace_id, content)
  VALUES (new.rowid, new.object_id, new.workspace_id, new.summary);
END;

CREATE TRIGGER synthesis_capsule_fts_ad
AFTER DELETE ON synthesis_capsules
BEGIN
  DELETE FROM synthesis_capsule_fts WHERE rowid = old.rowid;
  DELETE FROM synthesis_capsule_fts_trigram WHERE rowid = old.rowid;
END;

CREATE TRIGGER synthesis_capsule_fts_au
AFTER UPDATE OF object_id, workspace_id, summary ON synthesis_capsules
BEGIN
  DELETE FROM synthesis_capsule_fts WHERE rowid = old.rowid;
  INSERT INTO synthesis_capsule_fts (rowid, object_id, workspace_id, content)
  VALUES (new.rowid, new.object_id, new.workspace_id, new.summary);
  DELETE FROM synthesis_capsule_fts_trigram WHERE rowid = old.rowid;
  INSERT INTO synthesis_capsule_fts_trigram (rowid, object_id, workspace_id, content)
  VALUES (new.rowid, new.object_id, new.workspace_id, new.summary);
END;

CREATE TRIGGER block_legacy_path_relation_insert_when_temporal_projection_selected
BEFORE INSERT ON path_relations
WHEN EXISTS (
  SELECT 1
  FROM temporal_schema_state
  WHERE state_id = 1 AND temporal_projection_selected = 1
)
BEGIN
  SELECT RAISE(ABORT, 'Legacy path relation writes are disabled after temporal projection selection.');
END;

CREATE TRIGGER block_legacy_path_relation_update_when_temporal_projection_selected
BEFORE UPDATE ON path_relations
WHEN EXISTS (
  SELECT 1
  FROM temporal_schema_state
  WHERE state_id = 1 AND temporal_projection_selected = 1
)
BEGIN
  SELECT RAISE(ABORT, 'Legacy path relation writes are disabled after temporal projection selection.');
END;

CREATE TRIGGER block_legacy_path_relation_delete_when_temporal_projection_selected
BEFORE DELETE ON path_relations
WHEN EXISTS (
  SELECT 1
  FROM temporal_schema_state
  WHERE state_id = 1 AND temporal_projection_selected = 1
)
BEGIN
  SELECT RAISE(ABORT, 'Legacy path relation writes are disabled after temporal projection selection.');
END;

CREATE TRIGGER evidence_capsule_fts_ai
AFTER INSERT ON evidence_capsules
BEGIN
  INSERT INTO evidence_capsule_fts (rowid, object_id, workspace_id, content)
  VALUES (new.rowid, new.object_id, new.workspace_id, COALESCE(new.gist, new.excerpt));
  INSERT INTO evidence_capsule_fts_trigram (rowid, object_id, workspace_id, content)
  VALUES (new.rowid, new.object_id, new.workspace_id, COALESCE(new.gist, new.excerpt));
END;

CREATE TRIGGER evidence_capsule_fts_ad
AFTER DELETE ON evidence_capsules
BEGIN
  DELETE FROM evidence_capsule_fts WHERE rowid = old.rowid;
  DELETE FROM evidence_capsule_fts_trigram WHERE rowid = old.rowid;
END;

CREATE TRIGGER evidence_capsule_fts_au
AFTER UPDATE OF object_id, workspace_id, excerpt, gist ON evidence_capsules
BEGIN
  DELETE FROM evidence_capsule_fts WHERE rowid = old.rowid;
  INSERT INTO evidence_capsule_fts (rowid, object_id, workspace_id, content)
  VALUES (new.rowid, new.object_id, new.workspace_id, COALESCE(new.gist, new.excerpt));
  DELETE FROM evidence_capsule_fts_trigram WHERE rowid = old.rowid;
  INSERT INTO evidence_capsule_fts_trigram (rowid, object_id, workspace_id, content)
  VALUES (new.rowid, new.object_id, new.workspace_id, COALESCE(new.gist, new.excerpt));
END;

CREATE TRIGGER recall_routing_key_owners_ai
AFTER INSERT ON event_log
WHEN new.event_type = 'soul.signal.materialized'
  AND new.entity_type = 'candidate_memory_signal'
  AND json_valid(new.payload_json)
  AND json_extract(new.payload_json, '$.success') = 1
BEGIN
  INSERT OR IGNORE INTO recall_routing_key_owners (
    workspace_id, owner_id, owner_kind, signal_id, materialized_at
  )
  SELECT
    new.workspace_id,
    json_extract(created.value, '$.object_id'),
    json_extract(created.value, '$.object_kind'),
    new.entity_id,
    new.created_at
  FROM json_each(new.payload_json, '$.created_objects') AS created
  WHERE json_type(created.value, '$.object_id') = 'text'
    AND json_extract(created.value, '$.object_id') != ''
    AND json_type(created.value, '$.object_kind') = 'text'
    AND json_extract(created.value, '$.object_kind') != '';
END;

CREATE TRIGGER evidence_search_projection_fts_ai
AFTER INSERT ON evidence_search_projections
BEGIN
  INSERT INTO evidence_search_projection_fts (
    rowid, evidence_object_id, projection_id, projection_kind, workspace_id, content
  ) VALUES (
    new.rowid, new.evidence_object_id, new.projection_id, new.projection_kind,
    new.workspace_id, new.content
  );
  INSERT INTO evidence_search_projection_fts_trigram (
    rowid, evidence_object_id, projection_id, projection_kind, workspace_id, content
  ) VALUES (
    new.rowid, new.evidence_object_id, new.projection_id, new.projection_kind,
    new.workspace_id, new.content
  );
END;

CREATE TRIGGER evidence_search_projection_fts_ad
AFTER DELETE ON evidence_search_projections
BEGIN
  DELETE FROM evidence_search_projection_fts WHERE rowid = old.rowid;
  DELETE FROM evidence_search_projection_fts_trigram WHERE rowid = old.rowid;
END;

CREATE TRIGGER evidence_search_projection_fts_au
AFTER UPDATE OF evidence_object_id, projection_id, projection_kind, workspace_id, content
ON evidence_search_projections
BEGIN
  DELETE FROM evidence_search_projection_fts WHERE rowid = old.rowid;
  INSERT INTO evidence_search_projection_fts (
    rowid, evidence_object_id, projection_id, projection_kind, workspace_id, content
  ) VALUES (
    new.rowid, new.evidence_object_id, new.projection_id, new.projection_kind,
    new.workspace_id, new.content
  );
  DELETE FROM evidence_search_projection_fts_trigram WHERE rowid = old.rowid;
  INSERT INTO evidence_search_projection_fts_trigram (
    rowid, evidence_object_id, projection_id, projection_kind, workspace_id, content
  ) VALUES (
    new.rowid, new.evidence_object_id, new.projection_id, new.projection_kind,
    new.workspace_id, new.content
  );
END;

CREATE TRIGGER memory_object_key_fts_ai
AFTER INSERT ON memory_object_keys
BEGIN
  INSERT INTO memory_object_key_fts (
    rowid, owner_id, workspace_id, content
  ) VALUES (
    new.rowid, new.owner_id, new.workspace_id, new.surface
  );
  INSERT INTO memory_object_key_fts_trigram (
    rowid, owner_id, workspace_id, content
  ) VALUES (
    new.rowid, new.owner_id, new.workspace_id, new.surface
  );
END;

CREATE TRIGGER memory_object_key_fts_ad
AFTER DELETE ON memory_object_keys
BEGIN
  DELETE FROM memory_object_key_fts WHERE rowid = old.rowid;
  DELETE FROM memory_object_key_fts_trigram WHERE rowid = old.rowid;
END;

CREATE TRIGGER memory_object_key_fts_au
AFTER UPDATE OF owner_id, workspace_id, surface
ON memory_object_keys
BEGIN
  DELETE FROM memory_object_key_fts WHERE rowid = old.rowid;
  INSERT INTO memory_object_key_fts (
    rowid, owner_id, workspace_id, content
  ) VALUES (
    new.rowid, new.owner_id, new.workspace_id, new.surface
  );
  DELETE FROM memory_object_key_fts_trigram WHERE rowid = old.rowid;
  INSERT INTO memory_object_key_fts_trigram (
    rowid, owner_id, workspace_id, content
  ) VALUES (
    new.rowid, new.owner_id, new.workspace_id, new.surface
  );
END;

CREATE TRIGGER source_records_reject_erased_insert
BEFORE INSERT ON source_records
WHEN EXISTS (
  SELECT 1 FROM projection_erase_barriers
  WHERE workspace_id = NEW.workspace_id
    AND subject_kind = 'source_record'
    AND subject_id = NEW.record_id
)
AND NOT EXISTS (
  SELECT 1 FROM source_records
  WHERE workspace_id = NEW.workspace_id AND record_id = NEW.record_id
)
BEGIN
  SELECT RAISE(ABORT, 'erased source record cannot be admitted');
END;

CREATE TRIGGER source_records_reject_erased_body
BEFORE UPDATE OF source_body ON source_records
WHEN NEW.source_body IS NOT NULL
 AND EXISTS (
  SELECT 1 FROM projection_erase_barriers
  WHERE workspace_id = NEW.workspace_id
    AND subject_kind = 'source_record'
    AND subject_id = NEW.record_id
)
BEGIN
  SELECT RAISE(ABORT, 'erased source record cannot store body');
END;

CREATE TRIGGER factor_descriptors_reject_erased_insert
BEFORE INSERT ON factor_descriptors
WHEN EXISTS (
  SELECT 1 FROM projection_erase_barriers
  WHERE workspace_id = NEW.workspace_id
    AND subject_kind = 'factor'
    AND subject_id = NEW.factor_id
)
AND NOT EXISTS (
  SELECT 1 FROM factor_descriptors
  WHERE workspace_id = NEW.workspace_id AND factor_id = NEW.factor_id
)
BEGIN
  SELECT RAISE(ABORT, 'erased factor cannot be admitted');
END;

CREATE TRIGGER factor_descriptors_reject_erased_payload
BEFORE UPDATE OF canonical_payload ON factor_descriptors
WHEN NEW.canonical_payload IS NOT NULL
 AND EXISTS (
  SELECT 1 FROM projection_erase_barriers
  WHERE workspace_id = NEW.workspace_id
    AND subject_kind = 'factor'
    AND subject_id = NEW.factor_id
)
BEGIN
  SELECT RAISE(ABORT, 'erased factor cannot store payload');
END;

CREATE TRIGGER projection_generations_reject_active_insert
BEFORE INSERT ON projection_generations
WHEN NEW.status = 'active'
BEGIN
  SELECT RAISE(ABORT, 'generation activation requires a pointer swap');
END;

CREATE TRIGGER projection_generations_protect_pointer
BEFORE UPDATE OF status ON projection_generations
WHEN NEW.status != 'active'
 AND EXISTS (
  SELECT 1 FROM projection_generation_pointer
  WHERE workspace_id = NEW.workspace_id
    AND active_generation_id = NEW.generation_id
)
BEGIN
  SELECT RAISE(ABORT, 'pointed generation status requires pointer swap');
END;

CREATE TRIGGER source_record_evidence_refs_reject_erased_insert
BEFORE INSERT ON source_record_evidence_refs
WHEN EXISTS (
  SELECT 1 FROM projection_erase_barriers
  WHERE workspace_id = NEW.workspace_id
    AND subject_kind = 'source_record'
    AND subject_id = NEW.record_id
)
AND NOT EXISTS (
  SELECT 1 FROM source_record_evidence_refs
  WHERE workspace_id = NEW.workspace_id
    AND record_id = NEW.record_id
    AND evidence_object_id = NEW.evidence_object_id
)
BEGIN
  SELECT RAISE(ABORT, 'erased source record cannot bind new evidence');
END;

CREATE TRIGGER source_spans_reject_erased_insert
BEFORE INSERT ON source_spans
WHEN EXISTS (
  SELECT 1 FROM projection_erase_barriers
  WHERE workspace_id = NEW.workspace_id
    AND (
      (subject_kind = 'source_span' AND subject_id = NEW.span_id) OR
      (subject_kind = 'source_record' AND subject_id = NEW.record_id)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'erased source span cannot be admitted');
END;

CREATE TRIGGER factor_incidences_reject_erased_insert
BEFORE INSERT ON factor_incidences
WHEN EXISTS (
  SELECT 1 FROM projection_erase_barriers
  WHERE workspace_id = NEW.workspace_id
    AND (
      (subject_kind = 'incidence' AND subject_id = NEW.incidence_id) OR
      (subject_kind = 'source_span' AND subject_id = NEW.span_id) OR
      (subject_kind = 'factor' AND subject_id = NEW.factor_id)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'erased factor incidence cannot be admitted');
END;

CREATE TRIGGER evidence_capsules_reject_erased_insert
BEFORE INSERT ON evidence_capsules
WHEN EXISTS (
  SELECT 1
  FROM source_record_evidence_refs AS ref
  JOIN projection_erase_barriers AS barrier
    ON barrier.workspace_id = ref.workspace_id
   AND barrier.subject_kind = 'source_record'
   AND barrier.subject_id = ref.record_id
  WHERE ref.workspace_id = NEW.workspace_id
    AND ref.evidence_object_id = NEW.object_id
)
BEGIN
  SELECT RAISE(ABORT, 'erased source evidence cannot be admitted');
END;

CREATE TRIGGER evidence_capsules_reject_erased_content_update
BEFORE UPDATE OF lifecycle_state, semantic_anchor, event_anchor, physical_anchor, gist, excerpt, source_hash
ON evidence_capsules
WHEN NOT (
  NEW.lifecycle_state = 'tombstone' AND
  NEW.semantic_anchor = '{"topic":"erased","keywords":["erased"],"summary":"erased"}' AND
  NEW.event_anchor IS NULL AND NEW.physical_anchor IS NULL AND
  NEW.gist = 'erased' AND NEW.excerpt IS NULL AND NEW.source_hash IS NULL
)
AND EXISTS (
  SELECT 1
  FROM source_record_evidence_refs AS ref
  JOIN projection_erase_barriers AS barrier
    ON barrier.workspace_id = ref.workspace_id
   AND barrier.subject_kind = 'source_record'
   AND barrier.subject_id = ref.record_id
  WHERE ref.workspace_id = NEW.workspace_id
    AND ref.evidence_object_id = NEW.object_id
)
BEGIN
  SELECT RAISE(ABORT, 'erased source evidence cannot store content');
END;

CREATE TRIGGER evidence_search_projections_reject_erased_insert
BEFORE INSERT ON evidence_search_projections
WHEN EXISTS (
  SELECT 1 FROM source_record_evidence_refs AS ref
  JOIN projection_erase_barriers AS barrier
    ON barrier.workspace_id = ref.workspace_id
   AND barrier.subject_kind = 'source_record'
   AND barrier.subject_id = ref.record_id
  WHERE ref.workspace_id = NEW.workspace_id
    AND ref.evidence_object_id = NEW.evidence_object_id
)
BEGIN
  SELECT RAISE(ABORT, 'erased source search projection cannot be admitted');
END;

CREATE TRIGGER evidence_recall_embeddings_reject_erased_insert
BEFORE INSERT ON evidence_recall_embeddings
WHEN EXISTS (
  SELECT 1 FROM source_record_evidence_refs AS ref
  JOIN projection_erase_barriers AS barrier
    ON barrier.workspace_id = ref.workspace_id
   AND barrier.subject_kind = 'source_record'
   AND barrier.subject_id = ref.record_id
  WHERE ref.workspace_id = NEW.workspace_id
    AND ref.evidence_object_id = NEW.owner_object_id
)
BEGIN
  SELECT RAISE(ABORT, 'erased source embedding cannot be admitted');
END;

CREATE TRIGGER evidence_fact_frame_formations_reject_erased_insert
BEFORE INSERT ON evidence_fact_frame_formations
WHEN EXISTS (
  SELECT 1 FROM source_record_evidence_refs AS ref
  JOIN projection_erase_barriers AS barrier
    ON barrier.workspace_id = ref.workspace_id
   AND barrier.subject_kind = 'source_record'
   AND barrier.subject_id = ref.record_id
  WHERE ref.workspace_id = NEW.workspace_id
    AND ref.evidence_object_id = NEW.evidence_object_id
)
BEGIN
  SELECT RAISE(ABORT, 'erased source fact-frame formation cannot be admitted');
END;

CREATE TRIGGER evidence_semantic_factor_formations_reject_erased_insert
BEFORE INSERT ON evidence_semantic_factor_formations
WHEN EXISTS (
  SELECT 1 FROM source_record_evidence_refs AS ref
  JOIN projection_erase_barriers AS barrier
    ON barrier.workspace_id = ref.workspace_id
   AND barrier.subject_kind = 'source_record'
   AND barrier.subject_id = ref.record_id
  WHERE ref.workspace_id = NEW.workspace_id
    AND ref.evidence_object_id = NEW.evidence_object_id
)
BEGIN
  SELECT RAISE(ABORT, 'erased source semantic formation cannot be admitted');
END;

CREATE TRIGGER projection_generation_artifacts_reject_pre_erase_insert
BEFORE INSERT ON projection_generation_artifacts
WHEN EXISTS (
  SELECT 1 FROM projection_erase_barriers
  WHERE workspace_id = NEW.workspace_id
    AND subject_kind = 'generation'
    AND subject_id = NEW.generation_id
)
BEGIN
  SELECT RAISE(ABORT, 'pre-erase generation artifacts cannot be restored');
END;

CREATE TRIGGER projection_pins_reject_pre_erase_insert
BEFORE INSERT ON projection_pins
WHEN EXISTS (
  SELECT 1 FROM projection_erase_barriers
  WHERE workspace_id = NEW.workspace_id
    AND subject_kind = 'generation'
    AND subject_id = NEW.generation_id
)
BEGIN
  SELECT RAISE(ABORT, 'pre-erase generation cannot be pinned');
END;

CREATE TRIGGER memory_entries_reject_erased_source_content_update
BEFORE UPDATE OF content, domain_tags, lifecycle_state, retention_state,
  manifestation_state, preference_subject, preference_predicate, preference_object,
  preference_category, preference_polarity, facet_tags, canonical_entities
ON memory_entries
WHEN NOT (
  NEW.content = 'erased' AND NEW.lifecycle_state = 'tombstone' AND
  NEW.retention_state = 'tombstoned' AND NEW.domain_tags = '[]' AND
  NEW.manifestation_state IS NULL AND NEW.preference_subject IS NULL AND
  NEW.preference_predicate IS NULL AND NEW.preference_object IS NULL AND
  NEW.preference_category IS NULL AND NEW.preference_polarity IS NULL AND
  NEW.facet_tags IS NULL AND NEW.canonical_entities IS NULL
)
AND EXISTS (
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
  SELECT RAISE(ABORT, 'erased source memory cannot store content');
END;

CREATE TRIGGER memory_entries_reject_erased_source_delete
BEFORE DELETE ON memory_entries
WHEN EXISTS (
  SELECT 1 FROM memory_entry_evidence_refs AS memory_ref
  JOIN source_record_evidence_refs AS source_ref
    ON source_ref.workspace_id = memory_ref.workspace_id
   AND source_ref.evidence_object_id = memory_ref.evidence_ref
  JOIN projection_erase_barriers AS barrier
    ON barrier.workspace_id = source_ref.workspace_id
   AND barrier.subject_kind = 'source_record'
   AND barrier.subject_id = source_ref.record_id
  WHERE memory_ref.workspace_id = OLD.workspace_id
    AND memory_ref.memory_id = OLD.object_id
)
BEGIN
  SELECT RAISE(ABORT, 'erased source memory tombstone cannot be deleted');
END;

CREATE TRIGGER memory_embeddings_reject_erased_source_insert
BEFORE INSERT ON memory_embeddings
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
  SELECT RAISE(ABORT, 'erased source memory embedding cannot be admitted');
END;
