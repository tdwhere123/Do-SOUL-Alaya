import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GovernanceResolutionEventType,
  GovernanceResolutionPayloadSchema,
  MemoryGovernanceEventType,
  SlotEventType,
  SoulMemoryStateChangedPayloadSchema,
  SoulSlotWinnerChangedPayloadSchema,
  WorkerMessageDeltaPayloadSchema,
  WorkerPermissionRequestedPayloadSchema,
  WorkerRuntimeEventType,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import {
  configureSqliteWriteQueuePort,
  createWorkerThreadSqliteWriteQueuePort,
  resolveSqliteWriteQueueWorkerUrl
} from "../../../sqlite/index.js";
import { getEventLogWriter, insertEventLogEntry } from "../../../repos/runtime/writes/event-log-writer.js";
import { createEventLogRepos, trackedDatabases } from "./event-log-repo-fixture.js";

type AppendInput = Omit<EventLogEntry, "event_id" | "revision" | "created_at">;
const timestamp = "2026-10-19T00:00:00.000Z";
const modes = ["repository", "writer", "worker"] as const;

const roots: string[] = [];
let queue: ReturnType<typeof createWorkerThreadSqliteWriteQueuePort> | undefined;

afterEach(async () => {
  configureSqliteWriteQueuePort(null);
  await queue?.close?.();
  queue = undefined;
  for (const database of trackedDatabases) database.close();
  trackedDatabases.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function openBoundary(mode: typeof modes[number]) {
  const root = mkdtempSync(join(tmpdir(), "alaya-audit-budget-"));
  roots.push(root);
  const repos = await createEventLogRepos({ filename: join(root, "audit.db") });
  if (mode === "worker") {
    const workerUrl = resolveSqliteWriteQueueWorkerUrl();
    expect(workerUrl).not.toBeNull();
    queue = createWorkerThreadSqliteWriteQueuePort({ workerUrl: workerUrl! });
    configureSqliteWriteQueuePort(queue);
  }
  const writer = getEventLogWriter(repos.database.connection);
  return {
    ...repos,
    append: (event: AppendInput) => mode === "writer"
      ? repos.database.connection.transaction(() => insertEventLogEntry(writer, event)).immediate()
      : repos.eventLogRepo.append(event)
  };
}

function draft(eventType: EventLogEntry["event_type"], payload: Record<string, unknown>): AppendInput {
  return {
    event_type: eventType,
    entity_type: "worker_run",
    entity_id: "worker-1",
    workspace_id: "ws_events",
    run_id: "run_order",
    caused_by: "system",
    payload_json: payload
  };
}

describe.each(modes)("EventLog payload budget through %s", (mode) => {
  it("persists and reopens maximum escaped content and composed reasons losslessly", async () => {
    const { append, database, eventLogRepo } = await openBoundary(mode);
    const payloads: AppendInput[] = [
      draft(WorkerRuntimeEventType.WORKER_MESSAGE_DELTA, WorkerMessageDeltaPayloadSchema.parse({
        sessionId: "\u0000".repeat(256), workerRunId: "\u0000".repeat(256), emittedAt: timestamp,
        delta: "\u0000".repeat(65_536), sequence: 0
      })),
      draft(WorkerRuntimeEventType.WORKER_PERMISSION_REQUESTED, WorkerPermissionRequestedPayloadSchema.parse({
        sessionId: "session-1", emittedAt: timestamp, requestId: "request-1", toolId: "tool-1",
        reason: "\u0000".repeat(16_384)
      })),
      draft(GovernanceResolutionEventType.SOUL_RESOLUTION_CORRECT_APPLIED, GovernanceResolutionPayloadSchema.parse({
        target_object_id: "claim-1", resolution: "correct", workspace_id: "ws_events", run_id: "run_order",
        agent_target: "agent-1", delivery_id: "delivery-1", policy: null, policy_classification: null,
        reason: "\u0000".repeat(16_384), correction: "\u0000".repeat(16_384), obligation_id: null,
        activated_claim_id: null, occurred_at: timestamp
      })),
      draft(MemoryGovernanceEventType.SOUL_MEMORY_STATE_CHANGED, SoulMemoryStateChangedPayloadSchema.parse({
        object_id: "memory-1", object_kind: "memory", workspace_id: "ws_events", run_id: null,
        from_state: "active", to_state: "archived", reason_code: "\u0000".repeat(65_536), caused_by: "system",
        evidence_refs: null, occurred_at: timestamp
      }))
    ];
    for (const event of payloads) await append(event);
    database.close();
    const stored = await eventLogRepo.queryByEntityAll("worker_run", "worker-1");
    expect(stored.map(({ payload_json }) => payload_json)).toEqual(payloads.map(({ payload_json }) => payload_json));
  });

  it("refuses a schema-valid but oversized aggregate without appending or consuming a revision", async () => {
    const { append, database, eventLogRepo } = await openBoundary(mode);
    // This array has no per-event cardinality cap; field validity alone cannot
    // promise persistence under any finite aggregate budget.
    const payload = SoulSlotWinnerChangedPayloadSchema.parse({
      object_id: "slot-1", object_kind: "slot", workspace_id: "ws_events", run_id: null,
      from_claim_id: null, to_claim_id: "claim-1", reason_code: "election", caused_by: "system",
      evidence_refs: Array.from({ length: 6_000 }, () => "\u0000".repeat(256)), occurred_at: timestamp
    });
    const oversized = draft(SlotEventType.SOUL_SLOT_WINNER_CHANGED, payload);
    await expect(Promise.resolve().then(() => append(oversized)))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(() => eventLogRepo.transactional(() => {
      const first = append(draft(WorkerRuntimeEventType.WORKER_SESSION_STARTED, {
        sessionId: "session-1", emittedAt: timestamp
      }));
      expect(first).not.toBeInstanceOf(Promise);
      database.connection.prepare("UPDATE workspaces SET name = 'changed' WHERE workspace_id = 'ws_events'").run();
      append(oversized);
    })).toThrow("Failed to validate event log entry.");
    expect(database.connection.prepare("SELECT name FROM workspaces WHERE workspace_id = 'ws_events'").get())
      .toEqual({ name: "events" });
    expect(await eventLogRepo.queryByEntityAll("worker_run", "worker-1")).toEqual([]);
    const next = await append(draft(WorkerRuntimeEventType.WORKER_SESSION_STARTED, {
      sessionId: "session-1", emittedAt: timestamp
    }));
    expect(next.revision).toBe(0);
  });
});
