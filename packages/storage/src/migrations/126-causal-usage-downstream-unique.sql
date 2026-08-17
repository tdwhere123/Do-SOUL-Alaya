-- Receipt identity already includes downstream_ref, so one confirm event
-- may record usage for every delivered source object. UNIQUE(workspace_id,
-- causal_key) collapsed those rows onto a single object.

CREATE TABLE causal_usage_receipts_v126 (
  workspace_id     TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  identity         TEXT NOT NULL,
  causal_key       TEXT NOT NULL,
  occurred_at      TEXT NOT NULL,
  downstream_ref   TEXT NOT NULL,
  weight           REAL NOT NULL,
  scope            TEXT NOT NULL,
  usage_kind       TEXT NOT NULL CHECK (usage_kind IN ('causal', 'delivery', 'inspection')),
  operator_id      TEXT NOT NULL,
  recorded_at      TEXT NOT NULL,
  PRIMARY KEY (workspace_id, identity),
  UNIQUE (workspace_id, causal_key, downstream_ref),
  CHECK (typeof(weight) IN ('integer', 'real') AND weight >= 0 AND weight < 1e308),
  CHECK (usage_kind = 'causal' OR weight = 0)
);

INSERT INTO causal_usage_receipts_v126 (
  workspace_id, identity, causal_key, occurred_at, downstream_ref,
  weight, scope, usage_kind, operator_id, recorded_at
)
SELECT
  workspace_id, identity, causal_key, occurred_at, downstream_ref,
  weight, scope, usage_kind, operator_id, recorded_at
FROM causal_usage_receipts;

DROP TABLE causal_usage_receipts;
ALTER TABLE causal_usage_receipts_v126 RENAME TO causal_usage_receipts;

CREATE INDEX idx_causal_usage_receipts_workspace
  ON causal_usage_receipts(workspace_id, occurred_at, identity);
