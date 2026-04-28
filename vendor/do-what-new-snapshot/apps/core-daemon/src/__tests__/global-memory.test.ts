import { describe, expect, it, vi } from "vitest";
import { AcceptedBy, WorkspaceKind, type ProjectMappingAnchor } from "@do-what/protocol";
import {
  EventPublisher,
  RunHotStateService,
  RunService,
  WorkspaceService
} from "@do-what/core";
import {
  SqliteEventLogRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  initDatabase,
  type StorageDatabase
} from "@do-what/storage";
import { createApp } from "../app.js";
import type { CoreDaemonServices } from "../app.js";
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

describe("global memory routes", () => {
  it("lists entries with protocol-aligned snake_case filters", async () => {
    const entry = createGlobalMemoryEntry();
    const { app, globalMemoryService } = createTestContext({
      list: vi.fn(async () => [entry])
    });

    const response = await app.request("/soul/global-memory-entries?dimension=procedure&scope_class=global_domain&limit=25");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        entries: [entry],
        total: 1
      }
    });
    expect(globalMemoryService.list).toHaveBeenCalledWith({
      dimension: "procedure",
      scope_class: "global_domain",
      limit: 25
    });
  });

  it("adopts a global entry into a workspace using snake_case payload", async () => {
    const anchor = createProjectMappingAnchor();
    const { app, globalMemoryService } = createTestContext({
      adopt: vi.fn(async () => anchor)
    });
    const workspace = await createWorkspace(app, "global-memory-adopt");

    const response = await app.request("/soul/global-memory-entries/global-1/adopt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace_id: workspace.workspace_id
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        anchor
      }
    });
    expect(globalMemoryService.adopt).toHaveBeenCalledWith("global-1", {
      workspace_id: workspace.workspace_id,
      accepted_by: AcceptedBy.USER
    });
  });

  it("does not register global memory routes when the service is absent", async () => {
    const { app } = createTestContext(undefined, { omitGlobalMemoryService: true });

    const response = await app.request("/soul/global-memory-entries");

    expect(response.status).toBe(404);
  });
});

type GlobalMemoryEntry = {
  readonly global_object_id: string;
  readonly object_kind: "global_memory_entry";
  readonly canonical_identity: string;
  readonly dimension: string;
  readonly scope_class: string;
  readonly content: string;
  readonly domain_tags: readonly string[];
  readonly provenance: string;
  readonly activation_score: number | null;
  readonly version: number;
  readonly created_at: string;
  readonly updated_at: string;
};

type GlobalMemoryServiceStub = {
  readonly list: ReturnType<typeof vi.fn>;
  readonly adopt: ReturnType<typeof vi.fn>;
};

function createTestContext(
  overrides?: Partial<GlobalMemoryServiceStub>,
  options?: {
    readonly omitGlobalMemoryService?: boolean;
  }
): {
  readonly app: ReturnType<typeof createApp>;
  readonly database: StorageDatabase;
  readonly globalMemoryService: GlobalMemoryServiceStub;
} {
  const database = initDatabase({ filename: ":memory:" });
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
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
    eventPublisher
  });
  const globalMemoryService: GlobalMemoryServiceStub = {
    list: vi.fn(async () => []),
    adopt: vi.fn(async () => createProjectMappingAnchor())
  };
  const services: CoreDaemonServices = {
    workspaceService,
    runService,
    conversationService: createNoopConversationService("global memory routes") as any,
    engineBindingService: createStubEngineBindingService() as any,
    runHotStateService,
    sseManager,
    signalService: createUnusedSignalService("global memory routes") as any,
    evidenceService: createUnusedEvidenceService("global memory routes") as any,
    memoryService: createUnusedMemoryService("global memory routes") as any,
    slotService: createUnusedSlotService("global memory routes") as any,
    synthesisService: createUnusedSynthesisService("global memory routes") as any,
    claimService: createUnusedClaimService("global memory routes") as any,
    proposalService: createUnusedProposalService("global memory routes") as any,
    ...(options?.omitGlobalMemoryService === true
      ? {}
      : { globalMemoryService: { ...globalMemoryService, ...overrides } as never })
  };

  return {
    app: createApp(services),
    database,
    globalMemoryService: {
      ...globalMemoryService,
      ...overrides
    }
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
  const payload = (await response.json()) as {
    readonly data: {
      readonly workspace_id: string;
    };
  };

  return payload.data;
}

function createGlobalMemoryEntry(overrides: Partial<GlobalMemoryEntry> = {}): GlobalMemoryEntry {
  return {
    global_object_id: "global-1",
    object_kind: "global_memory_entry",
    canonical_identity: "identity://global-1",
    dimension: "procedure",
    scope_class: "global_domain",
    content: "Shared procedure",
    domain_tags: ["workflow"],
    provenance: "operator-curated",
    activation_score: 0.8,
    version: 3,
    created_at: "2026-04-23T00:00:00.000Z",
    updated_at: "2026-04-23T00:00:00.000Z",
    ...overrides
  };
}

function createProjectMappingAnchor(overrides: Partial<ProjectMappingAnchor> = {}): ProjectMappingAnchor {
  return {
    object_id: "mapping-1",
    object_kind: "project_mapping_anchor",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-04-23T00:00:00.000Z",
    updated_at: "2026-04-23T00:00:00.000Z",
    created_by: "user",
    global_object_id: "global-1",
    project_id: "ws-1",
    workspace_id: "ws-1",
    mapping_state: "accepted",
    accepted_by: AcceptedBy.USER,
    last_transition_at: "2026-04-23T00:00:00.000Z",
    ...overrides
  };
}
