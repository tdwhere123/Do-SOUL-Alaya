CREATE TABLE IF NOT EXISTS tool_specs (
  tool_id TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK(
    category IN ('read', 'write', 'exec', 'network', 'validation', 'evidence', 'memory', 'governance')
  ),
  description TEXT NOT NULL,
  scope_guard TEXT NOT NULL CHECK(
    scope_guard IN ('workspace', 'worktree', 'project', 'global')
  ),
  read_only INTEGER NOT NULL CHECK(read_only IN (0, 1)),
  destructive INTEGER NOT NULL CHECK(destructive IN (0, 1)),
  concurrency_safe INTEGER NOT NULL CHECK(concurrency_safe IN (0, 1)),
  interrupt_behavior TEXT NOT NULL CHECK(
    interrupt_behavior IN ('continue', 'wait', 'abort')
  ),
  requires_confirmation INTEGER NOT NULL CHECK(requires_confirmation IN (0, 1)),
  requires_evidence_reopen INTEGER NOT NULL CHECK(requires_evidence_reopen IN (0, 1)),
  rollback_support TEXT NOT NULL CHECK(
    rollback_support IN ('none', 'best_effort', 'guaranteed')
  ),
  fast_path_eligible INTEGER NOT NULL CHECK(fast_path_eligible IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_tool_specs_category
  ON tool_specs(category);

CREATE INDEX IF NOT EXISTS idx_tool_specs_scope_guard
  ON tool_specs(scope_guard);
