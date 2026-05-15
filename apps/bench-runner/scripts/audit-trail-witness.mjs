#!/usr/bin/env node
// must run after: rtk pnpm --filter @do-soul/alaya-bench-runner build
// @anchor audit-trail-witness — one-off audit-trail witness script.
// Stands up the bench daemon harness, seeds one memory through the real
// MCP propose+review chain, then dumps the full event_log audit trail
// (SOUL_SIGNAL_EMITTED -> SOUL_MEMORY_UPDATED) to stdout so an auditor
// can see each event_id is real and not claimed.

import { initDatabase, SqliteEventLogRepo } from "@do-soul/alaya-storage";
import { join } from "node:path";
import { startBenchDaemon } from "../dist/harness/daemon.js";

const daemon = await startBenchDaemon({
  workspaceId: "audit-witness-ws",
  runId: "audit-witness-run"
});

let seed;
try {
  seed = await daemon.proposeMemory(
    "bench-runner audit-trail witness seed: this is a real propose+review chain trace.",
    "audit-witness-evidence-1"
  );
} finally {
  // We need to read event_log BEFORE shutdown clears the dataDir / closes
  // the daemon's DB cache. initDatabase caches by path so opening here
  // returns the same handle.
}

const db = initDatabase({ filename: join(daemon.dataDir, "alaya.db") });
const repo = new SqliteEventLogRepo(db);

// signal -> memory -> proposal events live on three distinct
// (entity_type, entity_id) pairs in the event_log table:
//   - candidate_memory_signal / signalId  (SOUL_SIGNAL_EMITTED / TRIAGED / MATERIALIZED)
//   - memory_entry / memoryId             (SOUL_MEMORY_CREATED / UPDATED)
//   - proposal / proposalId               (SOUL_PROPOSAL_CREATED, SOUL_REVIEW_*, SOUL_PROPOSAL_RESOLVED)
const signalEvents = await repo.queryByEntity(
  "candidate_memory_signal",
  seed.signalId
);
const memoryEvents = await repo.queryByEntity("memory_entry", seed.memoryId);
const proposalEvents = await repo.queryByEntity("proposal", seed.proposalId);

const ordered = [
  ...signalEvents,
  ...memoryEvents,
  ...proposalEvents
].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));

const witness = {
  signal_id: seed.signalId,
  memory_id: seed.memoryId,
  proposal_id: seed.proposalId,
  data_dir: daemon.dataDir,
  events: ordered.map((event) => ({
    event_id: event.event_id,
    event_type: event.event_type,
    entity_type: event.entity_type,
    entity_id: event.entity_id,
    created_at: event.created_at
  }))
};

process.stdout.write(JSON.stringify(witness, null, 2) + "\n");

await daemon.shutdown();
