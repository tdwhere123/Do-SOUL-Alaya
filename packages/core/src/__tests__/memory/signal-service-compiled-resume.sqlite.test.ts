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
import { createRequire } from "node:module";
import { MaterializationRouter, InMemoryHandoffGapHandler } from "@do-soul/alaya-soul";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteRunRepo,
  SqliteSignalRepo,
  SqliteMemoryEntryRepo,
  SqliteWorkspaceRepo,
  StorageDatabase
} from "@do-soul/alaya-storage";
import { SignalService, type SignalServicePostTriageMaterializer } from "../../memory/signal-service.js";
const NativeDatabase = createRequire(import.meta.url)("better-sqlite3") as new (filename: string) => StorageDatabase["connection"];
import { buildSignalEmittedEventInput } from "../../memory/signal-service-helpers.js";
import { createSignal } from "./signal-service.test-support.js";
import { createMemoryEntry } from "./memory-service-test-fixtures.js";

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
    expect(result.signal.signal_state).toBe("compiled");
    expect(result.triage_result).toBe("deferred");
    expect(result.materialization).toBeNull();
    await expect(harness.signalRepo.getById(signal.signal_id)).resolves.toMatchObject({
      signal_state: "compiled"
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
      await new SqliteMemoryEntryRepo(owner.database).create(createMemoryEntry({ object_id: "00000000-0000-4000-8000-000000000001", evidence_refs: [] }));
      return successfulMemory(candidate, "00000000-0000-4000-8000-000000000001");
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

    let closed = false;
    const closing = ownerService.close().then(() => { closed = true; });
    await expect(ownerService.receiveSignal(signal)).rejects.toThrow("closing");
    expect(closed).toBe(false);
    release.resolve();
    const ownerResult = await ownerDone;
    await closing;
    expect(closed).toBe(true);
    expect(await new SqliteMemoryEntryRepo(owner.database).findById("00000000-0000-4000-8000-000000000001"))
      .toMatchObject({ object_id: "00000000-0000-4000-8000-000000000001" });
    expect(ownerResult.signal.signal_state).toBe("materialized");
    expect(ownerResult.materialization).toMatchObject({
      success: true,
      created_objects: [{ object_kind: "memory_entry", object_id: "00000000-0000-4000-8000-000000000001" }]
    });
    await expect(owner.signalRepo.getById(signal.signal_id)).resolves.toMatchObject({
      signal_state: "materialized"
    });
  });

  it("does not let a stale emitted read overwrite another receiver's compiled fence", async () => {
    const signal = parsedSignal("emitted");
    const h = await seedAndReopen(signal, async events => { await events.append(buildSignalEmittedEventInput(signal)); });
    const peer = openPeerHarness(h.filename);
    const snapshotTaken = createGate(), returnSnapshot = createGate(), materializing = createGate(), release = createGate();
    const originalGet = peer.signalRepo.getById.bind(peer.signalRepo);
    let intercept = true;
    peer.signalRepo.getById = async id => {
      const value = await originalGet(id);
      if (intercept) { intercept = false; snapshotTaken.resolve(); await returnSnapshot.promise; }
      return value;
    };
    const duplicate = vi.fn(async (candidate: CandidateMemorySignal) => successfulMemory(candidate, "duplicate"));
    const peerDone = createService(peer, duplicate).receiveSignal(signal);
    await snapshotTaken.promise;
    const ownerDone = createService(h, vi.fn(async candidate => {
      materializing.resolve(); await release.promise; return successfulMemory(candidate, "owner");
    })).receiveSignal(signal);
    await materializing.promise;
    returnSnapshot.resolve();
    expect(await peerDone).toMatchObject({ signal: { signal_state: "compiled" }, triage_result: "deferred" });
    expect(duplicate).not.toHaveBeenCalled();
    release.resolve();
    expect(await ownerDone).toMatchObject({ signal: { signal_state: "materialized" } });
    const events = await h.eventLogRepo.queryByEntity("candidate_memory_signal", signal.signal_id);
    expect(events.filter(event => event.event_type === "soul.signal.triaged")).toHaveLength(1);
  });

  it("publishes a deferred result only after its state and unambiguous audit commit together", async () => {
    const signal = createSignal({ signal_state: "triaged", object_kind: "scope" });
    const h = await seedAndReopen(signal, async events => { await events.append(buildSignalEmittedEventInput(signal)); });
    const peer = openPeerHarness(h.filename);
    const duplicate = vi.fn(async candidate => successfulMemory(candidate, "duplicate"));
    const rejectEffect = vi.fn(async () => { throw new Error("signal-only must not write objects"); });
    const router = new MaterializationRouter({ evidenceService: { create: rejectEffect },
      memoryService: { create: rejectEffect }, synthesisService: { create: rejectEffect },
      claimService: { create: rejectEffect }, handoffGapHandler: new InMemoryHandoffGapHandler() });
    const observed: string[] = [];
    const service = new SignalService({ eventLogRepo: h.eventLogRepo, signalRepo: h.signalRepo,
      runtimeNotifier: { notifyEntry: async event => {
        if (event.event_type !== "soul.signal.materialized") return;
        observed.push((await peer.signalRepo.getById(signal.signal_id))!.signal_state);
        expect(event.payload_json).toMatchObject({ disposition: "deferred", target_kind: "deferred", success: true });
        expect(await createService(peer, duplicate).receiveSignal(signal)).toMatchObject({
          signal: { signal_state: "deferred" }, triage_result: "deferred"
        });
      } },
      postTriageMaterializer: { materialize: (candidate, context) => router.materializeSignal(candidate, context) }
    });
    expect(await service.receiveSignal(signal)).toMatchObject({ signal: { signal_state: "deferred" } });
    expect(observed).toEqual(["deferred"]);
    expect(duplicate).not.toHaveBeenCalled();
    expect(rejectEffect).not.toHaveBeenCalled();
    expect((await h.signalRepo.getById(signal.signal_id))?.signal_state).toBe("deferred");
  });

  it("rolls back outcome audit when SQLite rejects the paired state transition", async () => {
    const signal = parsedSignal("triaged");
    const h = await seedAndReopen(signal, async events => { await events.append(buildSignalEmittedEventInput(signal)); });
    h.database.connection.exec(`CREATE TRIGGER reject_signal_outcome BEFORE UPDATE OF signal_state ON signals
      WHEN NEW.signal_state='materialized' BEGIN SELECT RAISE(ABORT,'outcome rejected'); END`);
    const service = createService(h, vi.fn(async candidate => {
      await new SqliteMemoryEntryRepo(h.database).create(createMemoryEntry({
        object_id: "00000000-0000-4000-8000-000000000002", evidence_refs: [] }));
      return successfulMemory(candidate, "00000000-0000-4000-8000-000000000002");
    }));
    await expect(service.receiveSignal(signal)).rejects.toThrow();
    expect((await h.signalRepo.getById(signal.signal_id))?.signal_state).toBe("compiled");
    expect((await h.eventLogRepo.queryByEntity("candidate_memory_signal", signal.signal_id))
      .some(event => event.event_type === "soul.signal.materialized")).toBe(false);
    expect(await new SqliteMemoryEntryRepo(h.database).findById("00000000-0000-4000-8000-000000000002"))
      .toMatchObject({ object_id: "00000000-0000-4000-8000-000000000002" });
    expect((await h.eventLogRepo.queryByEntity("candidate_memory_signal", signal.signal_id))
      .some(event => event.event_type === "soul.signal.materialization_failed")).toBe(false);
  });

});

function parsedSignal(state: "compiled" | "triaged" | "emitted"): CandidateMemorySignal {
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
  readonly database: StorageDatabase;
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
  if (signal.signal_state === "triaged") {
    expect(seedSignalRepo.compareAndSwapState({ signalId: signal.signal_id, workspaceId: signal.workspace_id,
      expectedState: "emitted", nextState: "triaged" })).not.toBeNull();
  } else {
    await seedSignalRepo.updateState(signal.signal_id, signal.signal_state);
  }
  await seedEvents(new SqliteEventLogRepo(seeded));
  seeded.close();

  const reopened = initDatabase({ filename });
  databases.push(reopened);
  return {
    filename,
    database: reopened,
    eventLogRepo: new SqliteEventLogRepo(reopened),
    signalRepo: new SqliteSignalRepo(reopened)
  };
}

function openPeerHarness(filename: string): {
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly signalRepo: SqliteSignalRepo;
} {
  const connection = new NativeDatabase(filename);
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
  materialize: SignalServicePostTriageMaterializer["materialize"]
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
