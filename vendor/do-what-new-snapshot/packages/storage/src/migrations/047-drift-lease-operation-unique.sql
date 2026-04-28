-- Enforce a single durable drift lease row per (workspace_id, operation_type).
-- A pre-fix race in acquireLease() could insert duplicates before any caller
-- reread active leases. Prefer the currently effective lease if one exists;
-- otherwise keep the most recently expired duplicate before adding the
-- storage-level uniqueness guarantee.
DELETE FROM drift_leases
WHERE rowid IN (
  SELECT rid
  FROM (
    SELECT
      rowid AS rid,
      ROW_NUMBER() OVER (
        PARTITION BY workspace_id, operation_type
        ORDER BY
          CASE
            WHEN julianday(expires_at) > julianday('now') THEN 0
            ELSE 1
          END ASC,
          CASE
            WHEN julianday(expires_at) > julianday('now') THEN julianday(granted_at)
            ELSE NULL
          END ASC,
          CASE
            WHEN julianday(expires_at) <= julianday('now') THEN julianday(expires_at)
            ELSE NULL
          END DESC,
          rowid ASC
      ) AS rn
    FROM drift_leases
  ) ranked
  WHERE ranked.rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_drift_leases_workspace_operation
  ON drift_leases(workspace_id, operation_type);
