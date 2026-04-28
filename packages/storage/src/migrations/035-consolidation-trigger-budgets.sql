CREATE TABLE IF NOT EXISTS consolidation_trigger_budgets (
  trigger_id TEXT PRIMARY KEY,
  trigger_source TEXT NOT NULL CHECK(
    trigger_source IN (
      'verification_failure',
      'repeated_override',
      'arbitration_burst',
      'bankruptcy_burst',
      'native_surface_drift'
    )
  ),
  governance_subject TEXT,
  source_object_ref TEXT,
  max_attempts_within_window INTEGER NOT NULL CHECK(max_attempts_within_window >= 1),
  attempts_used INTEGER NOT NULL CHECK(attempts_used >= 0),
  cooldown_until TEXT NOT NULL,
  CHECK(attempts_used <= max_attempts_within_window)
);

CREATE INDEX IF NOT EXISTS idx_consolidation_trigger_budgets_source
  ON consolidation_trigger_budgets(trigger_source, cooldown_until);

CREATE INDEX IF NOT EXISTS idx_consolidation_trigger_budgets_subject
  ON consolidation_trigger_budgets(governance_subject, cooldown_until);

CREATE INDEX IF NOT EXISTS idx_consolidation_trigger_budgets_object_ref
  ON consolidation_trigger_budgets(source_object_ref, cooldown_until);
