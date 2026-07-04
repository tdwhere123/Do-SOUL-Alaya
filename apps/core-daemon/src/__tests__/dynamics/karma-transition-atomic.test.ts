import { afterEach, describe, expect, it, vi } from "vitest";

import { DynamicsService, EventPublisher, type RuntimeNotifier } from "@do-soul/alaya-core";
import {
  FormationKind,
  MemoryDimension,
  ScopeClass,
  SourceKind,
  StorageTier,
  type KarmaEvent,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteKarmaEventRepo,
  SqliteMemoryEntryRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";

const databases = new Set<StorageDatabase>();
const MEMORY_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SEEDED_AT = "2026-07-01T00:00:00.000Z";
const NOW = "2026-07-04T00:00:00.000Z";

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

function createHarness() {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const karmaEventRepo = new SqliteKarmaEventRepo(database);
  const memoryEntryRepo = new SqliteMemoryEntryRepo(database);
  const notifyEntry = vi.fn(() => {});
  const runtimeNotifier: RuntimeNotifier = { notify: () => {}, notifyEntry };
  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runHotStateService: { apply: () => {} },
    runtimeNotifier
  });
  const dynamicsService = new DynamicsService({
    now: () => NOW,
    memoryRepo: memoryEntryRepo,
    karmaEventRepo,
    eventLogRepo,
    runtimeNotifier,
    eventPublisher
  });
  return { eventLogRepo, karmaEventRepo, memoryEntryRepo, notifyEntry, dynamicsService };
}

function createDormantMemoryEntry(): MemoryEntry {
  return {
    object_id: MEMORY_ID,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "dormant",
    created_at: SEEDED_AT,
    updated_at: SEEDED_AT,
    created_by: "karma-atomic-test",
    dimension: MemoryDimension.FACT,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: "dormant memory awaiting reinforcement",
    domain_tags: ["workflow"],
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: StorageTier.COLD,
    activation_score: 0.2,
    retention_score: 0.2,
    manifestation_state: "hint",
    retention_state: "working",
    decay_profile: "normal",
    confidence: 0.9,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 0,
    contradiction_count: 0,
    superseded_by: null
  };
}

function createKarmaEvent(): KarmaEvent {
  return {
    event_id: "karma-atomic-1",
    kind: "accept_gain",
    object_id: MEMORY_ID,
    amount: 0.15,
    created_at: NOW,
    workspace_id: "workspace-1",
    run_id: "run-1"
  };
}

describe("karma transition single-transaction atomicity (§7 + §31)", () => {
  it("commits the karma event, dynamics update, revival, and audit rows together", async () => {
    const harness = createHarness();
    await harness.memoryEntryRepo.create(createDormantMemoryEntry());

    await harness.dynamicsService.processKarmaEvent(createKarmaEvent());

    const memory = await harness.memoryEntryRepo.findById(MEMORY_ID);
    expect(memory?.lifecycle_state).toBe("active");
    // baseline create-then-sum parity: 0.9 * 2^(-3d/30d) + 0.15 own amount = 0.98973...
    expect(memory?.retention_score).toBeCloseTo(0.9897296923831267, 10);

    const karmaEvents = await harness.karmaEventRepo.findByObjectId(MEMORY_ID);
    expect(karmaEvents).toHaveLength(1);

    const auditRows = await harness.eventLogRepo.queryByEntity("memory_entry", MEMORY_ID);
    expect(auditRows.length).toBeGreaterThan(0);

    expect(harness.notifyEntry.mock.calls.length).toBe(auditRows.length);
  });

  it("rolls back the karma event and dynamics update when an audit append fails (no half-commit)", async () => {
    const harness = createHarness();
    const seed = createDormantMemoryEntry();
    await harness.memoryEntryRepo.create(seed);

    vi.spyOn(harness.eventLogRepo, "append").mockImplementation(() => {
      throw new Error("eventLogRepo.append boom");
    });

    await expect(harness.dynamicsService.processKarmaEvent(createKarmaEvent())).rejects.toThrow(
      /boom/
    );

    // The whole SQLite transaction rolled back: the dormant entry stays dormant
    // with its seeded dynamics, so no subscriber can observe a half-commit.
    const memory = await harness.memoryEntryRepo.findById(MEMORY_ID);
    expect(memory?.lifecycle_state).toBe("dormant");
    expect(memory?.activation_score).toBe(seed.activation_score);
    expect(memory?.retention_score).toBe(seed.retention_score);
    expect(memory?.manifestation_state).toBe(seed.manifestation_state);
    expect(memory?.retention_state).toBe(seed.retention_state);
    expect(memory?.updated_at).toBe(SEEDED_AT);

    const karmaEvents = await harness.karmaEventRepo.findByObjectId(MEMORY_ID);
    expect(karmaEvents).toHaveLength(0);

    const auditRows = await harness.eventLogRepo.queryByEntity("memory_entry", MEMORY_ID);
    expect(auditRows).toHaveLength(0);

    expect(harness.notifyEntry).not.toHaveBeenCalled();
  });
});
