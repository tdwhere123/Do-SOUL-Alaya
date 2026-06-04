-- Durable co-usage counters for PathRelation proposal. Counts toward the
-- co_usage_threshold survive daemon restarts here instead of an in-memory Map.
-- A row drops once its pair proposes a PathRelation, or is evicted when its
-- updated_at falls past the TTL cutoff without ever reaching the threshold.
CREATE TABLE path_relation_co_usage_counters (
  workspace_id    TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  low_memory_id   TEXT NOT NULL,
  high_memory_id  TEXT NOT NULL,
  count           INTEGER NOT NULL,
  first_seen_at   TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (workspace_id, low_memory_id, high_memory_id)
);

CREATE INDEX idx_path_relation_co_usage_counters_updated
  ON path_relation_co_usage_counters(updated_at);
