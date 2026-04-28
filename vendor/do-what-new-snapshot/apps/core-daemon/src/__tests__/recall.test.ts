import { afterEach, describe, expect, it } from "vitest";
import {
  EventPublisher,
  ProjectMappingService,
  RecallService,
  RunHotStateService,
  RunService,
  TaskSurfaceBuilder,
  WorkspaceService
} from "@do-what/core";
import {
  AcceptedBy,
  MemoryDimension,
  ProjectMappingState,
  RunMode,
  RunState,
  ScopeClass,
  WorkspaceKind
} from "@do-what/protocol";
import {
  SqliteEventLogRepo,
  SqliteGlobalMemoryRecallCacheRepo,
  SqliteGlobalMemoryRepo,
  SqliteMemoryEntryRepo,
  SqliteProjectMappingAnchorRepo,
  SqliteRunRepo,
  SqliteSlotRepo,
  SqliteSurfaceIdentityRepo,
  SqliteWorkspaceRepo,
  initDatabase,
  type StorageDatabase
} from "@do-what/storage";
import { createApp } from "../app.js";
import {
  createNoopConversationService,
  createStubEngineBindingService,
  createUnusedClaimService,
  createUnusedEvidenceService,
  createUnusedMemoryService,
  createUnusedProposalService,
  createUnusedSignalService,
  createUnusedSlotService,
  createUnusedSynthesisService
} from "./helpers/mock-services.js";
import { SseManager } from "../sse/sse-manager.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("recall routes", () => {
  it("returns task surface for run", async () => {
    const { app, runRepo, surfaceIdentityRepo } = createTestContext();
    const workspace = await createWorkspace(app, "recall-task-surface");
    await surfaceIdentityRepo.create(createSurfaceIdentity(workspace.workspace_id, "surface://code-editor", "code-editor"));
    await runRepo.create(createRun(workspace.workspace_id, {
      run_id: "run-task-surface",
      current_surface_id: "surface://code-editor",
      run_mode: RunMode.CHAT,
      title: "Implement recall route"
    }));

    const response = await app.request("/runs/run-task-surface/task-surface");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        object_kind: "task_object_surface",
        surface_kind: "code-editor",
        display_name: "Implement recall route",
        retention_policy: "session_only"
      }
    });
  });

  it("returns 404 for missing run on task surface route", async () => {
    const { app } = createTestContext();

    const response = await app.request("/runs/run-missing/task-surface");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Resource not found"
    });
  });

  it("returns recall candidates using auto-detected build strategy", async () => {
    const { app, runRepo, surfaceIdentityRepo, memoryEntryRepo } = createTestContext();
    const workspace = await createWorkspace(app, "recall-auto-build");
    await surfaceIdentityRepo.create(createSurfaceIdentity(workspace.workspace_id, "surface://code-editor", "code-editor"));
    await runRepo.create(createRun(workspace.workspace_id, {
      run_id: "run-auto-build",
      current_surface_id: "surface://code-editor",
      run_mode: RunMode.CHAT,
      title: "Auto build recall"
    }));
    await memoryEntryRepo.create(createMemoryEntry(workspace.workspace_id, "run-auto-build", {
      object_id: "11111111-1111-4111-8111-111111111111",
      dimension: MemoryDimension.PROCEDURE,
      scope_class: ScopeClass.PROJECT,
      activation_score: 0.8,
      content: "Project procedure"
    }));
    await memoryEntryRepo.create(createMemoryEntry(workspace.workspace_id, "run-auto-build", {
      object_id: "22222222-2222-4222-8222-222222222222",
      dimension: MemoryDimension.PREFERENCE,
      scope_class: ScopeClass.GLOBAL_DOMAIN,
      activation_score: 0.9,
      content: "Global preference"
    }));
    await memoryEntryRepo.create(createMemoryEntry(workspace.workspace_id, "run-auto-build", {
      object_id: "33333333-3333-4333-8333-333333333333",
      dimension: MemoryDimension.HAZARD,
      scope_class: ScopeClass.GLOBAL_DOMAIN,
      activation_score: 0.01,
      content: "Hazard reminder"
    }));

    const response = await app.request("/runs/run-auto-build/recall-candidates");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        candidates: [
          {
            object_id: "33333333-3333-4333-8333-333333333333",
            dimension: "hazard",
            origin_plane: "workspace_local"
          },
          {
            object_id: "11111111-1111-4111-8111-111111111111",
            dimension: "procedure",
            origin_plane: "workspace_local"
          }
        ]
      }
    });
  });

  it("returns build-strategy candidates when strategy query overrides run mode", async () => {
    const { app, runRepo, memoryEntryRepo } = createTestContext();
    const workspace = await createWorkspace(app, "recall-query-build");
    await runRepo.create(createRun(workspace.workspace_id, {
      run_id: "run-query-build",
      current_surface_id: null,
      run_mode: RunMode.CHAT,
      title: "Query override recall"
    }));
    await memoryEntryRepo.create(createMemoryEntry(workspace.workspace_id, "run-query-build", {
      object_id: "44444444-4444-4444-8444-444444444444",
      dimension: MemoryDimension.PROCEDURE,
      scope_class: ScopeClass.PROJECT,
      activation_score: 0.7,
      content: "Project procedure"
    }));
    await memoryEntryRepo.create(createMemoryEntry(workspace.workspace_id, "run-query-build", {
      object_id: "55555555-5555-4555-8555-555555555555",
      dimension: MemoryDimension.FACT,
      scope_class: ScopeClass.PROJECT,
      activation_score: 0.9,
      content: "Project fact"
    }));

    const response = await app.request("/runs/run-query-build/recall-candidates?strategy=build");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        candidates: [
          {
            object_id: "44444444-4444-4444-8444-444444444444",
            dimension: "procedure",
            origin_plane: "workspace_local"
          }
        ]
      }
    });
  });

  it("returns 404 for missing run on recall route", async () => {
    const { app } = createTestContext();

    const response = await app.request("/runs/run-missing/recall-candidates");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Resource not found"
    });
  });

  it("rejects recall-candidate GETs without a request token when request protection is enabled", async () => {
    const requestProtection = {
      allowedOrigin: "http://localhost:5173",
      requestToken: "request-token-123"
    };
    const { app, runRepo, memoryEntryRepo } = createTestContext({ requestProtection });
    const workspace = await createProtectedWorkspace(app, "recall-protected-missing-token", requestProtection);
    await runRepo.create(createRun(workspace.workspace_id, {
      run_id: "run-recall-protected-missing-token",
      current_surface_id: null,
      run_mode: RunMode.CHAT,
      title: "Protected recall without token"
    }));
    await memoryEntryRepo.create(createMemoryEntry(workspace.workspace_id, "run-recall-protected-missing-token", {
      object_id: "99999999-9999-4999-8999-999999999999",
      dimension: MemoryDimension.PROCEDURE,
      scope_class: ScopeClass.PROJECT,
      activation_score: 0.8,
      content: "Protected recall procedure"
    }));

    const response = await app.request("/runs/run-recall-protected-missing-token/recall-candidates", {
      headers: {
        origin: requestProtection.allowedOrigin
      }
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "X-Request-Token is required"
    });
  });

  it("allows recall-candidate GETs when the request token is valid", async () => {
    const requestProtection = {
      allowedOrigin: "http://localhost:5173",
      requestToken: "request-token-123"
    };
    const { app, runRepo, memoryEntryRepo } = createTestContext({ requestProtection });
    const workspace = await createProtectedWorkspace(app, "recall-protected-valid-token", requestProtection);
    await runRepo.create(createRun(workspace.workspace_id, {
      run_id: "run-recall-protected-valid-token",
      current_surface_id: null,
      run_mode: RunMode.CHAT,
      title: "Protected recall with token"
    }));
    await memoryEntryRepo.create(createMemoryEntry(workspace.workspace_id, "run-recall-protected-valid-token", {
      object_id: "aaaaaaaa-9999-4aaa-8aaa-aaaaaaaa9999",
      dimension: MemoryDimension.PROCEDURE,
      scope_class: ScopeClass.PROJECT,
      activation_score: 0.8,
      content: "Protected recall procedure"
    }));

    const response = await app.request("/runs/run-recall-protected-valid-token/recall-candidates", {
      headers: {
        origin: requestProtection.allowedOrigin,
        "x-request-token": requestProtection.requestToken
      }
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        candidates: [
          expect.objectContaining({
            object_id: "aaaaaaaa-9999-4aaa-8aaa-aaaaaaaa9999",
            origin_plane: "workspace_local"
          })
        ]
      }
    });
  });

  it("includes accepted global-source recall candidates and records strict cache classifications", async () => {
    const {
      app,
      runRepo,
      memoryEntryRepo,
      globalMemoryRepo,
      globalMemoryRecallCacheRepo,
      projectMappingAnchorRepo
    } = createTestContext({ enableGlobalRecall: true });
    const workspace = await createWorkspace(app, "recall-global-memory");
    await runRepo.create(createRun(workspace.workspace_id, {
      run_id: "run-global-recall",
      current_surface_id: null,
      run_mode: RunMode.CHAT,
      title: "Global recall route"
    }));
    await memoryEntryRepo.create(createMemoryEntry(workspace.workspace_id, "run-global-recall", {
      object_id: "77777777-7777-4777-8777-777777777777",
      dimension: MemoryDimension.PROCEDURE,
      scope_class: ScopeClass.PROJECT,
      activation_score: 0.7,
      content: "Workspace-local procedure"
    }));
    await globalMemoryRepo.upsert(createGlobalMemoryEntry({
      global_object_id: "global-accepted",
      canonical_identity: "identity://accepted",
      content: "Accepted global procedure"
    }));
    await globalMemoryRepo.upsert(createGlobalMemoryEntry({
      global_object_id: "global-suggested",
      canonical_identity: "identity://suggested",
      content: "Suggested-only global procedure",
      activation_score: 0.4
    }));
    await projectMappingAnchorRepo.create(
      createProjectMappingAnchor(workspace.workspace_id, "global-accepted", {
        object_id: "mapping-accepted",
        mapping_state: ProjectMappingState.ACCEPTED,
        accepted_by: AcceptedBy.USER
      })
    );

    const response = await app.request("/runs/run-global-recall/recall-candidates?strategy=analyze");

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      readonly success: boolean;
      readonly data: {
        readonly candidates: ReadonlyArray<{
          readonly object_id: string;
          readonly origin_plane: string;
        }>;
      };
    };

    expect(payload.success).toBe(true);
    expect(payload.data.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          object_id: "77777777-7777-4777-8777-777777777777",
          origin_plane: "workspace_local"
        }),
        expect.objectContaining({
          object_id: "global-accepted",
          origin_plane: "global"
        })
      ])
    );
    expect(payload.data.candidates.some((candidate) => candidate.object_id === "global-suggested")).toBe(false);
    await expect(globalMemoryRecallCacheRepo.listByWorkspace(workspace.workspace_id)).resolves.toEqual([
      expect.objectContaining({
        workspace_id: workspace.workspace_id,
        global_object_id: "global-accepted",
        classification: "included"
      }),
      expect.objectContaining({
        workspace_id: workspace.workspace_id,
        global_object_id: "global-suggested",
        classification: "excluded"
      })
    ]);
    await expect(
      projectMappingAnchorRepo.findByGlobalObjectId("global-suggested", workspace.workspace_id)
    ).resolves.toEqual(
      expect.objectContaining({
        global_object_id: "global-suggested",
        mapping_state: ProjectMappingState.SUGGESTED
      })
    );
  });
});

