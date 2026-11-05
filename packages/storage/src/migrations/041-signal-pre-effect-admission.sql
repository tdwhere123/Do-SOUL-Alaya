-- Historical TRIAGED and retryable DEFERRED states can hide old concurrent
-- effects. Only a later atomic pre-effect admission may establish a lineage.
ALTER TABLE signals ADD COLUMN materialization_lineage_proven INTEGER NOT NULL DEFAULT 0
  CHECK (materialization_lineage_proven IN (0, 1));

-- A memory's independent enrichment can finish while its signal-ref replay
-- remains inspection-blocked. Keep those obligations separately durable.
ALTER TABLE enrich_pending ADD COLUMN independent_processed_at TEXT;
ALTER TABLE enrich_pending ADD COLUMN signal_ref_waiting INTEGER NOT NULL DEFAULT 0
  CHECK (signal_ref_waiting IN (0, 1));

-- Expiry alone cannot prove a grounding redrive has stopped. Record the audit
-- revision observed at claim, so only a later outcome witnesses its completion.
ALTER TABLE source_grounding_defer_queue ADD COLUMN claim_started_revision INTEGER;
