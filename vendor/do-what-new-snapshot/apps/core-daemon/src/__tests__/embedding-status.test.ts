import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceKind } from "@do-what/protocol";
import {
  EventPublisher,
  RunHotStateService,
  RunService,
  WorkspaceService
} from "@do-what/core";
import {
  SqliteEngineBindingRepo,
  SqliteEventLogRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  initDatabase,
  type StorageDatabase
} from "@do-what/storage";
import { createApp } from "../app.js";
import {
  createEmbeddingStatusService,
  type EmbeddingStatusService
} from "../services/embedding-status-service.js";
import { SseManager } from "../sse/sse-manager.js";
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

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("embedding status service", () => {
  it("keeps disabled and unconfigured embeddings in keyword-only mode", async () => {
    const service = createEmbeddingStatusService({
      embeddingEnabled: false,
      providerConfigured: false,
      modelId: null,
      storageAvailable: true,
      now: () => "2026-04-24T08:00:00.000Z"
    });

    await expect(service.getStatus("ws-1")).resolves.toEqual({
      workspace_id: "ws-1",
      embedding_enabled: false,
      provider_configured: false,
      model_id: null,
      storage_available: true,
      effective_mode: "keyword_only",
      degraded_reason: null,
      checked_at: "2026-04-24T08:00:00.000Z"
    });
  });

  it("keeps configured-but-disabled in keyword-only mode without implying enablement", async () => {
    const service = createEmbeddingStatusService({
      embeddingEnabled: false,
      providerConfigured: true,
      modelId: "text-embedding-3-small",
      storageAvailable: true,
      now: () => "2026-04-24T08:00:00.000Z"
    });

    await expect(service.getStatus("ws-1")).resolves.toEqual({
      workspace_id: "ws-1",
      embedding_enabled: false,
      provider_configured: true,
      model_id: "text-embedding-3-small",
      storage_available: true,
      effective_mode: "keyword_only",
      degraded_reason: null,
      checked_at: "2026-04-24T08:00:00.000Z"
    });
  });

  it("reports enabled and available embedding supplement mode", async () => {
    const service = createEmbeddingStatusService({
      embeddingEnabled: true,
      recallPolicyEmbeddingEnabled: true,
      providerConfigured: true,
      modelId: "text-embedding-3-small",
      storageAvailable: true,
      now: () => "2026-04-24T08:00:00.000Z"
    });

    await expect(service.getStatus("ws-1")).resolves.toMatchObject({
      embedding_enabled: true,
      provider_configured: true,
      storage_available: true,
      effective_mode: "embedding_supplement",
      degraded_reason: null
    });
  });

  it("keeps daemon opt-in without recall-policy opt-in in keyword-only mode", async () => {
    const degradationSource = {
      getRecentEvents: vi.fn(async () => [
        {
          created_at: "2026-04-24T07:59:00.000Z",
          detail_json: {
            reason: "query_embedding_failed"
          }
        }
      ])
    };
    const service = createEmbeddingStatusService({
      embeddingEnabled: true,
      recallPolicyEmbeddingEnabled: false,
      providerConfigured: true,
      modelId: "text-embedding-3-small",
      storageAvailable: true,
      degradationSource,
      now: () => "2026-04-24T08:00:00.000Z"
    });

    await expect(service.getStatus("ws-1")).resolves.toMatchObject({
      embedding_enabled: false,
      provider_configured: true,
      storage_available: true,
      effective_mode: "keyword_only",
      degraded_reason: null
    });
    expect(degradationSource.getRecentEvents).not.toHaveBeenCalled();
  });

  it("reports recently degraded runtime evidence when structural posture is available", async () => {
    const degradationSource = {
      getRecentEvents: vi.fn(async () => [
        {
          created_at: "2026-04-24T07:59:00.000Z",
          detail_json: {
            reason: "query_embedding_failed"
          }
        }
      ])
    };
    const service = createEmbeddingStatusService({
      embeddingEnabled: true,
      recallPolicyEmbeddingEnabled: true,
      providerConfigured: true,
      modelId: "text-embedding-3-small",
      storageAvailable: true,
      degradationSource,
      now: () => "2026-04-24T08:00:00.000Z"
    });

    await expect(service.getStatus("ws-1")).resolves.toMatchObject({
      embedding_enabled: true,
      provider_configured: true,
      storage_available: true,
      effective_mode: "degraded",
      degraded_reason: "query_embedding_failed"
    });
    expect(degradationSource.getRecentEvents).toHaveBeenCalledWith("ws-1", {
      kind: "embedding_supplement",
      limit: 10
    });
  });

  it("ignores stale degraded runtime evidence", async () => {
    const service = createEmbeddingStatusService({
      embeddingEnabled: true,
      recallPolicyEmbeddingEnabled: true,
      providerConfigured: true,
      modelId: "text-embedding-3-small",
      storageAvailable: true,
      degradationSource: {
        getRecentEvents: vi.fn(async () => [
          {
            created_at: "2026-04-24T07:40:00.000Z",
            detail_json: {
              reason: "query_embedding_failed"
            }
          }
        ])
      },
      now: () => "2026-04-24T08:00:00.000Z"
    });

    await expect(service.getStatus("ws-1")).resolves.toMatchObject({
      effective_mode: "embedding_supplement",
      degraded_reason: null
    });
  });

  it("reports degraded when enabled embedding cannot use provider or storage", async () => {
    const missingProvider = createEmbeddingStatusService({
      embeddingEnabled: true,
      recallPolicyEmbeddingEnabled: true,
      providerConfigured: false,
      modelId: null,
      storageAvailable: true,
      now: () => "2026-04-24T08:00:00.000Z"
    });
    const missingStorage = createEmbeddingStatusService({
      embeddingEnabled: true,
      recallPolicyEmbeddingEnabled: true,
      providerConfigured: true,
      modelId: "text-embedding-3-small",
      storageAvailable: false,
      now: () => "2026-04-24T08:00:00.000Z"
    });

    await expect(missingProvider.getStatus("ws-1")).resolves.toMatchObject({
      effective_mode: "degraded",
      degraded_reason: "provider_unconfigured"
    });
    await expect(missingStorage.getStatus("ws-1")).resolves.toMatchObject({
      effective_mode: "degraded",
      degraded_reason: "storage_unavailable"
    });
  });
});

