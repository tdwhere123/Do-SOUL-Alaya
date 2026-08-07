ALTER TABLE relation_assertions
  ADD COLUMN formation_receipt_json TEXT;

-- Assertions formed before receipts cannot prove the decision that created
-- them. Preserve their exact persisted inputs, then remove them from truth.
INSERT INTO relation_assertion_quarantine (
  quarantine_id,
  workspace_id,
  source_kind,
  source_identity,
  reason,
  source_json,
  source_digest,
  quarantined_at
)
SELECT
  'quarantine_legacy_assertion_' || assertion.assertion_id,
  assertion.workspace_id,
  'legacy_relation_assertion',
  assertion.assertion_id,
  'missing_formation_receipt',
  json_object(
    'assertion_id', assertion.assertion_id,
    'workspace_id', assertion.workspace_id,
    'admission_event_id', assertion.admission_event_id,
    'identity_key', assertion.identity_key,
    'anchors', json(assertion.anchors_json),
    'relation_kind', assertion.relation_kind,
    'validity', json(assertion.validity_json),
    'admitted_at', assertion.admitted_at,
    'evidence_ids', json(COALESCE((
      SELECT json_group_array(ordered.evidence_id)
      FROM (
        SELECT evidence.evidence_id
        FROM relation_assertion_evidence AS evidence
        WHERE evidence.assertion_id = assertion.assertion_id
        ORDER BY evidence.evidence_id
      ) AS ordered
    ), '[]')),
    'resolution', CASE
      WHEN resolution.assertion_id IS NULL THEN NULL
      ELSE json_object(
        'resolution_id', resolution.resolution_id,
        'workspace_id', resolution.workspace_id,
        'resolution_event_id', resolution.resolution_event_id,
        'resolution_kind', resolution.resolution_kind,
        'resolved_at', resolution.resolved_at,
        'reason', resolution.reason
      )
    END
  ),
  assertion.identity_key,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM relation_assertions AS assertion
LEFT JOIN relation_assertion_resolution_current AS resolution
  ON resolution.assertion_id = assertion.assertion_id;

DELETE FROM relation_assertions;

DROP TABLE relation_assertion_evidence;
CREATE TABLE relation_assertion_evidence (
  assertion_id TEXT NOT NULL REFERENCES relation_assertions(assertion_id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL,
  source_event_type TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  source_occurred_at TEXT NOT NULL,
  PRIMARY KEY (assertion_id, evidence_id)
);

DELETE FROM temporal_projection_generations;
INSERT INTO temporal_projection_generations (
  generation,
  assertion_schema_generation,
  assertion_event_contract_generation,
  projection_schema_generation,
  projection_policy_id,
  projection_policy_sha256,
  history_digest,
  as_of,
  projection_count,
  projection_digest,
  status,
  created_at,
  verified_at
) VALUES (
  'temporal-bootstrap-empty-v1',
  'relation_assertion_v2',
  'relation_assertion_event_v2',
  'relation_path_projection_v1',
  'relation-path-projection-v1',
  'f68603e497a8d762e5d0ed96e8cd9608475794ccef92c6c3fbc37b76daea7ee7',
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  '1970-01-01T00:00:00.000Z',
  0,
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  'verified',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
);

UPDATE temporal_schema_state
SET assertion_schema_generation = 'relation_assertion_v2',
    assertion_event_contract_generation = 'relation_assertion_event_v2',
    projection_schema_generation = 'relation_path_projection_v1',
    active_projection_generation = 'temporal-bootstrap-empty-v1',
    active_as_of = '1970-01-01T00:00:00.000Z',
    projection_policy_id = 'relation-path-projection-v1',
    projection_policy_sha256 = 'f68603e497a8d762e5d0ed96e8cd9608475794ccef92c6c3fbc37b76daea7ee7',
    history_digest = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    projection_count = 0,
    projection_digest = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    status = 'ready',
    temporal_projection_selection_required = CASE
      WHEN temporal_projection_selection_required = 1 OR temporal_projection_selected = 1 THEN 1
      ELSE 0
    END,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    temporal_projection_selected = 0,
    selection_id = NULL,
    selected_at = NULL
WHERE state_id = 1;

CREATE TABLE memory_hq_observations (
  observation_id TEXT PRIMARY KEY,
  object_id TEXT NOT NULL REFERENCES memory_entries(object_id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  evidence_id TEXT NOT NULL REFERENCES evidence_capsules(object_id) ON DELETE RESTRICT,
  source_event_type TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  source_occurred_at TEXT NOT NULL,
  producer_id TEXT NOT NULL,
  hqs_json TEXT NOT NULL,
  hq_content_sha256 TEXT NOT NULL,
  observation_sha256 TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (object_id, evidence_id, source_event_id, observation_sha256)
);

CREATE INDEX idx_memory_hq_observations_workspace_object
  ON memory_hq_observations (workspace_id, object_id, observation_id);

ALTER TABLE memory_hq
  ADD COLUMN observation_id TEXT REFERENCES memory_hq_observations(observation_id);
