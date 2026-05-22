-- reconciliation_leases is the storage-level CAS guard for multi-process
-- ingest reconciliation. A reconciliation pass spans an un-transactionable
-- LLM network round trip plus several async repo writes, so it cannot be
-- wrapped in one SQLite transaction. Instead a caller acquires a
-- short-lived advisory lease keyed by lease_key (the workspace_id for the
-- per-workspace "memory_reconcile" critical section) via an
-- INSERT ... ON CONFLICT compare-and-set: the INSERT wins only when no
-- live lease exists, which is the cross-process mutual-exclusion guarantee
-- a process-local mutex cannot give.
--
-- This is intentionally a separate table from drift_leases (migration
-- 045): drift_leases governs surface-drift operations and its
-- operation_type column is bound to the SurfaceDriftOperationType enum
-- (surface.*) plus a workspaces foreign key. Reconciliation needs a leaf
-- table with no foreign key (ingest reconciliation runs before a
-- workspace row is guaranteed) and a workspace-scoped key, so it gets its
-- own table that reuses the proven INSERT-OR-CONFLICT lease shape.
--
-- owner_token identifies the holder so release and reclaim only touch a
-- lease the caller actually owns. expires_at carries a TTL so a crashed
-- holder cannot wedge ingest forever: once expires_at is in the past any
-- caller may reclaim the lease by overwriting the row in the same
-- ON CONFLICT step. acquired_at is retained for audit / diagnostics.

CREATE TABLE IF NOT EXISTS reconciliation_leases (
  lease_key TEXT PRIMARY KEY,
  owner_token TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_leases_expires_at
  ON reconciliation_leases (expires_at);
