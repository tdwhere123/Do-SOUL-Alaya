import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { registerErrorHandler } from "../../middleware/error-handler.js";
import { registerWorkspaceRoutes } from "../../routes/workspace/workspaces.js";
import { workspaceRouteServices } from "../support/route-service-stubs.js";

const tempDirs = new Set<string>();

afterEach(async () => {
  await Promise.all(Array.from(tempDirs, async (dir) => {
    await rm(dir, { recursive: true, force: true });
  }));
  tempDirs.clear();
});

describe("workspace root_path validation", () => {
  it("rejects filesystem root, /etc, and traversal as 400", async () => {
    const allowedRoot = await mkdtemp(path.join(tmpdir(), "alaya-ws-root-"));
    tempDirs.add(allowedRoot);
    const create = vi.fn();
    const app = new Hono();
    registerErrorHandler(app, { error() {} });
    registerWorkspaceRoutes(app, workspaceRouteServices({
      workspaceService: { create },
      gitBindingValidation: { currentWorkingDirectory: allowedRoot }
    }));

    for (const rootPath of ["/", "/etc", `${allowedRoot}/../etc`]) {
      const response = await app.request("/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "unsafe",
          root_path: rootPath,
          workspace_kind: "docs_only"
        })
      });
      expect(response.status).toBe(400);
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("stores the realpath of a contained root_path", async () => {
    const allowedRoot = await mkdtemp(path.join(tmpdir(), "alaya-ws-root-"));
    tempDirs.add(allowedRoot);
    const workspaceRoot = path.join(allowedRoot, "project");
    await mkdir(workspaceRoot);
    const resolvedRoot = await realpath(workspaceRoot);
    const create = vi.fn(async (input: unknown) => {
      const rootPath = (input as { readonly root_path: string }).root_path;
      return {
        workspace_id: "ws-1",
        name: "legal",
        root_path: rootPath,
        workspace_kind: "docs_only" as const,
        repo_path: null,
        default_engine_binding: null,
        workspace_state: "active" as const,
        created_at: "2026-05-05T00:00:00.000Z",
        archived_at: null
      };
    });
    const app = new Hono();
    registerErrorHandler(app, { error() {} });
    registerWorkspaceRoutes(app, workspaceRouteServices({
      workspaceService: { create },
      gitBindingValidation: { currentWorkingDirectory: allowedRoot }
    }));

    const response = await app.request("/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "legal",
        root_path: workspaceRoot,
        workspace_kind: "docs_only"
      })
    });

    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ root_path: resolvedRoot }));
  });
});
