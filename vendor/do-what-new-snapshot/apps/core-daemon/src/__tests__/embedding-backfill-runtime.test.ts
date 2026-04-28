import { afterEach, describe, expect, it, vi } from "vitest";
import { GardenTaskKind, MemoryDimension, ScopeClass, type MemoryEntry } from "@do-what/protocol";
import type { StorageDatabase } from "@do-what/storage";

const ORIGINAL_OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ORIGINAL_OPENAI_EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL;
const ORIGINAL_DO_WHAT_ENABLE_EMBEDDING_SUPPLEMENT =
  process.env.DO_WHAT_ENABLE_EMBEDDING_SUPPLEMENT;
const ORIGINAL_FETCH = globalThis.fetch;

const hoisted = vi.hoisted(() => ({
  backgroundManagers: [] as Array<{
    readonly services: readonly {
      readonly name: string;
      readonly intervalMs: number;
      readonly task: () => Promise<void>;
    }[];
  }>,
  database: null as StorageDatabase | null,
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
      broadcastEntry: vi.fn(async () => undefined)
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
  }

  return {
    ...actual,
    GardenScheduler: DeterministicGardenScheduler
  };
});

describe("embedding backfill runtime wiring", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    hoisted.backgroundManagers.length = 0;
    hoisted.schedulerCompletions.length = 0;
    hoisted.database?.close();
    hoisted.database = null;
    if (ORIGINAL_OPENAI_API_KEY === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = ORIGINAL_OPENAI_API_KEY;
    }
    if (ORIGINAL_OPENAI_EMBEDDING_MODEL === undefined) {
      delete process.env.OPENAI_EMBEDDING_MODEL;
    } else {
      process.env.OPENAI_EMBEDDING_MODEL = ORIGINAL_OPENAI_EMBEDDING_MODEL;
    }
    if (ORIGINAL_DO_WHAT_ENABLE_EMBEDDING_SUPPLEMENT === undefined) {
      delete process.env.DO_WHAT_ENABLE_EMBEDDING_SUPPLEMENT;
    } else {
      process.env.DO_WHAT_ENABLE_EMBEDDING_SUPPLEMENT =
        ORIGINAL_DO_WHAT_ENABLE_EMBEDDING_SUPPLEMENT;
    }
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("keeps embedding backfill disabled on the default daemon path even when OPENAI_API_KEY is present", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T08:00:00.000Z"));
    process.env.OPENAI_API_KEY = "sk-embedding";
    process.env.OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
    delete process.env.DO_WHAT_ENABLE_EMBEDDING_SUPPLEMENT;
    globalThis.fetch = vi.fn(async () => createJsonResponse({ data: [] })) as typeof fetch;

    await import("../index.js");

    const storage = await import("@do-what/storage");
    const database = hoisted.database;
    if (database === null) {
      throw new Error("expected in-memory database");
    }

    const workspaceRepo = new storage.SqliteWorkspaceRepo(database);
    const memoryEntryRepo = new storage.SqliteMemoryEntryRepo(database);
    const memoryEmbeddingRepo = new storage.SqliteMemoryEmbeddingRepo(database);

    await workspaceRepo.create({
      workspace_id: "workspace-1",
      name: "Embedding Runtime Workspace",
      root_path: "/tmp/embedding-runtime-workspace",
      workspace_kind: "local_repo",
      default_engine_binding: null,
      default_engine_class: "conversation_engine",
      workspace_state: "active"
    });
    await memoryEntryRepo.create(
      createMemoryEntry({
        object_id: "11111111-1111-4111-8111-111111111111",
        content: "Semantic note for the runtime backfill path."
      })
    );

    const services = hoisted.backgroundManagers[0]?.services;
    const librarianService = services?.find((service) => service.name === "Librarian");
    const gardenSchedulerService = services?.find((service) => service.name === "GardenScheduler");

    await librarianService!.task();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await gardenSchedulerService!.task();
    }

    await expect(
      memoryEmbeddingRepo.findByObjectId("11111111-1111-4111-8111-111111111111")
    ).resolves.toBeNull();
    expect(hoisted.schedulerCompletions).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          task_kind: GardenTaskKind.EMBEDDING_BACKFILL
        })
      ])
    );
  });

  it("enqueues embedding_backfill on the librarian cadence and persists embeddings through the live daemon wiring", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T08:00:00.000Z"));
    process.env.OPENAI_API_KEY = "sk-embedding";
    process.env.OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
    process.env.DO_WHAT_ENABLE_EMBEDDING_SUPPLEMENT = "true";
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        readonly input: readonly string[] | string;
      };
      const inputs = Array.isArray(body.input) ? body.input : [body.input];

      return createJsonResponse({
        data: inputs.map((text) => ({
          embedding: embeddingForText(text)
        }))
      });
    }) as typeof fetch;

    await import("../index.js");

    const storage = await import("@do-what/storage");
    const database = hoisted.database;
    if (database === null) {
      throw new Error("expected in-memory database");
    }

    const workspaceRepo = new storage.SqliteWorkspaceRepo(database);
    const runRepo = new storage.SqliteRunRepo(database);
    const memoryEntryRepo = new storage.SqliteMemoryEntryRepo(database);
    const memoryEmbeddingRepo = new storage.SqliteMemoryEmbeddingRepo(database);

    await workspaceRepo.create({
      workspace_id: "workspace-1",
      name: "Embedding Runtime Workspace",
      root_path: "/tmp/embedding-runtime-workspace",
      workspace_kind: "local_repo",
      default_engine_binding: null,
      default_engine_class: "conversation_engine",
      workspace_state: "active"
    });
    await runRepo.create({
      run_id: "run-1",
      workspace_id: "workspace-1",
      title: "Embedding Runtime Run",
      goal: null,
      run_mode: "chat",
      engine_binding_id: null,
      engine_class: null,
      run_state: "idle",
      current_surface_id: null
    });
    await memoryEntryRepo.create(
      createMemoryEntry({
        object_id: "11111111-1111-4111-8111-111111111111",
        content: "Semantic note for the runtime backfill path."
      })
    );

    const services = hoisted.backgroundManagers[0]?.services;
    const librarianService = services?.find((service) => service.name === "Librarian");
    const gardenSchedulerService = services?.find((service) => service.name === "GardenScheduler");

    expect(librarianService).toBeDefined();
    expect(gardenSchedulerService).toBeDefined();

    await librarianService!.task();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await gardenSchedulerService!.task();
    }

    await expect(
      memoryEmbeddingRepo.findByObjectId("11111111-1111-4111-8111-111111111111")
    ).resolves.toEqual(
      expect.objectContaining({
        object_id: "11111111-1111-4111-8111-111111111111",
        workspace_id: "workspace-1",
        provider_kind: "openai",
        model_id: "text-embedding-3-small",
        dimensions: 3
      })
    );
    expect(hoisted.schedulerCompletions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          task_kind: GardenTaskKind.EMBEDDING_BACKFILL,
          success: true,
          objects_affected: ["11111111-1111-4111-8111-111111111111"]
        })
      ])
    );
  });

  it("dedupes pending embedding_backfill tasks per workspace across repeated librarian cadence ticks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T08:00:00.000Z"));
    process.env.OPENAI_API_KEY = "sk-embedding";
    process.env.OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
    process.env.DO_WHAT_ENABLE_EMBEDDING_SUPPLEMENT = "true";
    globalThis.fetch = vi.fn(async () => createJsonResponse({ data: [] })) as typeof fetch;

    await import("../index.js");

    const storage = await import("@do-what/storage");
    const database = hoisted.database;
    if (database === null) {
      throw new Error("expected in-memory database");
    }

    const workspaceRepo = new storage.SqliteWorkspaceRepo(database);
    const services = hoisted.backgroundManagers[0]?.services;
    const librarianService = services?.find((service) => service.name === "Librarian");
    const gardenSchedulerService = services?.find((service) => service.name === "GardenScheduler");

    for (let index = 0; index < 6; index += 1) {
      await workspaceRepo.create({
        workspace_id: `workspace-${index + 1}`,
        name: `Embedding Runtime Workspace ${index + 1}`,
        root_path: `/tmp/embedding-runtime-workspace-${index + 1}`,
        workspace_kind: "local_repo",
        default_engine_binding: null,
        default_engine_class: "conversation_engine",
        workspace_state: "active"
      });
    }

    await librarianService!.task();
    await librarianService!.task();

    for (let attempt = 0; attempt < 30; attempt += 1) {
      await gardenSchedulerService!.task();
    }

    const embeddingBackfillCompletions = hoisted.schedulerCompletions.filter((result) =>
      (result as { readonly task_kind?: string }).task_kind === GardenTaskKind.EMBEDDING_BACKFILL
    );

    expect(embeddingBackfillCompletions).toHaveLength(6);
    expect(embeddingBackfillCompletions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          task_kind: GardenTaskKind.EMBEDDING_BACKFILL,
          success: true,
          audit_entries: ["embedding_backfill_skipped:no_hot_memories"]
        })
      ])
    );
  });
});

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

function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: overrides.object_id ?? "11111111-1111-4111-8111-111111111111",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-04-23T08:00:00.000Z",
    updated_at: "2026-04-23T08:00:00.000Z",
    created_by: "system",
    dimension: overrides.dimension ?? MemoryDimension.PROCEDURE,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: overrides.scope_class ?? ScopeClass.PROJECT,
    content: overrides.content ?? "Semantic note for the runtime backfill path.",
    domain_tags: [],
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: 0.7,
    retention_score: null,
    manifestation_state: null,
    retention_state: null,
    decay_profile: null,
    confidence: null,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: null,
    contradiction_count: null,
    superseded_by: null,
    ...overrides
  };
}

function embeddingForText(text: string): readonly number[] {
  if (text.includes("runtime backfill")) {
    return [0.9, 0.05, 0.1];
  }

  return [0.1, 0.9, 0.05];
}

function createJsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json"
    }
  });
}
