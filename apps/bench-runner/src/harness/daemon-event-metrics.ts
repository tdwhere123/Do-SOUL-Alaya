import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { EdgeProposalKpiEventRow } from "@do-soul/alaya-eval";
import {
  GraphAuditorEventType,
  RecallContextEventType,
  SignalEventType,
  SoulContextLensAssembledPayloadSchema,
  SoulSignalMaterializedPayloadSchema
} from "@do-soul/alaya-protocol";
import { initDatabase, SqliteEventLogRepo } from "@do-soul/alaya-storage";
import { deriveBenchTokenMetrics } from "./token-economy.js";
import type { BenchTokenMetrics } from "./daemon-types.js";

export async function readMaterializedObjects(
  dataDir: string,
  signalId: string
): Promise<{ readonly memoryId: string; readonly evidenceId: string | null }> {
  const db = initDatabase({ filename: join(dataDir, "alaya.db") });
  const eventLogRepo = new SqliteEventLogRepo(db);
  const events = await eventLogRepo.queryByEntity("candidate_memory_signal", signalId);
  let memoryId: string | null = null;
  let evidenceId: string | null = null;
  for (const event of events) {
    if (event.event_type !== SignalEventType.SOUL_SIGNAL_MATERIALIZED) {
      continue;
    }
    const payload = SoulSignalMaterializedPayloadSchema.parse(event.payload_json);
    for (const obj of payload.created_objects) {
      if (obj.object_kind === "memory_entry" && memoryId === null) {
        memoryId = obj.object_id;
      }
      if (obj.object_kind === "evidence_capsule" && evidenceId === null) {
        evidenceId = obj.object_id;
      }
    }
  }
  if (memoryId === null) {
    throw new Error(
      `Signal ${signalId} did not materialize a memory_entry — check signal_kind / confidence / evidence_refs routing.`
    );
  }
  return { memoryId, evidenceId };
}

// @anchor emitBenchContextLensAssembledEvent: append a
// SOUL_CONTEXT_LENS_ASSEMBLED event from the bench recall path so the
// token-economy KPI stays event-sourced. The bench recall path drives
// recallService directly and skips ContextLensAssembler (which is the
// production emitter of this event), so without this the EventLog carries
// no recalled-context token figure. The payload is built through the
// protocol's own SoulContextLensAssembledPayloadSchema — the same schema
// the production assembler writes, so the event is schema-faithful.
// initDatabase caches the connection by path
// (the same handle the daemon holds); the connection is NOT closed here.
export function emitBenchContextLensAssembledEvent(
  dataDir: string,
  input: {
    readonly taskSurfaceRef: string;
    readonly lensEntryCount: number;
    readonly totalTokenEstimate: number;
    readonly runId: string;
    readonly workspaceId: string;
  }
): void {
  const db = initDatabase({ filename: join(dataDir, "alaya.db") });
  const eventLogRepo = new SqliteEventLogRepo(db);
  const lensRuntimeId = `bench_lens_${randomUUID().replace(/-/gu, "")}`;
  eventLogRepo.append({
    event_type: RecallContextEventType.SOUL_CONTEXT_LENS_ASSEMBLED,
    entity_type: "context_lens",
    entity_id: lensRuntimeId,
    workspace_id: input.workspaceId,
    run_id: input.runId,
    caused_by: "bench-runner",
    payload_json: SoulContextLensAssembledPayloadSchema.parse({
      runtime_id: lensRuntimeId,
      task_surface_ref: input.taskSurfaceRef,
      lens_entry_count: input.lensEntryCount,
      total_token_estimate: input.totalTokenEstimate,
      run_id: input.runId,
      workspace_id: input.workspaceId,
      occurred_at: new Date().toISOString()
    })
  });
}

