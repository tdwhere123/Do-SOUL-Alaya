-- Delivery reads one unit's ends inside the hydrated window, not every span of the root.
CREATE INDEX idx_source_spans_record_purpose_end ON source_spans(workspace_id, record_id, purpose, end_offset);