function createTestContext(options?: {
  readonly enableGlobalRecall?: boolean;
  readonly requestProtection?: {
    readonly allowedOrigin: string;
    readonly requestToken: string;
    readonly allowDesktopOriginlessRequests?: boolean;
  };
}): {
  readonly app: ReturnType<typeof createApp>;
  readonly database: StorageDatabase;
  readonly runRepo: SqliteRunRepo;
  readonly surfaceIdentityRepo: SqliteSurfaceIdentityRepo;
  readonly memoryEntryRepo: SqliteMemoryEntryRepo;
  readonly globalMemoryRepo: SqliteGlobalMemoryRepo;
  readonly globalMemoryRecallCacheRepo: SqliteGlobalMemoryRecallCacheRepo;
  readonly projectMappingAnchorRepo: SqliteProjectMappingAnchorRepo;
} {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const memoryEntryRepo = new SqliteMemoryEntryRepo(database);
  const globalMemoryRepo = new SqliteGlobalMemoryRepo(database);
  const globalMemoryRecallCacheRepo = new SqliteGlobalMemoryRecallCacheRepo(database);
  const projectMappingAnchorRepo = new SqliteProjectMappingAnchorRepo(database);
  const slotRepo = new SqliteSlotRepo(database);
  const surfaceIdentityRepo = new SqliteSurfaceIdentityRepo(database);
  const runHotStateService = new RunHotStateService({ runRepo, eventLogRepo });
  const sseManager = new SseManager(eventLogRepo);
  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runHotStateService,
    sseBroadcaster: sseManager
  });
  const workspaceService = new WorkspaceService({
    workspaceRepo,
    runRepo,
    eventPublisher
  });
  const runService = new RunService({
    workspaceRepo,
    runRepo,
    eventPublisher
  });
  const taskSurfaceBuilder = new TaskSurfaceBuilder({
    surfaceRepo: surfaceIdentityRepo,
    eventLogRepo
  });
  const projectMappingService = new ProjectMappingService({
    projectMappingRepo: projectMappingAnchorRepo,
    memoryRepo: memoryEntryRepo,
    eventLogRepo,
    sseBroadcaster: sseManager
  });
  const recallService = new RecallService({
    memoryRepo: memoryEntryRepo,
    slotRepo,
    eventLogRepo,
    ...(options?.enableGlobalRecall === true
      ? {
          projectMappingPort: projectMappingService,
          globalRecallPort: {
            recall: async ({
              limit
            }: {
              readonly workspaceId: string;
              readonly queryText: string | null;
              readonly limit: number;
            }) =>
              (await globalMemoryRepo.list())
                .slice(0, limit)
                .map((entry) => ({
                  global_object_id: entry.global_object_id,
                  dimension: entry.dimension,
                  scope_class: entry.scope_class,
                  content: entry.content,
                  domain_tags: entry.domain_tags,
                  activation_score: entry.activation_score,
                  created_at: entry.created_at,
                  updated_at: entry.updated_at
                }))
          },
          globalRecallCachePort: {
            recordClassifications: async (
              records: ReadonlyArray<{
                readonly workspaceId: string;
                readonly globalObjectId: string;
                readonly classification: "included" | "excluded";
              }>
            ) => {
              const updatedAt = "2026-04-23T00:00:00.000Z";

              await Promise.all(
                records.map(async (record) => {
                  await globalMemoryRecallCacheRepo.upsert({
                    workspace_id: record.workspaceId,
                    global_object_id: record.globalObjectId,
                    classification: record.classification,
                    updated_at: updatedAt
                  });
                })
              );
            }
          }
        }
      : {})
  });

  return {
    app: createApp({
      workspaceService,
      runService,
      conversationService: createNoopConversationService("recall route tests") as any,
      engineBindingService: createStubEngineBindingService() as any,
      runHotStateService,
      sseManager,
      signalService: createUnusedSignalService("recall route tests") as any,
      evidenceService: createUnusedEvidenceService("recall route tests") as any,
      memoryService: createUnusedMemoryService("recall route tests") as any,
      slotService: createUnusedSlotService("recall route tests") as any,
      synthesisService: createUnusedSynthesisService("recall route tests") as any,
      claimService: createUnusedClaimService("recall route tests") as any,
      proposalService: createUnusedProposalService("recall route tests") as any,
      recallService,
      taskSurfaceBuilder,
      requestProtection: options?.requestProtection
    }),
    database,
    runRepo,
    surfaceIdentityRepo,
    memoryEntryRepo,
    globalMemoryRepo,
    globalMemoryRecallCacheRepo,
    projectMappingAnchorRepo
  };
}