// @anchor queryTokenMetrics: event-sourced token-economy reader. Mirrors
// readMaterializedMemoryId — opens the bench DB via the cached connection
// and reads EventLog rows, never in-memory bench state. SOUL_SIGNAL_EMITTED
// rows now carry only a redacted raw_payload summary (hash + bench numeric
// token counts), so the fold derives token economy without re-exposing the
// seeded text through EventLog. The pure event -> metrics fold lives in
// harness/token-economy.ts deriveBenchTokenMetrics so it is unit-testable
// against a stubbed EventLog. The connection is NOT closed here.
// invariant: scope the event read to the question's workspace. The bench
// daemon-per-run model shares ONE alaya.db across every attached workspace,
// so an unscoped queryByType returns every prior question's events too —
// turning each per-question fold into an O(all-prior-questions) scan AND
// double-counting every earlier question into this question's token metrics
// (the run-level aggregateBenchTokenMetrics then SUMS those cumulative
// snapshots). queryByWorkspaceAndType uses idx_event_log_workspace_type_created
// so the read stays bounded to this workspace's own emitted/lens events.
// see also: packages/storage/src/repos/runtime/event-log-repo.ts queryByWorkspaceAndType
export async function queryTokenMetrics(
  dataDir: string,
  workspaceId: string
): Promise<BenchTokenMetrics> {
  const db = initDatabase({ filename: join(dataDir, "alaya.db") });
  const eventLogRepo = new SqliteEventLogRepo(db);
  const emittedEvents = await eventLogRepo.queryByWorkspaceAndType(
    workspaceId,
    SignalEventType.SOUL_SIGNAL_EMITTED
  );
  const lensEvents = await eventLogRepo.queryByWorkspaceAndType(
    workspaceId,
    RecallContextEventType.SOUL_CONTEXT_LENS_ASSEMBLED
  );
  return deriveBenchTokenMetrics(emittedEvents, lensEvents);
}

// @anchor queryEdgeProposalKpiRows: event-sourced edge proposal KPI reader.
// Same shape as queryTokenMetrics — opens the bench DB and reads the two
// proposal event types, returning the minimal structural row shape the
// aggregator in @do-soul/alaya-eval consumes. The aggregator is pure so it
// stays unit-testable without standing up storage.
// see also: packages/eval/src/metrics/edge-proposal-kpi.ts
// invariant: scope to the question's workspace, for the same reason
// queryTokenMetrics does — the shared daemon-per-run DB would otherwise
// re-deliver every prior question's edge-proposal events on each call,
// duplicating them into edgeProposalKpiRowsAcrossQuestions and growing the
// scan with the question index.
export async function queryEdgeProposalKpiRows(
  dataDir: string,
  workspaceId: string
): Promise<readonly EdgeProposalKpiEventRow[]> {
  const db = initDatabase({ filename: join(dataDir, "alaya.db") });
  const eventLogRepo = new SqliteEventLogRepo(db);
  const createdEvents = await eventLogRepo.queryByWorkspaceAndType(
    workspaceId,
    GraphAuditorEventType.SOUL_GRAPH_EDGE_PROPOSAL_CREATED
  );
  const reviewedEvents = await eventLogRepo.queryByWorkspaceAndType(
    workspaceId,
    GraphAuditorEventType.SOUL_GRAPH_EDGE_PROPOSAL_REVIEWED
  );
  const rows: EdgeProposalKpiEventRow[] = [];
  for (const event of createdEvents) {
    rows.push({
      event_type: event.event_type,
      workspace_id: event.workspace_id,
      created_at: event.created_at,
      payload_json: event.payload_json
    });
  }
  for (const event of reviewedEvents) {
    rows.push({
      event_type: event.event_type,
      workspace_id: event.workspace_id,
      created_at: event.created_at,
      payload_json: event.payload_json
    });
  }
  return rows;
}

// @anchor BENCH_FAST_PRAGMA: bench-only SQLite tuning layered on top of the
// production storage hardening (packages/storage/src/sqlite/db.ts already sets
// journal_mode=WAL + synchronous=NORMAL + foreign_keys + busy_timeout). The
// bench harness adds two pragmas that production deliberately leaves at
// default because they change the durability vs throughput tradeoff:
//
//   temp_store=FILE         — FTS/sort/GROUP BY temp B-trees spill to disk.
//                             temp_store=MEMORY forces them into RAM that is
//                             off the Node heap and so invisible to
//                             --max-old-space-size; over a long single-process
//                             500-question run that RAM climbs monotonically
//                             and feeds the OS OOM-killer (a silent SIGKILL,
//                             not a recoverable Node OOM). FILE trades latency
//                             for headroom and is the safe default for full
//                             runs. Override with ALAYA_BENCH_TEMP_STORE=memory
//                             for short throughput-bound runs that fit in RAM.
//   cache_size=-65536       — 64 MiB page cache (negative = KiB). Default is
//                             ~2 MiB which is too small for the bench
//                             hot-set; production leaves it small for
//                             desktop multi-process coexistence.
//
// Gated by ALAYA_BENCH_FAST_PRAGMA env (default: ON for bench harness; set
// "0"/"false" to opt out). Production `apps/core-daemon` does not call this
// helper, so no production runtime is affected.
//
// invariant: EventLog rows are still appended via the same SqliteEventLogRepo
// path; only the SQLite write batching/fsync timing changes. WAL still
// guarantees atomic per-statement commit; synchronous=NORMAL guarantees
// system-crash recovery on the WAL frame boundary (only power-loss within
// the last few ms of WAL flush is at risk, which bench fixtures can replay).
