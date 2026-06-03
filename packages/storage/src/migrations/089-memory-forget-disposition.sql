-- invariant: durable forgetting-disposition marker for autonomous terminal
-- removal. NULL = no disposition (never autonomously tombstoned or hard-deleted).
-- forget_disposition is set ONLY by an audited dormant->tombstoned transition.
--   'compressed'     -> forget_disposition_ref = the live synthesis_capsule id
--                       whose source_memory_refs references this memory.
--   'judged_useless' -> forget_disposition_ref stays NULL.
-- The autonomous-tombstone step and the physical-delete authority both gate on
-- forget_disposition IS NOT NULL (defense in depth). Human Inspector retire
-- leaves both columns NULL and is not auto-GC'd.
-- see also: packages/protocol/src/soul/memory-entry.ts ForgetDisposition,
-- packages/storage/src/repos/memory-entry-repo.ts hardDeleteTombstoned.
ALTER TABLE memory_entries
  ADD COLUMN forget_disposition TEXT;

ALTER TABLE memory_entries
  ADD COLUMN forget_disposition_ref TEXT;
