import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { registerSoulSearchRoutes } from "../../routes/memory/soul-search.js";

function buildApp() {
  const app = new Hono();
  const workspaceService = {
    getById: vi.fn(async (wsId: string) => ({ workspace_id: wsId }))
  };
  const handlerCalls: Array<{ toolName: string; arguments: Record<string, unknown> }> = [];
  const mcpMemoryToolHandler = {
    call: vi.fn(async (input: { toolName: string; arguments: unknown }) => {
      handlerCalls.push({
        toolName: input.toolName,
        arguments: input.arguments as Record<string, unknown>
      });
      return {
        ok: true as const,
        output: {
          delivery_id: "delivery-1",
          results: [
            { object_id: "memory-a", relevance_score: 0.9 },
            { object_id: "memory-b", relevance_score: 0.4 }
          ],
          total_count: 2
        }
      };
    })
  };
  registerSoulSearchRoutes(app, {
    workspaceService,
    mcpMemoryToolHandler
  } as never);
  return { app, workspaceService, mcpMemoryToolHandler, handlerCalls };
}

describe("POST /workspaces/:wsId/soul/search", () => {
  it("forwards text + since/until/time_field to the soul.recall MCP tool", async () => {
    const { app, mcpMemoryToolHandler, handlerCalls } = buildApp();
    const response = await app.request("/workspaces/ws-1/soul/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "what did I say on May 20",
        since: "2026-05-20T00:00:00.000Z",
        until: "2026-05-20T23:59:59.999Z",
        time_field: "created_at",
        max_results: 50
      })
    });
    expect(response.status).toBe(200);
    expect(mcpMemoryToolHandler.call).toHaveBeenCalledOnce();
    const args = handlerCalls[0]!.arguments;
    expect(args).toMatchObject({
      query: "what did I say on May 20",
      since: "2026-05-20T00:00:00.000Z",
      until: "2026-05-20T23:59:59.999Z",
      time_field: "created_at",
      max_results: 50
    });
  });

  it("rejects an empty / non-string text with 400", async () => {
    const { app, mcpMemoryToolHandler } = buildApp();
    const empty = await app.request("/workspaces/ws-1/soul/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "" })
    });
    expect(empty.status).toBe(400);
    const numeric = await app.request("/workspaces/ws-1/soul/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: 42 })
    });
    expect(numeric.status).toBe(400);
    expect(mcpMemoryToolHandler.call).not.toHaveBeenCalled();
  });

  // invariant: malformed since / until / time_field must reach the route
  // boundary as a 400, not be silently coerced to undefined and bypass the
  // recall-side schema. Phase 4 review M-VAL-1.
  it("rejects malformed since / until / time_field with 400 instead of silent coerce", async () => {
    const { app, mcpMemoryToolHandler } = buildApp();
    const badSince = await app.request("/workspaces/ws-1/soul/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "anything", since: 12345 })
    });
    expect(badSince.status).toBe(400);
    const badField = await app.request("/workspaces/ws-1/soul/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "anything", time_field: "updated_at" })
    });
    expect(badField.status).toBe(400);
    expect(mcpMemoryToolHandler.call).not.toHaveBeenCalled();
  });

  it("clamps max_results to [1, 100]", async () => {
    const { app, handlerCalls } = buildApp();
    await app.request("/workspaces/ws-1/soul/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "a", max_results: 5000 })
    });
    expect(handlerCalls[0]!.arguments.max_results).toBe(100);
    handlerCalls.length = 0;
    await app.request("/workspaces/ws-1/soul/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "a", max_results: -3 })
    });
    expect(handlerCalls[0]!.arguments.max_results).toBe(1);
  });

  it("rejects non-object body with 400", async () => {
    const { app, mcpMemoryToolHandler } = buildApp();
    const response = await app.request("/workspaces/ws-1/soul/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "[]"
    });
    expect(response.status).toBe(400);
    expect(mcpMemoryToolHandler.call).not.toHaveBeenCalled();
  });
});
