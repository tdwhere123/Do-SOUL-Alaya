-- A1 (HITL daemon backbone) — review records carry an explicit
-- reviewer_identity. Reviews are persisted as event_log entries
-- (SOUL_REVIEW_CREATED / SOUL_REVIEW_COMPLETED) keyed by proposal_id;
-- a single proposal in the v0.1 model is reviewed at most once, so the
-- reviewer column lives on the proposals row alongside resolution_state.
-- Existing rows pre-A1 keep NULL reviewer_identity until they are
-- reviewed, which preserves backwards-compatible reads.
ALTER TABLE proposals ADD COLUMN reviewer_identity TEXT;

-- soul.list_pending_proposals projects a HITL summary that includes
-- target_object_kind, a short proposed_change_summary, and created_at.
-- Storing them inline avoids a join against event_log payloads on every
-- list call. Defaults preserve backwards-compatible reads for any
-- pre-A1 rows that may exist:
--   - target_object_kind defaults to 'memory_entry' (the only kind the
--     MCP-driven proposeMemoryUpdate path produces in v0.1).
--   - proposed_change_summary defaults to '' so existing rows still
--     parse under the new TEXT NOT NULL discipline.
--   - created_at is nullable for legacy rows; the post-A1 INSERT path
--     always populates it. Pre-A1 backfill: copy last_updated_at.
ALTER TABLE proposals ADD COLUMN target_object_kind TEXT NOT NULL DEFAULT 'memory_entry';
ALTER TABLE proposals ADD COLUMN proposed_change_summary TEXT NOT NULL DEFAULT '';
ALTER TABLE proposals ADD COLUMN created_at TEXT;
UPDATE proposals SET created_at = last_updated_at WHERE created_at IS NULL;
