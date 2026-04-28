import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Phase5EventType, WorkspaceKind, type EventLogEntry, type FileRecord } from "@do-what/protocol";
import {
  EventPublisher,
  RunHotStateService,
  RunService,
  WorkspaceService
} from "@do-what/core";
import {
  SqliteEventLogRepo,
  SqliteFileRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  initDatabase,
  type FileRepo,
  type StorageDatabase
} from "@do-what/storage";
import { createApp } from "../app.js";
import { SseManager } from "../sse/sse-manager.js";
import {
  configureWorkspacePrincipalCodingEngine,
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

interface TestFileRepo extends FileRepo {
  readonly create: ReturnType<typeof vi.fn>;
  readonly createWithEvent: ReturnType<typeof vi.fn>;
  readonly findById: ReturnType<typeof vi.fn>;
  readonly findByRunId: ReturnType<typeof vi.fn>;
  readonly findByWorkspaceId: ReturnType<typeof vi.fn>;
}

interface TestContext {
  readonly app: ReturnType<typeof createApp>;
  readonly database: StorageDatabase;
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly fileRepo: TestFileRepo;
  readonly filesDirectory: string;
  readonly sseManager: SseManager;
}

const databases = new Set<StorageDatabase>();
const tempDirectories = new Set<string>();
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

afterEach(async () => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();

  for (const directory of tempDirectories) {
    await rm(directory, { recursive: true, force: true });
  }

  tempDirectories.clear();
});

