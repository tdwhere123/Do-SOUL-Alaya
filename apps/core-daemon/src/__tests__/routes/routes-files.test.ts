import { Hono } from "hono";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreError } from "@do-soul/alaya-core";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteFileRepo
} from "@do-soul/alaya-storage";
import {
  FileApprovalEventType,
  RuntimeGovernanceEventType,
  type EventLogEntry,
  type FileRecord
} from "@do-soul/alaya-protocol";
import { registerFileRoutes } from "../../routes/workspace/files.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn(),
    mkdir: vi.fn()
  };
});

const mockedReadFile = vi.mocked(readFile);
const mockedWriteFile = vi.mocked(writeFile);
const mockedUnlink = vi.mocked(unlink);
const mockedMkdir = vi.mocked(mkdir);
const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

function createAuditEventLogAppend() {
  return vi.fn((event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
    ...event,
    event_id: "audit-evt-1",
    created_at: "2026-05-10T00:00:00.000Z",
    revision: 0
  }));
}

function makeRecord(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    file_id: "file-1",
    filename: "notes.txt",
    mime_type: "text/plain",
    size_bytes: 12,
    storage_path: "file-1.txt",
    workspace_id: "ws-1",
    run_id: null,
    created_at: "2026-05-10T00:00:00.000Z",
    ...overrides
  };
}

function buildApp(record: FileRecord | null) {
  const app = new Hono();
  registerFileRoutes(app, {
    workspaceService: {
      getById: vi.fn(async (workspaceId: string) => ({ workspace_id: workspaceId }))
    },
    runService: {
      getById: vi.fn(async () => ({ run_id: "run-1", workspace_id: "ws-1" }))
    },
    fileRepo: {
      findById: vi.fn(async () => record)
    } as never,
    eventLogRepo: {
      append: createAuditEventLogAppend()
    },
    runtimeNotifier: {
      notifyEntry: vi.fn()
    },
    filesDirectory: "/data/files"
  });
  return app;
}

function buildUploadApp(createWithEvent = vi.fn(), notifyEntry = vi.fn(), append = createAuditEventLogAppend()) {
  const app = new Hono();
  app.onError((error, context) => context.json({ success: false, error: error.message }, 500));
  registerFileRoutes(app, {
    workspaceService: {
      getById: vi.fn(async (workspaceId: string) => ({ workspace_id: workspaceId }))
    },
    runService: {
      getById: vi.fn(async (runId: string) => ({ run_id: runId, workspace_id: "ws-1" }))
    },
    fileRepo: {
      findById: vi.fn(),
      createWithEvent
    } as never,
    eventLogRepo: {
      append
    },
    runtimeNotifier: {
      notifyEntry
    },
    filesDirectory: "/data/files"
  });
  return app;
}

function uploadFormData(fields: Record<string, string | File>): FormData {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.append(key, value);
  }
  return formData;
}

