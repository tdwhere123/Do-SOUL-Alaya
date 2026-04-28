import { afterEach, describe, expect, it, vi } from "vitest";
import { GardenTaskKind, HealthEventKind, type PathGraphSnapshot, type PathRelation } from "@do-what/protocol";
import type { StorageDatabase } from "@do-what/storage";

const hoisted = vi.hoisted(() => ({
  backgroundManagers: [] as Array<{
    readonly services: readonly {
      readonly name: string;
      readonly intervalMs: number;
      readonly task: () => Promise<void>;
    }[];
  }>,
  database: null as StorageDatabase | null,
  sseBroadcastEntry: vi.fn(async () => undefined),
  schedulerCompletions: [] as unknown[]
}));

vi.mock("@hono/node-server", () => ({
  serve: vi.fn(() => ({ close: vi.fn() }))
}));

vi.mock("../background/bootstrap.js", () => ({
  BackgroundServiceManager: vi.fn().mockImplementation(function BackgroundServiceManager(services) {
    const manager = {
      services,
      start: vi.fn(),
      stop: vi.fn()
    };
    hoisted.backgroundManagers.push(manager);
    return manager;
  })
}));

vi.mock("../app.js", () => ({
  createApp: vi.fn(() => ({ fetch: vi.fn() }))
}));

vi.mock("../files-data-dir.js", () => ({
  resolveCoreDaemonFilesDirectory: vi.fn(() => "/tmp/do-what-files")
}));

vi.mock("../services/config-service.js", () => ({
  createConfigService: vi.fn(() => ({}))
}));

vi.mock("../services/environment-status-service.js", () => ({
  createEnvironmentStatusService: vi.fn(() => ({
    getStatus: vi.fn(async () => ({
      tools: {
        git: true,
        node: true,
        pnpm: true,
        rg: true,
        claude: true,
        bwrap: true,
        socat: true
      },
      active_worktrees: 0,
      db_path: ":memory:",
      files_dir: "/tmp/do-what-files"
    }))
  }))
}));

vi.mock("../services/soul-approval-service.js", () => ({
  createSoulApprovalService: vi.fn(() => ({}))
}));

vi.mock("../sse/sse-manager.js", () => ({
  SseManager: vi.fn().mockImplementation(function SseManager() {
    return {
      broadcast: vi.fn(async () => undefined),
      broadcastEntry: hoisted.sseBroadcastEntry
    };
  })
}));

vi.mock("@do-what/storage", async () => {
  const actual = await vi.importActual<typeof import("@do-what/storage")>("@do-what/storage");

  return {
    ...actual,
    initDatabase: vi.fn(() => {
      if (hoisted.database === null) {
        hoisted.database = actual.initDatabase({ filename: ":memory:" });
      }

      return hoisted.database;
    })
  };
});

vi.mock("@do-what/soul", async () => {
  const actual = await vi.importActual<typeof import("@do-what/soul")>("@do-what/soul");

  class DeterministicGardenScheduler {
    private readonly queue: unknown[] = [];

    public constructor() {}

    public enqueue(task: unknown): void {
      this.queue.push(task);
    }

    public async dispatchNext(role: string): Promise<unknown | null> {
      const index = this.queue.findIndex((candidate) => {
        const task = candidate as { readonly task_kind: string };
        return resolveGardenRole(task.task_kind) === role;
      });

      if (index === -1) {
        return null;
      }

      return this.queue.splice(index, 1)[0] ?? null;
    }

    public async reportCompletion(result: unknown): Promise<void> {
      hoisted.schedulerCompletions.push(result);
    }

    public getBacklogSnapshot() {
      return {
        workspace_id: null,
        observed_at: "2026-04-23T08:00:00.000Z",
        queue_depth_total: this.queue.length,
        queue_depth_by_tier: {
          tier_0: 0,
          tier_1: 0,
          tier_2: 0
        },
        in_flight_total: 0,
        warning_active: false
      } as const;
    }

    public peekBacklogWarningTransition(): null {
      return null;
    }

    public peekLastBacklogWarningTransitionId(): null {
      return null;
    }

    public acknowledgeBacklogWarningTransition(): false {
      return false;
    }

    public get queueDepth(): number {
      return this.queue.length;
    }
  }

  return {
    ...actual,
    GardenScheduler: DeterministicGardenScheduler
  };
});

