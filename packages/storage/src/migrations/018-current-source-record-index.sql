-- The Protocol UTC key preserves arbitrary fractional precision and minute
-- precision. Keep tombstones and inaccessible scopes in the winner index so
-- an older retained version can never replace the current record.
CREATE INDEX idx_source_records_current
ON source_records (
  workspace_id, source_id, alaya_utc_order_key(recorded_at) DESC, record_id DESC
);