async function createWorkspace(app: ReturnType<typeof createApp>, name: string): Promise<{
  readonly workspace_id: string;
}> {
  const response = await app.request("/workspaces", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name,
      root_path: `/tmp/${name}`,
      workspace_kind: WorkspaceKind.LOCAL_REPO
    })
  });

  expect(response.status).toBe(201);
  const body = (await response.json()) as { readonly data: { readonly workspace_id: string } };
  return body.data;
}

async function createProtectedWorkspace(
  app: ReturnType<typeof createApp>,
  name: string,
  requestProtection: {
    readonly allowedOrigin: string;
    readonly requestToken: string;
  }
): Promise<{
  readonly workspace_id: string;
}> {
  const response = await app.request("/workspaces", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: requestProtection.allowedOrigin,
      "x-request-token": requestProtection.requestToken
    },
    body: JSON.stringify({
      name,
      root_path: `/tmp/${name}`,
      workspace_kind: WorkspaceKind.LOCAL_REPO
    })
  });

  expect(response.status).toBe(201);
  const body = (await response.json()) as { readonly data: { readonly workspace_id: string } };
  return body.data;
}

function createRun(
  workspaceId: string,
  overrides: Partial<{
    readonly run_id: string;
    readonly current_surface_id: string | null;
    readonly run_mode: (typeof RunMode)[keyof typeof RunMode];
    readonly title: string;
  }> = {}
) {
  return {
    run_id: overrides.run_id ?? "run-1",
    workspace_id: workspaceId,
    title: overrides.title ?? "Recall run",
    goal: null,
    run_mode: overrides.run_mode ?? RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: overrides.current_surface_id ?? null
  } as const;
}