describe("embedding status route", () => {
  it("returns no-secret embedding status for an existing workspace", async () => {
    const { app, embeddingStatusService } = createTestContext({
      embeddingEnabled: true,
      recallPolicyEmbeddingEnabled: true,
      providerConfigured: true,
      modelId: "text-embedding-3-large",
      storageAvailable: true,
      now: () => "2026-04-24T08:00:00.000Z"
    });
    const workspace = await createWorkspace(app, "embedding-status");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/embedding-status`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        workspace_id: workspace.workspace_id,
        embedding_enabled: true,
        provider_configured: true,
        model_id: "text-embedding-3-large",
        storage_available: true,
        effective_mode: "embedding_supplement",
        degraded_reason: null,
        checked_at: "2026-04-24T08:00:00.000Z"
      }
    });
    expect(await embeddingStatusService.getStatus(workspace.workspace_id)).not.toHaveProperty("api_key");
  });

  it("fails closed when an injected service tries to return a secret field", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { app } = createTestContext(
      {
        embeddingEnabled: true,
        recallPolicyEmbeddingEnabled: true,
        providerConfigured: true,
        modelId: "text-embedding-3-large",
        storageAvailable: true,
        now: () => "2026-04-24T08:00:00.000Z"
      },
      {
        embeddingStatusService: {
          getStatus: async (workspaceId: string) => ({
            workspace_id: workspaceId,
            embedding_enabled: true,
            provider_configured: true,
            model_id: "text-embedding-3-large",
            storage_available: true,
            effective_mode: "embedding_supplement",
            degraded_reason: null,
            checked_at: "2026-04-24T08:00:00.000Z",
            api_key: "sk-leak"
          })
        } as unknown as EmbeddingStatusService
      }
    );
    const workspace = await createWorkspace(app, "embedding-status-secret");

    const response = await app.request(`/workspaces/${workspace.workspace_id}/embedding-status`);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain("sk-leak");
    consoleError.mockRestore();
  });

  it("requires the workspace to exist", async () => {
    const { app } = createTestContext({
      embeddingEnabled: false,
      providerConfigured: false,
      modelId: null,
      storageAvailable: true
    });

    const response = await app.request("/workspaces/ws_missing/embedding-status");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Resource not found"
    });
  });
});

function createTestContext(
  options: Parameters<typeof createEmbeddingStatusService>[0],
  overrides: {
    readonly embeddingStatusService?: EmbeddingStatusService;
  } = {}
): {
  readonly app: ReturnType<typeof createApp>;
  readonly database: StorageDatabase;
  readonly embeddingStatusService: EmbeddingStatusService;
} {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const bindingRepo = new SqliteEngineBindingRepo(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
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
    bindingRepo,
    eventPublisher,
    isPrincipalCodingEngineAvailable: () => false
  });
  const embeddingStatusService = overrides.embeddingStatusService ?? createEmbeddingStatusService(options);

  return {
    app: createApp({
      workspaceService,
      embeddingStatusService,
      runService,
      conversationService: createNoopConversationService("embedding status tests") as any,
      engineBindingService: createStubEngineBindingService() as any,
      runHotStateService,
      sseManager,
      signalService: createUnusedSignalService("embedding status tests") as any,
      evidenceService: createUnusedEvidenceService("embedding status tests") as any,
      memoryService: createUnusedMemoryService("embedding status tests") as any,
      slotService: createUnusedSlotService("embedding status tests") as any,
      synthesisService: createUnusedSynthesisService("embedding status tests") as any,
      claimService: createUnusedClaimService("embedding status tests") as any,
      proposalService: createUnusedProposalService("embedding status tests") as any
    }),
    database,
    embeddingStatusService
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
