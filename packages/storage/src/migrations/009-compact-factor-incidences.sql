-- The (workspace_id, span_id, factor_id) index duplicates the UNIQUE prefix.
-- WITHOUT ROWID clusters PRIMARY KEY (workspace_id, incidence_id) so list/erase
-- do not keep a second PK btree.

DROP INDEX IF EXISTS idx_factor_incidences_workspace;

DROP TRIGGER IF EXISTS factor_incidences_reject_erased_insert;

CREATE TABLE factor_incidences_compact (
  workspace_id      TEXT NOT NULL REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
  incidence_id      TEXT NOT NULL,
  span_id           TEXT NOT NULL,
  factor_id         TEXT NOT NULL,
  scope             TEXT NOT NULL,
  operator_id       TEXT NOT NULL,
  recorded_at       TEXT NOT NULL,
  PRIMARY KEY (workspace_id, incidence_id),
  FOREIGN KEY (workspace_id, span_id)
    REFERENCES source_spans(workspace_id, span_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, factor_id)
    REFERENCES factor_descriptors(workspace_id, factor_id) ON DELETE CASCADE,
  UNIQUE (workspace_id, span_id, factor_id, scope, operator_id)
) WITHOUT ROWID;

INSERT INTO factor_incidences_compact (
  workspace_id, incidence_id, span_id, factor_id, scope, operator_id, recorded_at
)
SELECT
  workspace_id, incidence_id, span_id, factor_id, scope, operator_id, recorded_at
FROM factor_incidences;

DROP TABLE factor_incidences;

ALTER TABLE factor_incidences_compact RENAME TO factor_incidences;

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
