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
import { EventPublisher, type EventPublisherEventLogRepoPort } from "../../runtime/event-publisher.js";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteRunRepo,
  SqliteSignalRepo,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { createSignalEmissionWriter } from "../../memory/signal-emission-writer.js";
import { buildSignalEmittedEventInput } from "../../memory/signal-service-helpers.js";
import type { SignalServiceAtomicSignalRepoPort } from "../../memory/signal-service-types.js";
import { createSignal } from "./signal-service.test-support.js";

type Fixture = {
  readonly rows: EventLogEntry[];
  readonly signals: Map<string, CandidateMemorySignal>;
  readonly signalRepo: SignalServiceAtomicSignalRepoPort;
  readonly writer: ReturnType<typeof createSignalEmissionWriter>;
};

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

function createFixture(options: { readonly failApply?: boolean } = {}): Fixture {
  const rows: EventLogEntry[] = [];
  const signals = new Map<string, CandidateMemorySignal>();
  const connection = {};
  let nextEvent = 0;
  const eventRepo: EventPublisherEventLogRepoPort = {
    append(input) {
      const entry: EventLogEntry = {
        ...input,
        event_id: `event-${++nextEvent}`,
        revision: rows.filter(
          (row) => row.entity_type === input.entity_type && row.entity_id === input.entity_id
        ).length,
        created_at: "2026-07-17T00:00:00.000Z"
      };
      rows.push(entry);
      return entry;
    },
    deleteById(eventId) {
      const index = rows.findIndex((row) => row.event_id === eventId);
      if (index >= 0) rows.splice(index, 1);
    },
    transactional<T>(fn: () => T): T {
      const rowsBefore = [...rows];
      const signalsBefore = new Map(signals);
      try {
        return fn();
      } catch (error) {
        rows.splice(0, rows.length, ...rowsBefore);
        signals.clear();
        for (const [id, signal] of signalsBefore) signals.set(id, signal);
        throw error;
      }
    },
    getStorageConnectionIdentity: () => connection
  };
  const signalRepo: SignalServiceAtomicSignalRepoPort = {
    create: async (signal) => signalRepo.createInCurrentTransaction(signal),
    getById: async (signalId) => signals.get(signalId) ?? null,
    listByRun: async () => [],
    updateState: async (signalId, state) => {
      const current = signals.get(signalId);
      if (current === undefined) throw new Error("missing signal");
      const next = { ...current, signal_state: state };
      signals.set(signalId, next);
      return next;
    },
    createInCurrentTransaction: vi.fn((signal) => {
      if (options.failApply === true) throw new Error("signal apply failed");
      if (rows.length !== 1) throw new Error("EventLog must be appended before signal persistence");
      const stored = { ...signal, signal_state: "emitted" as const };
      signals.set(stored.signal_id, stored);
      return stored;
    }),
    getByIdInCurrentTransaction: (signalId) => signals.get(signalId) ?? null,
    getStorageConnectionIdentity: () => connection
  };
  const publisher = new EventPublisher({
    eventLogRepo: eventRepo,
    runHotStateService: { apply: vi.fn() },
    runtimeNotifier: { notify: vi.fn(), notifyEntry: vi.fn() }
  });
  return {
    rows,
    signals,
    signalRepo,
    writer: createSignalEmissionWriter({ eventPublisher: publisher, signalRepo })
  };
}

describe("SignalEmissionWriter", () => {
  it("commits the EventLog envelope before its signal row in one transaction", async () => {
    const fixture = createFixture();
    const signal = CandidateMemorySignalSchema.parse(createSignal());

    const receipt = await fixture.writer.emit(signal, buildSignalEmittedEventInput(signal));

    expect(receipt.emitted_event?.event_id).toBe("event-1");
    expect(receipt.signal.signal_state).toBe("emitted");
    expect(fixture.rows).toHaveLength(1);
    expect(fixture.signals.get(signal.signal_id)).toEqual(receipt.signal);
  });

  it("rolls the EventLog envelope back when signal persistence fails", async () => {
    const fixture = createFixture({ failApply: true });
    const signal = CandidateMemorySignalSchema.parse(createSignal());

    await expect(fixture.writer.emit(signal, buildSignalEmittedEventInput(signal)))
      .rejects.toThrow("signal apply failed");

    expect(fixture.rows).toEqual([]);
    expect(fixture.signals.size).toBe(0);
  });

  it("does not append a second envelope for an exact replay", async () => {
    const fixture = createFixture();
    const signal = CandidateMemorySignalSchema.parse(createSignal());
    await fixture.writer.emit(signal, buildSignalEmittedEventInput(signal));

    const replay = await fixture.writer.emit(signal, buildSignalEmittedEventInput(signal));

    expect(replay.emitted_event).toBeNull();
    expect(fixture.rows).toHaveLength(1);
  });

  it("uses one real SQLite transaction for EventLog and signal persistence", async () => {
    const database = initDatabase({ filename: ":memory:" });
    databases.add(database);
    await new SqliteWorkspaceRepo(database).create({
      workspace_id: "workspace-1",
      name: "signal admission test",
      root_path: "/tmp/signal-admission-test",
      workspace_kind: WorkspaceKind.LOCAL_REPO,
      default_engine_binding: null,
      workspace_state: WorkspaceState.ACTIVE
    });
    await new SqliteRunRepo(database).create({
      run_id: "run-1",
      workspace_id: "workspace-1",
      title: "signal admission test",
      goal: null,
      run_mode: RunMode.CHAT,
      engine_binding_id: null,
      engine_class: null,
      run_state: RunState.IDLE,
      current_surface_id: null
    });
    const eventLogRepo = new SqliteEventLogRepo(database);
    const signalRepo = new SqliteSignalRepo(database);
    const publisher = new EventPublisher({
      eventLogRepo,
      runHotStateService: { apply: vi.fn() },
      runtimeNotifier: { notify: vi.fn(), notifyEntry: vi.fn() }
    });
    const writer = createSignalEmissionWriter({ eventPublisher: publisher, signalRepo });
    const signal = CandidateMemorySignalSchema.parse(createSignal());

    const receipt = await writer.emit(signal, buildSignalEmittedEventInput(signal));

    expect(await signalRepo.getById(signal.signal_id)).toEqual(receipt.signal);
    const events = await eventLogRepo.queryByEntity("candidate_memory_signal", signal.signal_id);
    expect(events).toHaveLength(1);
    expect(events[0]?.event_id).toBe(receipt.emitted_event?.event_id);
  });
});
