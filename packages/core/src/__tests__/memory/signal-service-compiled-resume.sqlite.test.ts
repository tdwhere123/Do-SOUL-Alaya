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
import BetterSqlite3 from "better-sqlite3";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteRunRepo,
  SqliteSignalRepo,
  SqliteWorkspaceRepo,
  StorageDatabase
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
  it("keeps a compiled crash without a materialization witness pending after reopen", async () => {
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
    expect(result.signal.signal_state).toBe("compiled");
    expect(result.triage_result).toBe("deferred");
    expect(result.materialization).toBeNull();
    await expect(harness.signalRepo.getById(signal.signal_id)).resolves.toMatchObject({
      signal_state: "compiled"
    });
    const events = await harness.eventLogRepo.queryByEntity("candidate_memory_signal", signal.signal_id);
    expect(events.some((event) => event.event_type === "soul.signal.materialization_failed")).toBe(false);

    const replay = await createService(harness, materialize).receiveSignal(signal);
    expect(materialize).not.toHaveBeenCalled();
    expect(replay.signal.signal_state).toBe("compiled");
    expect(replay.triage_result).toBe("deferred");
    expect(replay.materialization).toBeNull();
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
      target_kind: "unknown",
      created_objects: [{ object_kind: "memory_entry", object_id: "memory-1" }]
    });
    await expect(harness.signalRepo.getById(signal.signal_id)).resolves.toMatchObject({
      signal_state: "materialized"
    });
  });

  it("resumes compiled rows after reopen through SignalRepo state listing, not same-id receive", async () => {
    const compiled = parsedSignal("compiled");
    const harness = await seedAndReopen(compiled, async (eventLogRepo) => {
      await eventLogRepo.append(buildSignalEmittedEventInput(compiled));
      await eventLogRepo.append({
        event_type: "soul.signal.materialized",
        entity_type: "candidate_memory_signal",
        entity_id: compiled.signal_id,
        workspace_id: compiled.workspace_id,
        run_id: compiled.run_id,
        caused_by: "materialization_router",
        payload_json: {
          signal_id: compiled.signal_id,
          workspace_id: compiled.workspace_id,
          run_id: compiled.run_id,
          created_objects: [{ object_kind: "memory_entry", object_id: "memory-restart" }],
          success: true
        }
      });
    });
    const materialize = vi.fn(async () => {
      throw new Error("restart resume must not rematerialize");
    });
    const results = await createService(harness, materialize).resumeInterruptedMaterialization();

    expect(materialize).not.toHaveBeenCalled();
    expect(results).toEqual([
      expect.objectContaining({
        signal: expect.objectContaining({ signal_id: compiled.signal_id, signal_state: "materialized" }),
        triage_result: "accepted",
        materialization: expect.objectContaining({
          success: true,
          target_kind: "unknown",
          created_objects: [{ object_kind: "memory_entry", object_id: "memory-restart" }]
        })
      })
    ]);
    await expect(harness.signalRepo.getById(compiled.signal_id)).resolves.toMatchObject({
      signal_state: "materialized"
    });
  });

  it("lets only one concurrent triaged resume claim the compiled fence", async () => {
    const signal = parsedSignal("triaged");
    const owner = await seedAndReopen(signal, async (eventLogRepo) => {
      await eventLogRepo.append(buildSignalEmittedEventInput(signal));
      await eventLogRepo.append(acceptedTriageEvent(signal));
    });
    const peer = openPeerHarness(owner.filename);
    const materializeCalls: string[] = [];
    const ownerService = createService(owner, vi.fn(async (candidate: CandidateMemorySignal) => {
      materializeCalls.push("owner");
      return successfulMemory(candidate, "memory-owner");
    }));
    const peerService = createService(peer, vi.fn(async (candidate: CandidateMemorySignal) => {
      materializeCalls.push("peer");
      return successfulMemory(candidate, "memory-peer");
    }));

    const [ownerResult, peerResult] = await Promise.all([
      ownerService.receiveSignal(signal),
      peerService.receiveSignal(signal)
    ]);

    expect(materializeCalls).toHaveLength(1);
    const states = [ownerResult.signal.signal_state, peerResult.signal.signal_state];
    expect(states).toContain("materialized");
    expect(states.every((state) => state === "materialized" || state === "compiled")).toBe(true);
    expect(ownerResult.materialization?.success === false || peerResult.materialization?.success === false).toBe(false);
    await expect(owner.signalRepo.getById(signal.signal_id)).resolves.toMatchObject({
      signal_state: "materialized"
    });
  });

  it("does not invent FAILED while another connection is still materializing", async () => {
    const signal = parsedSignal("triaged");
    const owner = await seedAndReopen(signal, async (eventLogRepo) => {
      await eventLogRepo.append(buildSignalEmittedEventInput(signal));
      await eventLogRepo.append(acceptedTriageEvent(signal));
    });
    const peer = openPeerHarness(owner.filename);
    const started = createGate();
    const release = createGate();
    const ownerService = createService(owner, vi.fn(async (candidate: CandidateMemorySignal) => {
      started.resolve();
      await release.promise;
      return successfulMemory(candidate, "memory-live");
    }));
    const peerMaterialize = vi.fn(async () => {
      throw new Error("peer must not rematerialize a live compiled owner");
    });
    const peerService = createService(peer, peerMaterialize);

    const ownerDone = ownerService.receiveSignal(signal);
    await started.promise;
    const peerResult = await peerService.receiveSignal(signal);
    expect(peerMaterialize).not.toHaveBeenCalled();
    expect(peerResult.signal.signal_state).toBe("compiled");
    expect(peerResult.triage_result).toBe("deferred");
    expect(peerResult.materialization).toBeNull();
    await expect(peer.signalRepo.getById(signal.signal_id)).resolves.toMatchObject({
      signal_state: "compiled"
    });

    release.resolve();
    const ownerResult = await ownerDone;
    expect(ownerResult.signal.signal_state).toBe("materialized");
    expect(ownerResult.materialization).toMatchObject({
      success: true,
      created_objects: [{ object_kind: "memory_entry", object_id: "memory-live" }]
    });
    await expect(owner.signalRepo.getById(signal.signal_id)).resolves.toMatchObject({
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
  readonly filename: string;
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
    filename,
    eventLogRepo: new SqliteEventLogRepo(reopened),
    signalRepo: new SqliteSignalRepo(reopened)
  };
}

function openPeerHarness(filename: string): {
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly signalRepo: SqliteSignalRepo;
} {
  const connection = new BetterSqlite3(filename);
  connection.pragma("foreign_keys = ON");
  connection.pragma("journal_mode = WAL");
  connection.pragma("busy_timeout = 5000");
  connection.pragma("synchronous = NORMAL");
  const peer = new StorageDatabase(filename, connection);
  databases.push(peer);
  return {
    eventLogRepo: new SqliteEventLogRepo(peer),
    signalRepo: new SqliteSignalRepo(peer)
  };
}

function createGate(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((next) => { resolve = next; }), resolve: () => resolve() };
}

function successfulMemory(signal: CandidateMemorySignal, objectId: string) {
  return {
    signal_id: signal.signal_id,
    target_kind: "memory_and_claim" as const,
    routing_reason: "concurrent materialization",
    created_objects: [{ object_kind: "memory_entry", object_id: objectId }],
    success: true as const
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