describe("path graph snapshot runtime wiring", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    hoisted.backgroundManagers.length = 0;
    hoisted.schedulerCompletions.length = 0;
    hoisted.database?.close();
    hoisted.database = null;
    hoisted.sseBroadcastEntry.mockClear();
  });

  it("persists and reviews the freshly created snapshot through the live daemon chain", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-17T00:15:00.000Z"));

    await import("../index.js");

    const storage = await import("@do-what/storage");
    const database = hoisted.database;
    if (database === null) {
      throw new Error("expected in-memory database");
    }

    const workspaceRepo = new storage.SqliteWorkspaceRepo(database);
    const pathRelationRepo = new storage.SqlitePathRelationRepo(database);
    const snapshotRepo = new storage.SqlitePathGraphSnapshotRepo(database);
    const eventLogRepo = new storage.SqliteEventLogRepo(database);
    const healthJournalRepo = new storage.SqliteHealthJournalRepo(database);

    await workspaceRepo.create({
      workspace_id: "workspace-1",
      name: "Workspace 1",
      root_path: "/tmp/workspace-1",
      workspace_kind: "local_repo",
      default_engine_binding: null,
      default_engine_class: "conversation_engine",
      workspace_state: "active"
    });

    await snapshotRepo.create(
      createSnapshotFixture({
        snapshot_id: "snapshot-previous",
        total_active_paths: 1,
        connectivity: {
          unique_source_anchors: 1,
          unique_target_anchors: 1,
          max_out_degree: 1,
          max_in_degree: 1,
          isolated_anchors: 1
        },
        snapshot_at: "2026-04-17T00:00:00.000Z"
      })
    );
    await snapshotRepo.create(
      createSnapshotFixture({
        snapshot_id: "snapshot-expired",
        total_active_paths: 9,
        snapshot_at: "2026-03-10T00:00:00.000Z"
      })
    );

    await pathRelationRepo.create(
      createPathRelationFixture({
        path_id: "path-1",
        anchors: {
          source_anchor: { kind: "object", object_id: "anchor-a" },
          target_anchor: { kind: "object", object_id: "anchor-b" }
        },
        created_at: "2026-04-17T00:05:00.000Z",
        updated_at: "2026-04-17T00:05:00.000Z",
        plasticity_state: {
          strength: 0.3,
          direction_bias: "source_to_target",
          stability_class: "volatile",
          support_events_count: 1,
          contradiction_events_count: 0,
          last_reinforced_at: "2026-04-17T00:05:00.000Z"
        }
      })
    );
    await pathRelationRepo.create(
      createPathRelationFixture({
        path_id: "path-2",
        anchors: {
          source_anchor: { kind: "object", object_id: "anchor-c" },
          target_anchor: { kind: "object", object_id: "anchor-d" }
        },
        created_at: "2026-04-17T00:06:00.000Z",
        updated_at: "2026-04-17T00:06:00.000Z",
        plasticity_state: {
          strength: 0.7,
          direction_bias: "source_to_target",
          stability_class: "normal",
          support_events_count: 2,
          contradiction_events_count: 0,
          last_reinforced_at: "2026-04-17T00:06:00.000Z"
        },
        legitimacy: {
          evidence_basis: ["evidence-2"],
          governance_class: "attention_only"
        }
      })
    );

    const services = hoisted.backgroundManagers[0]?.services;
    expect(services).toBeDefined();

    const librarianService = services?.find((service) => service.name === "Librarian");
    const gardenSchedulerService = services?.find((service) => service.name === "GardenScheduler");

    expect(librarianService).toBeDefined();
    expect(gardenSchedulerService).toBeDefined();

    await librarianService!.task();
    let latestSnapshot = await snapshotRepo.findLatest("workspace-1");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (latestSnapshot?.snapshot_at === "2026-04-17T00:15:00.000Z") {
        break;
      }

      await gardenSchedulerService!.task();
      latestSnapshot = await snapshotRepo.findLatest("workspace-1");
    }

    expect(latestSnapshot).toEqual(
      expect.objectContaining({
        workspace_id: "workspace-1",
        total_active_paths: 2,
        total_retired_paths: 0,
        paths_retired_since_last: 0,
        snapshot_at: "2026-04-17T00:15:00.000Z",
        connectivity: expect.objectContaining({
          isolated_anchors: 4
        })
      })
    );

    const history = await snapshotRepo.findHistory("workspace-1", 10);
    expect(history.map((snapshot) => snapshot.snapshot_id)).toEqual([
      latestSnapshot!.snapshot_id,
      "snapshot-previous"
    ]);

    const events = await eventLogRepo.queryByWorkspace("workspace-1");
    const snapshotCreatedEvent = events.find((entry) => entry.event_type === "path.graph.snapshot_created");
    expect(snapshotCreatedEvent).toEqual(
      expect.objectContaining({
        entity_type: "path_graph_snapshot",
        entity_id: latestSnapshot!.snapshot_id,
        workspace_id: "workspace-1",
        caused_by: "garden-path-graph-snapshotter",
        payload_json: expect.objectContaining({
          snapshot_id: latestSnapshot!.snapshot_id,
          total_active_paths: 2,
          total_retired_paths: 0,
          snapshot_at: "2026-04-17T00:15:00.000Z"
        })
      })
    );

    const notes = await healthJournalRepo.findByWorkspace("workspace-1", {
      kind: HealthEventKind.GARDEN_BACKLOG,
      limit: 10
    });
    expect(notes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspace_id: "workspace-1",
          run_id: null,
          summary: "Path graph isolation drift detected for workspace-1",
          detail_json: expect.objectContaining({
            latest_snapshot_id: latestSnapshot!.snapshot_id,
            previous_snapshot_id: "snapshot-previous",
            isolated_anchor_delta: 3,
            isolated_anchor_count: 4,
            total_active_paths: 2
          })
        })
      ])
    );
  });

  it("keeps snapshot completion successful when pruning fails after persistence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-17T00:15:00.000Z"));

    const storage = await import("@do-what/storage");
    vi.spyOn(storage.SqlitePathGraphSnapshotRepo.prototype, "deleteOlderThan")
      .mockImplementationOnce(async () => {
        throw new Error("simulated-prune-failure");
      });

    await import("../index.js");

    const database = hoisted.database;
    if (database === null) {
      throw new Error("expected in-memory database");
    }

    const workspaceRepo = new storage.SqliteWorkspaceRepo(database);
    const snapshotRepo = new storage.SqlitePathGraphSnapshotRepo(database);
    const eventLogRepo = new storage.SqliteEventLogRepo(database);

    await workspaceRepo.create({
      workspace_id: "workspace-1",
      name: "Workspace 1",
      root_path: "/tmp/workspace-1",
      workspace_kind: "local_repo",
      default_engine_binding: null,
      default_engine_class: "conversation_engine",
      workspace_state: "active"
    });

    const services = hoisted.backgroundManagers[0]?.services;
    const librarianService = services?.find((service) => service.name === "Librarian");
    const gardenSchedulerService = services?.find((service) => service.name === "GardenScheduler");

    expect(librarianService).toBeDefined();
    expect(gardenSchedulerService).toBeDefined();

    await librarianService!.task();
    await gardenSchedulerService!.task();
    await expect(gardenSchedulerService!.task()).resolves.toBeUndefined();

    const latestSnapshot = await snapshotRepo.findLatest("workspace-1");
    expect(latestSnapshot).toEqual(
      expect.objectContaining({
        workspace_id: "workspace-1",
        snapshot_at: "2026-04-17T00:15:00.000Z"
      })
    );

    const events = await eventLogRepo.queryByWorkspace("workspace-1");
    expect(events.some((entry) => entry.event_type === "path.graph.snapshot_created")).toBe(true);
    expect(hoisted.schedulerCompletions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          task_kind: GardenTaskKind.PATH_GRAPH_SNAPSHOT,
          success: true
        })
      ])
    );
  });
});