describe("files routes", () => {
  it("uploads a file with MIME fallback from extension, derives workspace_id from run_id, and serves it back with safe download headers", async () => {
    const { app, eventLogRepo, fileRepo, filesDirectory, sseManager } = await createTestContext();
    const workspace = await createWorkspace(app, "files-workspace");
    const run = await createRun(app, workspace.workspace_id, "files-run");
    const broadcastSpy = vi.spyOn(sseManager, "broadcastEntry");

    const formData = new FormData();
    formData.set(
      "file",
      new File(["console.log('hello');\n"], "résumé.ts", {
        type: "application/octet-stream"
      })
    );
    formData.set("run_id", run.run_id);

    const uploadResponse = await app.request("/files", {
      method: "POST",
      body: formData
    });

    expect(uploadResponse.status).toBe(201);
    const uploadBody = (await uploadResponse.json()) as any;
    expect(uploadBody).toEqual({
      success: true,
      data: {
        file_id: expect.any(String),
        filename: "résumé.ts",
        mime_type: "text/plain",
        size_bytes: 22
      }
    });

    expect(fileRepo.createWithEvent).toHaveBeenCalledTimes(1);
    expect(fileRepo.create).not.toHaveBeenCalled();
    const [createdRecord, eventDraft] = fileRepo.createWithEvent.mock.calls[0] as [
      Readonly<FileRecord>,
      Record<string, unknown>
    ];
    expect(createdRecord).toMatchObject({
      filename: "résumé.ts",
      mime_type: "text/plain",
      workspace_id: workspace.workspace_id,
      run_id: run.run_id
    });
    expect(eventDraft).toMatchObject({
      event_type: Phase5EventType.FILE_UPLOADED,
      entity_type: "file",
      entity_id: uploadBody.data.file_id,
      workspace_id: workspace.workspace_id,
      run_id: run.run_id,
      caused_by: "user_action",
      payload_json: {
        file_id: uploadBody.data.file_id,
        filename: "résumé.ts",
        mime_type: "text/plain",
        size_bytes: 22,
        workspace_id: workspace.workspace_id,
        run_id: run.run_id
      }
    });

    const storedRecord = await fileRepo.findById(uploadBody.data.file_id);
    expect(storedRecord).not.toBeNull();
    expect(storedRecord).toMatchObject({
      file_id: uploadBody.data.file_id,
      workspace_id: workspace.workspace_id,
      run_id: run.run_id
    });

    const storedBytes = await readFile(join(filesDirectory, storedRecord!.storage_path), "utf8");
    expect(storedBytes).toBe("console.log('hello');\n");

    const events = await eventLogRepo.queryByEntity("file", uploadBody.data.file_id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: Phase5EventType.FILE_UPLOADED,
      entity_type: "file",
      entity_id: uploadBody.data.file_id,
      workspace_id: workspace.workspace_id,
      run_id: run.run_id,
      payload_json: {
        file_id: uploadBody.data.file_id,
        filename: "résumé.ts",
        mime_type: "text/plain",
        size_bytes: 22,
        workspace_id: workspace.workspace_id,
        run_id: run.run_id
      }
    });

    expect(broadcastSpy).toHaveBeenCalledTimes(1);
    expect(broadcastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: Phase5EventType.FILE_UPLOADED,
        entity_id: uploadBody.data.file_id,
        workspace_id: workspace.workspace_id,
        run_id: run.run_id
      })
    );

    const getResponse = await app.request(`/files/${uploadBody.data.file_id}`);
    expect(getResponse.status).toBe(200);
    expect(getResponse.headers.get("content-type")).toContain("text/plain");
    expect(getResponse.headers.get("x-content-type-options")).toBe("nosniff");
    expect(getResponse.headers.get("content-disposition")).toBe(
      `attachment; filename="r_sum_.ts"; filename*=UTF-8''r%C3%A9sum%C3%A9.ts`
    );
    await expect(getResponse.text()).resolves.toBe("console.log('hello');\n");
  });

  it("rejects a workspace_id that does not match the run's workspace", async () => {
    const { app, fileRepo, filesDirectory } = await createTestContext();
    const workspaceA = await createWorkspace(app, "files-workspace-a");
    const workspaceB = await createWorkspace(app, "files-workspace-b");
    const run = await createRun(app, workspaceA.workspace_id, "files-run");

    const formData = new FormData();
    formData.set("file", new File(["mismatch"], "notes.txt", { type: "text/plain" }));
    formData.set("run_id", run.run_id);
    formData.set("workspace_id", workspaceB.workspace_id);

    const response = await app.request("/files", {
      method: "POST",
      body: formData
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "workspace_id does not match the run workspace"
    });
    expect(fileRepo.create).not.toHaveBeenCalled();
    expect(fileRepo.createWithEvent).not.toHaveBeenCalled();
    await expect(readdir(filesDirectory)).resolves.toEqual([]);
  });

  it("rejects unsupported file types", async () => {
    const { app } = await createTestContext();

    const unsupportedFormData = new FormData();
    unsupportedFormData.set("file", new File(["abc"], "song.mp3", { type: "audio/mpeg" }));

    const unsupportedResponse = await app.request("/files", {
      method: "POST",
      body: unsupportedFormData
    });

    expect(unsupportedResponse.status).toBe(422);
    await expect(unsupportedResponse.json()).resolves.toEqual({
      success: false,
      error: "Unsupported file type"
    });
  });

  it("rejects direct text/html uploads even when extension is otherwise safe", async () => {
    const { app } = await createTestContext();
    const workspace = await createWorkspace(app, "files-html-direct-workspace");

    const formData = new FormData();
    formData.set("file", new File(["<h1>xss</h1>"], "notes.txt", { type: "text/html" }));
    formData.set("workspace_id", workspace.workspace_id);

    const response = await app.request("/files", {
      method: "POST",
      body: formData
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Unsupported file type"
    });
  });

  it("rejects generic html and htm uploads from extension fallback", async () => {
    const { app } = await createTestContext();
    const workspace = await createWorkspace(app, "files-html-workspace");

    for (const filename of ["index.html", "index.htm"]) {
      const formData = new FormData();
      formData.set("file", new File(["<h1>xss</h1>"], filename, { type: "application/octet-stream" }));
      formData.set("workspace_id", workspace.workspace_id);

      const response = await app.request("/files", {
        method: "POST",
        body: formData
      });

      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toEqual({
        success: false,
        error: "Unsupported file type"
      });
    }
  });

  it("rejects oversized uploads at the app body-limit middleware", async () => {
    const { app } = await createTestContext();
    const request = new Request("http://localhost/files", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=codex-boundary"
      },
      body: createOversizedBody(MAX_FILE_SIZE_BYTES + 1),
      duplex: "half"
    } as RequestInit);

    const oversizedResponse = await app.request(request);

    expect(oversizedResponse.status).toBe(413);
    await expect(oversizedResponse.json()).resolves.toEqual({
      success: false,
      error: "File exceeds the 20 MB limit"
    });
  });

  it("validates workspace existence when only workspace_id is provided", async () => {
    const { app, fileRepo } = await createTestContext();

    const formData = new FormData();
    formData.set("file", new File(["hello"], "notes.txt", { type: "text/plain" }));
    formData.set("workspace_id", "ws_missing");

    const response = await app.request("/files", {
      method: "POST",
      body: formData
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Resource not found"
    });
    expect(fileRepo.create).not.toHaveBeenCalled();
    expect(fileRepo.createWithEvent).not.toHaveBeenCalled();
  });

  it("returns 404 when run_id does not exist", async () => {
    const { app, fileRepo } = await createTestContext();

    const formData = new FormData();
    formData.set("file", new File(["hello"], "notes.txt", { type: "text/plain" }));
    formData.set("run_id", "run_missing");

    const response = await app.request("/files", {
      method: "POST",
      body: formData
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Resource not found"
    });
    expect(fileRepo.create).not.toHaveBeenCalled();
    expect(fileRepo.createWithEvent).not.toHaveBeenCalled();
  });

  it("requires a run_id or workspace_id so uploads stay event-log scoped", async () => {
    const { app, fileRepo, filesDirectory } = await createTestContext();

    const formData = new FormData();
    formData.set("file", new File(["hello"], "notes.txt", { type: "text/plain" }));

    const response = await app.request("/files", {
      method: "POST",
      body: formData
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "run_id or workspace_id is required"
    });
    expect(fileRepo.create).not.toHaveBeenCalled();
    expect(fileRepo.createWithEvent).not.toHaveBeenCalled();
    await expect(readdir(filesDirectory)).resolves.toEqual([]);
  });

  it("best-effort deletes the written file when persistence fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const { app, filesDirectory } = await createTestContext({
        createWithEvent: vi.fn(async () => {
          throw new Error("insert failed");
        })
      });
      const workspace = await createWorkspace(app, "files-failure-workspace");

      const formData = new FormData();
      formData.set("file", new File(["cleanup"], "cleanup.txt", { type: "text/plain" }));
      formData.set("workspace_id", workspace.workspace_id);

      const response = await app.request("/files", {
        method: "POST",
        body: formData
      });

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        success: false,
        error: "Internal server error"
      });
      await expect(readdir(filesDirectory)).resolves.toEqual([]);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("returns 404 for unknown file ids", async () => {
    const { app } = await createTestContext();

    const response = await app.request("/files/file_missing");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "File not found"
    });
  });

  it("returns 404 when the stored path escapes the files directory", async () => {
    const { app, fileRepo } = await createTestContext();
    fileRepo.findById.mockResolvedValueOnce({
      file_id: "11111111-1111-4111-8111-111111111111",
      filename: "escape.txt",
      mime_type: "text/plain",
      size_bytes: 6,
      storage_path: "../escape.txt",
      workspace_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      run_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      created_at: "2026-03-31T00:00:00.000Z"
    });

    const response = await app.request("/files/11111111-1111-4111-8111-111111111111");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "File not found"
    });
  });
});

