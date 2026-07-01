import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { CoreError } from "@do-soul/alaya-core";
import type { FileRecord } from "@do-soul/alaya-protocol";
import { registerFileRoutes } from "../../routes/files.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn()
  };
});

const mockedReadFile = vi.mocked(readFile);

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
