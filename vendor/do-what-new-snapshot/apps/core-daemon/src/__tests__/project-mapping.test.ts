import { describe, expect, it, vi } from "vitest";
import {
  AcceptedBy,
  ProjectMappingState,
  WorkspaceKind,
  type ProjectMappingAnchor
} from "@do-what/protocol";
import {
  EventPublisher,
  RunHotStateService,
  RunService,
  StrictConfirmationRequired,
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
  createUnusedSurfaceService,
  createUnusedSynthesisService
} from "./helpers/mock-services.js";
import { SseManager } from "../sse/sse-manager.js";

describe("project mapping routes", () => {
  it("lists anchors for a workspace with an optional mapping_state filter", async () => {
    const anchor = createProjectMappingAnchor();
    const { app, projectMappingService } = createTestContext({
      findByWorkspace: vi.fn(async () => [anchor])
    });
    const workspace = await createWorkspace(app, "project-mapping-list");

    const response = await app.request(
      `/soul/project-mapping-anchors?workspace_id=${workspace.workspace_id}&mapping_state=suggested`
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        anchors: [anchor],
        total: 1
      }
    });
    expect(projectMappingService.findByWorkspace).toHaveBeenCalledWith(
      workspace.workspace_id,
      ProjectMappingState.SUGGESTED
    );
  });

  it("creates anchors from snake_case request fields", async () => {
    const anchor = createProjectMappingAnchor();
    const { app, projectMappingService } = createTestContext({
      suggest: vi.fn(async () => anchor)
    });
    const workspace = await createWorkspace(app, "project-mapping-create");

    const response = await app.request("/soul/project-mapping-anchors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        global_object_id: anchor.global_object_id,
        workspace_id: workspace.workspace_id
      })
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        anchor
      }
    });
    expect(projectMappingService.suggest).toHaveBeenCalledWith(
      anchor.global_object_id,
      workspace.workspace_id,
      "user"
    );
  });

  it("defaults accepted_by to user for accept transitions", async () => {
    const anchor = createProjectMappingAnchor({
      mapping_state: ProjectMappingState.ACCEPTED,
      accepted_by: AcceptedBy.USER
    });
    const { app, projectMappingService } = createTestContext({
      accept: vi.fn(async () => anchor)
    });

    const response = await app.request("/soul/project-mapping-anchors/mapping-1/transition", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "accept"
      })
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        anchor
      }
    });
    expect(projectMappingService.accept).toHaveBeenCalledWith("mapping-1", AcceptedBy.USER);
  });

  it("returns 422 with strictIds when batch accept requires per-item confirmation", async () => {
    const { app, projectMappingService } = createTestContext({
      batchAccept: vi.fn(async () => {
        throw new StrictConfirmationRequired(["mapping-2"]);
      })
    });
    const workspace = await createWorkspace(app, "project-mapping-batch");

    const response = await app.request("/soul/project-mapping-anchors/batch-accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mapping_ids: ["mapping-1", "mapping-2"],
        workspace_id: workspace.workspace_id
      })
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Strict confirmation required",
      strictIds: ["mapping-2"]
    });
    expect(projectMappingService.batchAccept).toHaveBeenCalledWith(
      ["mapping-1", "mapping-2"],
      AcceptedBy.USER
    );
  });

  it("uses the default localhost CORS origin when ALLOWED_ORIGIN is unset", async () => {
    const originalAllowedOrigin = process.env.ALLOWED_ORIGIN;
    delete process.env.ALLOWED_ORIGIN;

    try {
      const { app } = createTestContext();
      const workspace = await createWorkspace(app, "project-mapping-cors-default");

      const response = await app.request(
        `/soul/project-mapping-anchors?workspace_id=${workspace.workspace_id}`,
        {
          headers: { origin: "http://localhost:5173" }
        }
      );

      expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    } finally {
      if (originalAllowedOrigin === undefined) {
        delete process.env.ALLOWED_ORIGIN;
      } else {
        process.env.ALLOWED_ORIGIN = originalAllowedOrigin;
      }
    }
  });

  it("uses ALLOWED_ORIGIN for CORS when configured", async () => {
    const originalAllowedOrigin = process.env.ALLOWED_ORIGIN;
    process.env.ALLOWED_ORIGIN = "https://staging.example.com";

    try {
      const { app } = createTestContext();
      const workspace = await createWorkspace(app, "project-mapping-cors-env");

      const response = await app.request(
        `/soul/project-mapping-anchors?workspace_id=${workspace.workspace_id}`,
        {
          headers: { origin: "https://staging.example.com" }
        }
      );

      expect(response.headers.get("access-control-allow-origin")).toBe("https://staging.example.com");
    } finally {
      if (originalAllowedOrigin === undefined) {
        delete process.env.ALLOWED_ORIGIN;
      } else {
        process.env.ALLOWED_ORIGIN = originalAllowedOrigin;
      }
    }
  });

  it("does not register project mapping routes when the service is absent", async () => {
    const { app } = createTestContext(undefined, { omitProjectMappingService: true });

    const response = await app.request("/soul/project-mapping-anchors?workspace_id=ws-1");

    expect(response.status).toBe(404);
  });
});

