import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CandidateMemorySignalSchema,
  RunMode,
  RunState,
  WorkspaceKind,
  WorkspaceState,
  type CandidateMemorySignal,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteRunRepo,
  SqliteSignalRepo,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { SignalService } from "../../memory/signal-service.js";
import { buildSignalEmittedEventInput } from "../../memory/signal-service-helpers.js";
import { createSignal } from "./signal-service.test-support.js";

const directories: string[] = [];
const databases: StorageDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    if (!database.isClosed()) database.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SignalService compiled resume through SQLite restart", () => {
  it("collects a compiled crash before materializer effects as failed after reopen", async () => {
    const signal = parsedSignal("compiled");
    const harness = await seedAndReopen(signal, async (eventLogRepo) => {
      await eventLogRepo.append(buildSignalEmittedEventInput(signal));
      await eventLogRepo.append(acceptedTriageEvent(signal));
    });
    const materialize = vi.fn(async () => {
      throw new Error("compiled crash must not rematerialize");
    });
    const service = createService(harness, materialize);

    const result = await service.receiveSignal(signal);

    expect(materialize).not.toHaveBeenCalled();
    expect(result.signal.signal_state).toBe("failed");
    expect(result.triage_result).toBe("accepted");
    expect(result.materialization).toMatchObject({
      success: false,
      created_objects: []
    });
    await expect(harness.signalRepo.getById(signal.signal_id)).resolves.toMatchObject({
      signal_state: "failed"
    });
    const events = await harness.eventLogRepo.queryByEntity("candidate_memory_signal", signal.signal_id);
    expect(events.some((event) => event.event_type === "soul.signal.materialization_failed")).toBe(true);

    const replay = await createService(harness, materialize).receiveSignal(signal);
    expect(materialize).not.toHaveBeenCalled();
    expect(replay.signal.signal_state).toBe("failed");
    expect(replay.materialization).toMatchObject({ success: false });
    expect(replay.materialization).not.toBeNull();
  });

  it("rematerializes a triaged signal after reopen when the materializer has not started", async () => {
    const signal = parsedSignal("triaged");
    const harness = await seedAndReopen(signal, async (eventLogRepo) => {
      await eventLogRepo.append(buildSignalEmittedEventInput(signal));
      await eventLogRepo.append(acceptedTriageEvent(signal));
    });
    const materialize = vi.fn(async (candidate: CandidateMemorySignal) => ({
      signal_id: candidate.signal_id,
      target_kind: "memory_and_claim" as const,
      routing_reason: "resume before compiled fence",
      created_objects: [{ object_kind: "memory_entry", object_id: "memory-1" }],
      success: true as const
    }));
    const result = await createService(harness, materialize).receiveSignal(signal);

    expect(materialize).toHaveBeenCalledTimes(1);
    expect(result.signal.signal_state).toBe("materialized");
    expect(result.materialization).toMatchObject({
      success: true,
      created_objects: [{ object_kind: "memory_entry", object_id: "memory-1" }]
    });
    await expect(harness.signalRepo.getById(signal.signal_id)).resolves.toMatchObject({
      signal_state: "materialized"
    });
  });

  it("does not rematerialize a compiled signal that already created objects", async () => {
    const signal = parsedSignal("compiled");
    const harness = await seedAndReopen(signal, async (eventLogRepo) => {
      await eventLogRepo.append(buildSignalEmittedEventInput(signal));
      await eventLogRepo.append({
        event_type: "soul.signal.materialized",
        entity_type: "candidate_memory_signal",
        entity_id: signal.signal_id,
        workspace_id: signal.workspace_id,
        run_id: signal.run_id,
        caused_by: "materialization_router",
        payload_json: {
          signal_id: signal.signal_id,
          workspace_id: signal.workspace_id,
          run_id: signal.run_id,
          created_objects: [{ object_kind: "memory_entry", object_id: "memory-1" }],
          success: true
        }
      });
    });
    const materialize = vi.fn(async () => {
      throw new Error("partial materialization must not be replayed");
    });
    const result = await createService(harness, materialize).receiveSignal(signal);

    expect(materialize).not.toHaveBeenCalled();
    expect(result.signal.signal_state).toBe("materialized");
    expect(result.materialization).toMatchObject({
      success: true,
      created_objects: [{ object_kind: "memory_entry", object_id: "memory-1" }]
    });
    await expect(harness.signalRepo.getById(signal.signal_id)).resolves.toMatchObject({
      signal_state: "materialized"
    });
  });
});

function parsedSignal(state: "compiled" | "triaged"): CandidateMemorySignal {
  return CandidateMemorySignalSchema.parse(createSignal({ signal_id: "signal-compiled-1", signal_state: state }));
}

function acceptedTriageEvent(signal: CandidateMemorySignal): Omit<EventLogEntry, "event_id" | "created_at" | "revision"> {
  return {
    event_type: "soul.signal.triaged",
    entity_type: "candidate_memory_signal",
    entity_id: signal.signal_id,
    workspace_id: signal.workspace_id,
    run_id: signal.run_id,
    caused_by: "deterministic_rule",
    payload_json: {
      signal_id: signal.signal_id,
      workspace_id: signal.workspace_id,
      run_id: signal.run_id,
      triage_result: "accepted"
    }
  };
}

async function seedAndReopen(
  signal: CandidateMemorySignal,
  seedEvents: (eventLogRepo: SqliteEventLogRepo) => Promise<void>
): Promise<{
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly signalRepo: SqliteSignalRepo;
}> {
  const directory = mkdtempSync(join(tmpdir(), "alaya-signal-compiled-"));
  directories.push(directory);
  const filename = join(directory, "alaya.db");
  const seeded = initDatabase({ filename });
  await new SqliteWorkspaceRepo(seeded).create({
    workspace_id: "workspace-1",
    name: "compiled resume",
    root_path: "/tmp/compiled-resume",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await new SqliteRunRepo(seeded).create({
    run_id: "run-1",
    workspace_id: "workspace-1",
    title: "compiled resume",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
  const seedSignalRepo = new SqliteSignalRepo(seeded);
  await seedSignalRepo.create(signal);
  await seedSignalRepo.updateState(signal.signal_id, signal.signal_state);
  await seedEvents(new SqliteEventLogRepo(seeded));
  seeded.close();

  const reopened = initDatabase({ filename });
  databases.push(reopened);
  return {
    eventLogRepo: new SqliteEventLogRepo(reopened),
    signalRepo: new SqliteSignalRepo(reopened)
  };
}

function createService(
  harness: {
    readonly eventLogRepo: SqliteEventLogRepo;
    readonly signalRepo: SqliteSignalRepo;
  },
  materialize: ReturnType<typeof vi.fn>
): SignalService {
  return new SignalService({
    eventLogRepo: harness.eventLogRepo,
    signalRepo: harness.signalRepo,
    runtimeNotifier: { notifyEntry: vi.fn(async () => {}) },
    postTriageMaterializer: {
      materialize: async (candidate, context) => await materialize(candidate, context)
    }
  });
}