describe("files upload route", () => {
  beforeEach(() => {
    mockedWriteFile.mockReset();
    mockedUnlink.mockReset();
    mockedMkdir.mockReset();
    mockedWriteFile.mockResolvedValue(undefined);
    mockedUnlink.mockResolvedValue(undefined);
    mockedMkdir.mockResolvedValue(undefined);
  });

  it("returns 400 when file is missing", async () => {
    const app = buildUploadApp();
    const response = await app.request("/files", {
      method: "POST",
      body: uploadFormData({ workspace_id: "ws-1" })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "file is required"
    });
  });

  it("returns 422 for unsupported MIME types", async () => {
    const app = buildUploadApp();
    const response = await app.request("/files", {
      method: "POST",
      body: uploadFormData({
        file: new File(["binary"], "payload.exe", { type: "application/x-msdownload" }),
        workspace_id: "ws-1"
      })
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Unsupported file type"
    });
  });

  it("returns 400 when workspace_id and run_id are both missing", async () => {
    const app = buildUploadApp();
    const response = await app.request("/files", {
      method: "POST",
      body: uploadFormData({
        file: new File(["hello"], "notes.txt", { type: "text/plain" })
      })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "run_id or workspace_id is required"
    });
  });

  it("returns 201 with upload payload when workspace_id is provided", async () => {
    const notifyEntry = vi.fn();
    let capturedEvent: Omit<EventLogEntry, "event_id" | "created_at" | "revision"> | undefined;
    const createWithEvent = vi.fn(
      async (
        record: FileRecord,
        event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">
      ) => {
        capturedEvent = event;
        return {
      record,
      event: { event_id: "evt-1" } as EventLogEntry
        };
      }
    );
    const app = buildUploadApp(createWithEvent, notifyEntry);
    const response = await app.request("/files", {
      method: "POST",
      body: uploadFormData({
        file: new File(["hello"], "notes.txt", { type: "text/plain" }),
        workspace_id: "ws-1"
      })
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        file_id: expect.any(String),
        filename: "notes.txt",
        mime_type: "text/plain",
        size_bytes: 5
      }
    });
    expect(mockedMkdir).toHaveBeenCalledWith("/data/files", { recursive: true });
    expect(mockedWriteFile).toHaveBeenCalledOnce();
    expect(createWithEvent).toHaveBeenCalledOnce();
    expect(createWithEvent.mock.calls[0]?.[0]).toMatchObject({
      filename: "notes.txt",
      mime_type: "text/plain",
      size_bytes: 5,
      workspace_id: "ws-1",
      run_id: null
    });
    const recordArg = createWithEvent.mock.calls[0]?.[0] as FileRecord | undefined;
    const eventArg = capturedEvent;
    expect(recordArg).toBeDefined();
    expect(eventArg).toBeDefined();
    expect(eventArg).toMatchObject({
      event_type: FileApprovalEventType.FILE_UPLOADED,
      entity_type: "file",
      entity_id: recordArg?.file_id,
      workspace_id: "ws-1",
      run_id: null,
      caused_by: "user_action",
      payload_json: {
        file_id: recordArg?.file_id,
        filename: "notes.txt",
        mime_type: "text/plain",
        size_bytes: 5,
        workspace_id: "ws-1",
        run_id: null
      }
    });
    expect(notifyEntry).toHaveBeenCalledWith({ event_id: "evt-1" });
    expect(mockedUnlink).not.toHaveBeenCalled();
  });

  it("deletes the written file when durable persistence fails", async () => {
    const createWithEvent = vi.fn(async () => {
      throw new Error("database write failed");
    });
    const app = buildUploadApp(createWithEvent);
    const response = await app.request("/files", {
      method: "POST",
      body: uploadFormData({
        file: new File(["hello"], "notes.txt", { type: "text/plain" }),
        workspace_id: "ws-1"
      })
    });

    expect(response.status).toBe(500);
    expect(mockedWriteFile).toHaveBeenCalledOnce();
    expect(createWithEvent).toHaveBeenCalledOnce();
    expect(mockedUnlink).toHaveBeenCalledWith(mockedWriteFile.mock.calls[0]?.[0]);
  });

  it("keeps the written file when post-commit notification fails", async () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const append = createAuditEventLogAppend();
    const notifyEntry = vi.fn(async () => {
      throw new Error("notifier unavailable");
    });
    const createWithEvent = vi.fn(async (record: FileRecord) => ({
      record,
      event: { event_id: "evt-1" } as EventLogEntry
    }));
    const app = buildUploadApp(createWithEvent, notifyEntry, append);

    const response = await app.request("/files", {
      method: "POST",
      body: uploadFormData({
        file: new File(["hello"], "notes.txt", { type: "text/plain" }),
        workspace_id: "ws-1"
      })
    });

    expect(response.status).toBe(201);
    expect(mockedWriteFile).toHaveBeenCalledOnce();
    expect(createWithEvent).toHaveBeenCalledOnce();
    expect(notifyEntry).toHaveBeenCalledWith({ event_id: "evt-1" });
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: RuntimeGovernanceEventType.RUNTIME_SIDE_EFFECT_FAILED,
        entity_type: "file",
        entity_id: expect.any(String),
        workspace_id: "ws-1",
        caused_by: "user_action",
        payload_json: expect.objectContaining({
          source: "daemon.files.upload",
          operation: "runtime_notify",
          committed_event_id: "evt-1",
          error_message: "notifier unavailable"
        })
      })
    );
    expect(mockedUnlink).not.toHaveBeenCalled();
    emitWarning.mockRestore();
  });

  it("persists notifier failures through the real SQLite event log", async () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const database = initDatabase({ filename: ":memory:" });
    databases.add(database);
    const eventLogRepo = new SqliteEventLogRepo(database);
    const app = new Hono();
    registerFileRoutes(app, {
      workspaceService: {
        getById: vi.fn(async (workspaceId: string) => ({ workspace_id: workspaceId }))
      },
      runService: {
        getById: vi.fn(async (runId: string) => ({ run_id: runId, workspace_id: "ws-1" }))
      },
      fileRepo: new SqliteFileRepo(database),
      eventLogRepo,
      runtimeNotifier: {
        notifyEntry: vi.fn(async () => {
          throw new Error("notifier unavailable");
        })
      },
      filesDirectory: "/data/files"
    });

    const response = await app.request("/files", {
      method: "POST",
      body: uploadFormData({
        file: new File(["hello"], "notes.txt", { type: "text/plain" }),
        workspace_id: "ws-1"
      })
    });
    const body = await response.json() as {
      readonly data: { readonly file_id: string };
    };
    const events = await eventLogRepo.queryByEntity("file", body.data.file_id);
    const failureEvent = events.find(
      (event) => event.event_type === RuntimeGovernanceEventType.RUNTIME_SIDE_EFFECT_FAILED
    );

    expect(response.status).toBe(201);
    expect(failureEvent).toMatchObject({
      event_type: RuntimeGovernanceEventType.RUNTIME_SIDE_EFFECT_FAILED,
      entity_type: "file",
      entity_id: body.data.file_id,
      workspace_id: "ws-1",
      caused_by: "user_action",
      payload_json: expect.objectContaining({
        source: "daemon.files.upload",
        operation: "runtime_notify",
        error_message: "notifier unavailable"
      })
    });
    emitWarning.mockRestore();
  });
});