async function createTestContext(
  overrides: {
    readonly createWithEvent?: ReturnType<typeof vi.fn>;
  } = {}
): Promise<TestContext> {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

  const filesDirectory = await mkdtemp(join(tmpdir(), "core-daemon-files-"));
  tempDirectories.add(filesDirectory);

  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const storageFileRepo = new SqliteFileRepo(database);
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
    eventPublisher,
    isPrincipalCodingEngineAvailable: () => true
  });

  const fileRepo: TestFileRepo = {
    create: vi.fn(storageFileRepo.create.bind(storageFileRepo)),
    createWithEvent: overrides.createWithEvent ?? vi.fn(storageFileRepo.createWithEvent.bind(storageFileRepo)),
    findById: vi.fn(storageFileRepo.findById.bind(storageFileRepo)),
    findByRunId: vi.fn(storageFileRepo.findByRunId.bind(storageFileRepo)),
    findByWorkspaceId: vi.fn(storageFileRepo.findByWorkspaceId.bind(storageFileRepo))
  };

  const app = createApp({
    workspaceService,
    runService,
    principalCodingEngineAvailable: true,
    conversationService: createNoopConversationService("files-route test"),
    engineBindingService: createStubEngineBindingService(),
    runHotStateService,
    sseManager,
    signalService: createUnusedSignalService("files-route test"),
    evidenceService: createUnusedEvidenceService("files-route test"),
    memoryService: createUnusedMemoryService("files-route test"),
    slotService: createUnusedSlotService("files-route test"),
    synthesisService: createUnusedSynthesisService("files-route test"),
    claimService: createUnusedClaimService("files-route test"),
    proposalService: createUnusedProposalService("files-route test"),
    fileRepo,
    filesDirectory
  });

  return {
    app,
    database,
    eventLogRepo,
    fileRepo,
    filesDirectory,
    sseManager
  };
}

async function createWorkspace(app: ReturnType<typeof createApp>, name: string): Promise<{ workspace_id: string }> {
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
  const body = (await response.json()) as any;
  const workspace = body.data;
  await configureWorkspacePrincipalCodingEngine(app, workspace.workspace_id);
  return workspace;
}

async function createRun(
  app: ReturnType<typeof createApp>,
  workspaceId: string,
  title: string
): Promise<{ run_id: string }> {
  const response = await app.request(`/workspaces/${workspaceId}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title,
      goal: "test uploads",
      run_mode: "chat"
    })
  });

  expect(response.status).toBe(201);
  const body = (await response.json()) as any;
  return body.data;
}

function createOversizedBody(size: number): ReadableStream<Uint8Array> {
  let emitted = false;

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emitted) {
        controller.close();
        return;
      }

      emitted = true;
      controller.enqueue(new Uint8Array(size));
      controller.close();
    }
  });
}
