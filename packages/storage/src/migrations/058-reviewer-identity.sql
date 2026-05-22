-- Review records carry an explicit reviewer_identity. Reviews are persisted as event_log entries
-- (SOUL_REVIEW_CREATED / SOUL_REVIEW_COMPLETED) keyed by proposal_id;
-- a single proposal is reviewed at most once by this storage contract, so the
-- reviewer column lives on the proposals row alongside resolution_state.
-- Existing rows keep NULL reviewer_identity until they are reviewed,
-- preserving backwards-compatible reads.
ALTER TABLE proposals ADD COLUMN reviewer_identity TEXT;

-- soul.list_pending_proposals projects a HITL summary that includes
-- target_object_kind, a short proposed_change_summary, and created_at.
-- Storing them inline avoids a join against event_log payloads on every
-- list call. The DEFAULTs are a one-time backfill for existing rows that
-- ALTER TABLE has to populate atomically:
--   - target_object_kind defaults to 'memory_entry' for the backfill
--     only. New INSERTs MUST pass the actual kind explicitly:
--     'memory_entry' for soul.propose_memory_update, 'synthesis_capsule'
--     for ProposalService.createFromSynthesisPromotion, and
--     'bankruptcy_dossier' for the budget bankruptcy path.
--   - proposed_change_summary defaults to '' so existing rows still
--     parse under the new TEXT NOT NULL discipline.
--   - created_at is nullable for legacy rows; the new INSERT path
--     always populates it. Existing-row backfill copies last_updated_at.
ALTER TABLE proposals ADD COLUMN target_object_kind TEXT NOT NULL DEFAULT 'memory_entry';
ALTER TABLE proposals ADD COLUMN proposed_change_summary TEXT NOT NULL DEFAULT '';
ALTER TABLE proposals ADD COLUMN created_at TEXT;
UPDATE proposals SET created_at = last_updated_at WHERE created_at IS NULL;