describe("files download route", () => {
  beforeEach(() => {
    mockedReadFile.mockReset();
  });

  it("requires workspace_id query parameter", async () => {
    const app = buildApp(makeRecord());
    const response = await app.request("/files/file-1");
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "workspace_id is required"
    });
  });

  it("returns 404 when the workspace is unknown", async () => {
    const app = new Hono();
    registerFileRoutes(app, {
      workspaceService: {
        getById: vi.fn(async () => {
          throw new CoreError("NOT_FOUND", "workspace ws-missing not found");
        })
      },
      runService: { getById: vi.fn() },
      fileRepo: { findById: vi.fn(async () => makeRecord()) } as never,
      eventLogRepo: { append: createAuditEventLogAppend() },
      runtimeNotifier: { notifyEntry: vi.fn() },
      filesDirectory: "/data/files"
    });

    const response = await app.request("/files/file-1?workspace_id=ws-missing");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "File not found"
    });
  });

  it("returns 404 when the file record belongs to another workspace", async () => {
    const app = buildApp(makeRecord({ workspace_id: "ws-other" }));
    const response = await app.request("/files/file-1?workspace_id=ws-1");
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "File not found"
    });
  });

  it("streams the stored file for a matching workspace and file id", async () => {
    mockedReadFile.mockResolvedValueOnce(Buffer.from("hello world"));
    const app = buildApp(makeRecord());
    const response = await app.request("/files/file-1?workspace_id=ws-1");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    expect(await response.text()).toBe("hello world");
    expect(mockedReadFile).toHaveBeenCalledWith("/data/files/file-1.txt");
  });

  it("maps ENOENT read failures to 404", async () => {
    mockedReadFile.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));
    const app = buildApp(makeRecord());
    const response = await app.request("/files/file-1?workspace_id=ws-1");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "File not found"
    });
  });

  it("maps EACCES read failures to 403", async () => {
    mockedReadFile.mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
    const app = buildApp(makeRecord());
    const response = await app.request("/files/file-1?workspace_id=ws-1");

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "File access denied"
    });
  });
});