type ProjectMappingServiceStub = {
  readonly findByWorkspace: ReturnType<typeof vi.fn>;
  readonly suggest: ReturnType<typeof vi.fn>;
  readonly accept: ReturnType<typeof vi.fn>;
  readonly reject: ReturnType<typeof vi.fn>;
  readonly adapt: ReturnType<typeof vi.fn>;
  readonly setNotApplicable: ReturnType<typeof vi.fn>;
  readonly setProbationary: ReturnType<typeof vi.fn>;
  readonly batchAccept: ReturnType<typeof vi.fn>;
};

function createTestContext(
  overrides?: Partial<ProjectMappingServiceStub>,
  options?: {
    readonly omitProjectMappingService?: boolean;
  }
): {
  readonly app: ReturnType<typeof createApp>;
  readonly database: StorageDatabase;
  readonly projectMappingService: ProjectMappingServiceStub;
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
  const projectMappingService: ProjectMappingServiceStub = {
    findByWorkspace: vi.fn(async () => []),
    suggest: vi.fn(async () => createProjectMappingAnchor()),
    accept: vi.fn(async () => createProjectMappingAnchor()),
    reject: vi.fn(async () => createProjectMappingAnchor({ mapping_state: ProjectMappingState.REJECTED })),
    adapt: vi.fn(async () => createProjectMappingAnchor({ mapping_state: ProjectMappingState.ADAPTED })),
    setNotApplicable: vi.fn(async () =>
      createProjectMappingAnchor({ mapping_state: ProjectMappingState.NOT_APPLICABLE })
    ),
    setProbationary: vi.fn(async () =>
      createProjectMappingAnchor({ mapping_state: ProjectMappingState.PROBATIONARY })
    ),
    batchAccept: vi.fn(async () => [createProjectMappingAnchor({ mapping_state: ProjectMappingState.ACCEPTED })]),
    ...overrides
  };

  const services: CoreDaemonServices = {
    workspaceService,
    runService,
    conversationService: createNoopConversationService("project mapping route tests") as never,
    engineBindingService: createStubEngineBindingService() as never,
    runHotStateService,
    sseManager,
    signalService: createUnusedSignalService("project mapping route tests") as never,
    evidenceService: createUnusedEvidenceService("project mapping route tests") as never,
    memoryService: createUnusedMemoryService("project mapping route tests") as never,
    slotService: createUnusedSlotService("project mapping route tests") as never,
    surfaceService: createUnusedSurfaceService("project mapping route tests") as never,
    synthesisService: createUnusedSynthesisService("project mapping route tests") as never,
    claimService: createUnusedClaimService("project mapping route tests") as never,
    proposalService: createUnusedProposalService("project mapping route tests") as never,
    ...(options?.omitProjectMappingService === true ? {} : { projectMappingService: projectMappingService as never })
  };

  return {
    app: createApp(services),
    database,
    projectMappingService
  };
}

function createProjectMappingAnchor(
  overrides: Partial<ProjectMappingAnchor> = {}
): ProjectMappingAnchor {
  return {
    object_id: "mapping-1",
    object_kind: "project_mapping_anchor",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-28T00:00:00.000Z",
    updated_at: "2026-03-28T00:00:00.000Z",
    created_by: "user",
    global_object_id: "global-1",
    project_id: "ws-1",
    workspace_id: "ws-1",
    mapping_state: ProjectMappingState.SUGGESTED,
    accepted_by: null,
    last_transition_at: "2026-03-28T00:00:00.000Z",
    ...overrides
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
  const body = await response.json();
  return body.data;
}
