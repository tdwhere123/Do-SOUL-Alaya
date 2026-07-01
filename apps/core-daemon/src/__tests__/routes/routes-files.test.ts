import { Hono } from "hono";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { CoreError } from "@do-soul/alaya-core";
import type { EventLogEntry, FileRecord } from "@do-soul/alaya-protocol";
import { registerFileRoutes } from "../../routes/files.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn()
  };
});

const mockedReadFile = vi.mocked(readFile);
const mockedWriteFile = vi.mocked(writeFile);
const mockedMkdir = vi.mocked(mkdir);

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
    runtimeNotifier: {
      notifyEntry: vi.fn()
    },
    filesDirectory: "/data/files"
  });
  return app;
}

function buildUploadApp(createWithEvent = vi.fn()) {
  const app = new Hono();
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
    runtimeNotifier: {
      notifyEntry: vi.fn()
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
    mockedMkdir.mockReset();
    mockedWriteFile.mockResolvedValue(undefined);
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
    const createWithEvent = vi.fn(async (record: FileRecord) => ({
      record,
      event: { event_id: "evt-1" } as EventLogEntry
    }));
    const app = buildUploadApp(createWithEvent);
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
