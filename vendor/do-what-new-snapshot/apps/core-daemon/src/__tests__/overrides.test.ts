import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { CoreError } from "@do-what/core";
import { RetentionPolicy } from "@do-what/protocol";
import { registerErrorHandler } from "../middleware/error-handler.js";
import { registerOverrideRoutes } from "../routes/overrides.js";

describe("override routes", () => {
  it("creates a session override for an existing run", async () => {
    const runService = {
      getById: vi.fn(async () => ({ run_id: "run-1", workspace_id: "workspace-1" }))
    };
    const sessionOverrideService = {
      apply: vi.fn(async () => ({
        runtime_id: "11111111-1111-4111-8111-111111111111",
        object_kind: "session_override",
        task_surface_ref: null,
        expires_at: "2026-03-24T01:00:00.000Z",
        derived_from: null,
        retention_policy: RetentionPolicy.SESSION_ONLY,
        scope: "session_only",
        target_object: "memory:build-style",
        correction: "Use pnpm instead of npm.",
        priority: 2
      }))
    };
    const app = createApp(runService, sessionOverrideService);

    const response = await app.request("/runs/run-1/overrides", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target_object: "memory:build-style",
        correction: "Use pnpm instead of npm.",
        priority: 2
      })
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: {
        runtime_id: "11111111-1111-4111-8111-111111111111",
        object_kind: "session_override",
        target_object: "memory:build-style",
        correction: "Use pnpm instead of npm.",
        priority: 2
      }
    });
    expect(sessionOverrideService.apply).toHaveBeenCalledWith({
      runId: "run-1",
      workspaceId: "workspace-1",
      targetObject: "memory:build-style",
      correction: "Use pnpm instead of npm.",
      priority: 2
    });
  });

  it("returns 404 for unknown runs", async () => {
    const app = createApp(
      {
        getById: vi.fn(async () => {
          throw new CoreError("NOT_FOUND", "Run not found");
        })
      },
      {
        apply: vi.fn(async () => {
          throw new Error("should not be called");
        })
      }
    );

    const response = await app.request("/runs/run-missing/overrides", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target_object: "memory:build-style",
        correction: "Use pnpm instead of npm."
      })
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Resource not found"
    });
  });

  it("returns 400 when target_object is missing", async () => {
    const app = createApp(
      {
        getById: vi.fn(async () => ({ run_id: "run-1", workspace_id: "workspace-1" }))
      },
      {
        apply: vi.fn(async () => {
          throw new Error("should not be called");
        })
      }
    );

    const response = await app.request("/runs/run-1/overrides", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        correction: "Use pnpm instead of npm."
      })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Invalid override payload"
    });
  });

  it("returns 400 when correction is missing", async () => {
    const app = createApp(
      {
        getById: vi.fn(async () => ({ run_id: "run-1", workspace_id: "workspace-1" }))
      },
      {
        apply: vi.fn(async () => {
          throw new Error("should not be called");
        })
      }
    );

    const response = await app.request("/runs/run-1/overrides", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target_object: "memory:build-style"
      })
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: "Invalid override payload"
    });
  });
});

function createApp(runService: { getById: ReturnType<typeof vi.fn> }, sessionOverrideService: { apply: ReturnType<typeof vi.fn> }) {
  const app = new Hono();
  registerErrorHandler(app);
  registerOverrideRoutes(app, {
    runService: runService as any,
    sessionOverrideService: sessionOverrideService as any
  });
  return app;
}
