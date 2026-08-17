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

CREATE UNIQUE INDEX projection_erase_barriers_subject_identity
ON projection_erase_barriers(workspace_id, subject_kind, subject_id);

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
