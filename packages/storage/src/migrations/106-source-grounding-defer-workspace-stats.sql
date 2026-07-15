-- Make source-grounding defer accounting workspace-bound without rewriting 105.
-- The old lifetime table cannot be partitioned truthfully, so rebuild it from
-- the append-only defer audit events rather than guessing workspace ownership.

ALTER TABLE source_grounding_defer_reason_counts
  RENAME TO source_grounding_defer_reason_counts_v105;

ALTER TABLE source_grounding_defer_queue ADD COLUMN claim_token TEXT;
ALTER TABLE source_grounding_defer_queue ADD COLUMN claim_token_fingerprint TEXT;
ALTER TABLE source_grounding_defer_queue ADD COLUMN claim_expires_at TEXT;
ALTER TABLE source_grounding_defer_queue
  ADD COLUMN capacity_blocked INTEGER NOT NULL DEFAULT 0 CHECK(capacity_blocked IN (0, 1));

CREATE TABLE source_grounding_defer_reason_counts (
  workspace_id TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  defer_reason TEXT NOT NULL,
  enqueue_count INTEGER NOT NULL CHECK(enqueue_count >= 0),
  PRIMARY KEY (workspace_id, defer_reason)
);

INSERT INTO source_grounding_defer_reason_counts (
  workspace_id, defer_reason, enqueue_count
)
SELECT
  workspace_id,
  json_extract(payload_json, '$.defer_reason'),
  COUNT(*)
FROM event_log
WHERE event_type = 'soul.signal.triaged'
  AND json_valid(payload_json)
  AND json_extract(payload_json, '$.triage_result') = 'deferred'
  AND json_extract(payload_json, '$.defer_class') = 'source_grounding'
  AND json_type(payload_json, '$.defer_reason') = 'text'
  AND json_extract(payload_json, '$.defer_reason') IN (
    'matched_text_absent',
    'matched_text_ambiguous',
    'source_grounding_missing',
    'source_grounding_rejected',
    'source_assertion_incomplete',
    'source_assertion_not_self_contained',
    'source_assertion_too_long'
  )
GROUP BY workspace_id, json_extract(payload_json, '$.defer_reason');

DROP TABLE source_grounding_defer_reason_counts_v105;

CREATE INDEX IF NOT EXISTS idx_source_grounding_defer_queue_workspace_enqueued
  ON source_grounding_defer_queue(workspace_id, enqueued_at, signal_id);

CREATE INDEX IF NOT EXISTS idx_source_grounding_defer_queue_claim_expiry
  ON source_grounding_defer_queue(workspace_id, claim_expires_at);

CREATE INDEX IF NOT EXISTS idx_source_grounding_defer_queue_admission
  ON source_grounding_defer_queue(workspace_id, capacity_blocked, enqueued_at, signal_id);