function createSnapshotFixture(overrides: Partial<PathGraphSnapshot> = {}): PathGraphSnapshot {
  return {
    snapshot_id: "snapshot-1",
    workspace_id: "workspace-1",
    total_active_paths: 2,
    total_retired_paths: 0,
    strength_distribution: {
      very_weak: 0,
      weak: 1,
      moderate: 1,
      strong: 0,
      very_strong: 0
    },
    stability_distribution: {
      volatile: 1,
      normal: 1,
      stable: 0,
      pinned: 0
    },
    governance_distribution: {
      hint_only: 1,
      attention_only: 1,
      recall_allowed: 0,
      strictly_governed: 0
    },
    connectivity: {
      unique_source_anchors: 2,
      unique_target_anchors: 2,
      max_out_degree: 1,
      max_in_degree: 1,
      isolated_anchors: 2
    },
    paths_reinforced_since_last: 1,
    paths_weakened_since_last: 0,
    paths_retired_since_last: 0,
    paths_created_since_last: 1,
    snapshot_at: "2026-04-17T00:00:00.000Z",
    ...overrides
  };
}

function resolveGardenRole(taskKind: string): string | null {
  switch (taskKind) {
    case "ttl_cleanup":
      return "janitor";
    case "evidence_staleness_check":
    case "orphan_detection":
      return "auditor";
    default:
      return "librarian";
  }
}

function createPathRelationFixture(overrides: Partial<PathRelation> = {}): PathRelation {
  return {
    path_id: "path-fixture",
    workspace_id: "workspace-1",
    anchors: {
      source_anchor: { kind: "object", object_id: "source-1" },
      target_anchor: { kind: "object", object_id: "target-1" }
    },
    constitution: {
      relation_kind: "supports",
      why_this_relation_exists: ["fixture"]
    },
    effect_vector: {
      salience: 0.3,
      recall_bias: 0.4,
      verification_bias: 0.2,
      unfinishedness_bias: 0.1,
      default_manifestation_preference: "stance_bias"
    },
    plasticity_state: {
      strength: 0.3,
      direction_bias: "source_to_target",
      stability_class: "volatile",
      support_events_count: 1,
      contradiction_events_count: 0,
      last_reinforced_at: "2026-04-17T00:05:00.000Z"
    },
    lifecycle: {
      retirement_rule: "retire_after_cooldown"
    },
    legitimacy: {
      evidence_basis: ["evidence-1"],
      governance_class: "hint_only"
    },
    created_at: "2026-04-17T00:05:00.000Z",
    updated_at: "2026-04-17T00:05:00.000Z",
    ...overrides
  };
}
