import { describe, expect, it } from "vitest";
import { createInspectorApp } from "../../runtime/app.js";
import { authenticatedRequest } from "../app/routes-test-utils.js";

describe("forwardStructuredError", () => {
  it("forwards catalog copy and rejects unknown daemon messages", async () => {
    const secret = "sk-test-leaked-secret";
    const app = createInspectorApp({
      token: "token",
      workspaceId: "ws1",
      daemonUrl: "http://daemon.local",
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.endsWith("/review")) {
          return Response.json(
            {
              success: false,
              error: { code: "VALIDATION", message: `Invalid input: received "${secret}"` }
            },
            { status: 400 }
          );
        }
        return Response.json({ success: true, data: { ok: true } });
      }
    });

    const leaked = await authenticatedRequest(app, "/api/proposals/ws1/prop-1/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        verdict: "accept",
        reason: "looks right",
        reviewer_identity: "user:local-reviewer"
      })
    });
    expect(leaked.status).toBe(400);
    const leakedText = await leaked.text();
    expect(leakedText).toBe("{\"error\":\"daemon_400\"}");
    expect(leakedText).not.toContain(secret);
    expect(leakedText).not.toContain("received");

    const allowedApp = createInspectorApp({
      token: "token",
      workspaceId: "ws1",
      daemonUrl: "http://daemon.local",
      fetchImpl: async () =>
        Response.json(
          {
            success: false,
            error: { code: "VALIDATION", message: "Invalid reviewer token." }
          },
          { status: 400 }
        )
    });
    const allowed = await authenticatedRequest(allowedApp, "/api/proposals/ws1/prop-1/review", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        verdict: "accept",
        reason: "looks right",
        reviewer_identity: "user:local-reviewer"
      })
    });
    expect(allowed.status).toBe(400);
    await expect(allowed.json()).resolves.toEqual({
      success: false,
      error: { code: "VALIDATION", message: "Invalid reviewer token." }
    });
  });
});
