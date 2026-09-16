import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerErrorHandler } from "../../middleware/error-handler.js";
import { boundedPathParams, readBoundedPathParam } from "../../middleware/bounded-path-params.js";

describe("boundedPathParams", () => {
  it("accepts a bounded path id and rejects empty or oversized values with 400", async () => {
    const app = new Hono();
    registerErrorHandler(app, { error: vi.fn() });
    app.get("/files/:id", boundedPathParams("id"), (context) => {
      return context.json({ success: true, id: readBoundedPathParam(context, "id") }, 200);
    });

    const ok = await app.request("/files/file-1");
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toEqual({ success: true, id: "file-1" });

    const empty = await app.request("/files/%20");
    expect(empty.status).toBe(400);
    await expect(empty.json()).resolves.toEqual({ success: false, error: "Invalid id" });

    const oversized = await app.request(`/files/${"a".repeat(257)}`);
    expect(oversized.status).toBe(400);
    await expect(oversized.json()).resolves.toEqual({ success: false, error: "Invalid id" });
  });

  it("validates every matched path param when names are omitted", async () => {
    const app = new Hono();
    registerErrorHandler(app, { error: vi.fn() });
    app.use("*", boundedPathParams());
    app.get("/workspaces/:wsId/proposals", (context) => {
      return context.json({ success: true, id: context.req.param("wsId") }, 200);
    });

    const ok = await app.request("/workspaces/ws-1/proposals");
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toEqual({ success: true, id: "ws-1" });

    const empty = await app.request("/workspaces/%20/proposals");
    expect(empty.status).toBe(400);
    await expect(empty.json()).resolves.toEqual({ success: false, error: "Invalid wsId" });

    const oversized = await app.request(`/workspaces/${"a".repeat(257)}/proposals`);
    expect(oversized.status).toBe(400);
    await expect(oversized.json()).resolves.toEqual({ success: false, error: "Invalid wsId" });
  });
});