function createSurfaceIdentity(workspaceId: string, surfaceId: string, surfaceKind: string) {
  return {
    object_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    object_kind: "surface_identity",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-23T00:00:00.000Z",
    updated_at: "2026-03-23T00:00:00.000Z",
    created_by: "system",
    surface_id: surfaceId,
    surface_kind: surfaceKind,
    surface_status: "active",
    workspace_id: workspaceId
  } as const;
}

function createMemoryEntry(workspaceId: string, runId: string, overrides: Partial<any> = {}) {
  return {
    object_id: overrides.object_id ?? "66666666-6666-4666-8666-666666666666",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-23T00:00:00.000Z",
    updated_at: "2026-03-23T00:00:00.000Z",
    created_by: "system",
    dimension: overrides.dimension ?? MemoryDimension.PROCEDURE,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: overrides.scope_class ?? ScopeClass.PROJECT,
    content: overrides.content ?? "Project procedure",
    domain_tags: [],
    evidence_refs: [],
    workspace_id: workspaceId,
    run_id: runId,
    surface_id: null,
    storage_tier: "hot",
    activation_score: overrides.activation_score ?? 0.5,
    retention_score: null,
    manifestation_state: null,
    retention_state: null,
    decay_profile: null,
    confidence: null,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: null,
    contradiction_count: null,
    superseded_by: null
  } as const;
}

function createGlobalMemoryEntry(
  overrides: Partial<{
    readonly global_object_id: string;
    readonly canonical_identity: string;
    readonly content: string;
    readonly activation_score: number | null;
  }> = {}
) {
  return {
    global_object_id: overrides.global_object_id ?? "global-memory-1",
    object_kind: "global_memory_entry",
    canonical_identity: overrides.canonical_identity ?? "identity://global-memory-1",
    dimension: MemoryDimension.PROCEDURE,
    scope_class: ScopeClass.GLOBAL_DOMAIN,
    content: overrides.content ?? "Global memory content",
    domain_tags: ["workflow"],
    provenance: "operator-curated",
    activation_score: overrides.activation_score ?? 0.85,
    version: 1,
    created_at: "2026-04-23T00:00:00.000Z",
    updated_at: "2026-04-23T00:00:00.000Z"
  } as const;
}

function createProjectMappingAnchor(
  workspaceId: string,
  globalObjectId: string,
  overrides: Partial<{
    readonly object_id: string;
    readonly mapping_state: (typeof ProjectMappingState)[keyof typeof ProjectMappingState];
    readonly accepted_by: (typeof AcceptedBy)[keyof typeof AcceptedBy] | null;
  }> = {}
) {
  return {
    object_id: overrides.object_id ?? "mapping-1",
    object_kind: "project_mapping_anchor",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-04-23T00:00:00.000Z",
    updated_at: "2026-04-23T00:00:00.000Z",
    created_by: "system",
    global_object_id: globalObjectId,
    project_id: workspaceId,
    workspace_id: workspaceId,
    mapping_state: overrides.mapping_state ?? ProjectMappingState.SUGGESTED,
    accepted_by: overrides.accepted_by ?? null,
    last_transition_at: "2026-04-23T00:00:00.000Z"
  } as const;
}
