import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createInspectorAuthMiddleware } from "../../middleware/auth.js";

describe("inspector auth", () => {
  it("rejects missing cookies and process-token headers", async () => {
    const app = createApp();

    await expectStatus(app, "/", 401);
    await expectStatus(app, "/?token=secret-token", 401);
    await expectStatus(app, "/", 401, { "x-alaya-inspector-token": "secret-token" });
    await expectStatus(app, "/", 401, { authorization: "Bearer secret-token" });
  });

  it("accepts a valid inspector session cookie", async () => {
    const sessions = new Set(["session-1"]);
    const app = new Hono();
    app.use("*", createInspectorAuthMiddleware({
      hasSession: (sessionId) => sessions.has(sessionId)
    }));
    app.get("/", (context) => context.json({ ok: true }));

    const allowed = await app.request("/", {
      headers: { cookie: "alaya_inspector_session=session-1" }
    });
    const expired = await app.request("/", {
      headers: { cookie: "alaya_inspector_session=missing" }
    });

    expect(allowed.status).toBe(200);
    expect(expired.status).toBe(401);
  });

  it("allows only an exact public path and method", async () => {
    const app = new Hono();
    app.use("*", createInspectorAuthMiddleware({
      publicRoutes: [{ path: "/api/launch-session", method: "POST" }]
    }));
    app.all("*", (context) => context.json({ ok: true }));

    const allowed = await app.request("/api/launch-session", { method: "POST" });
    expect(allowed.status).toBe(200);

    await expectStatus(app, "/api/launch-session", 401);
    await expectStatus(app, "/api/launch-session/extra", 401, undefined, "POST");
    await expectStatus(app, "/api/launch-session-extra", 401, undefined, "POST");
  });
});

function createApp(): Hono {
  const app = new Hono();
  app.use("*", createInspectorAuthMiddleware());
  app.get("/", (context) => context.json({ ok: true }));
  return app;
}

async function expectStatus(
  app: Hono,
  path: string,
  status: number,
  headers?: Record<string, string>,
  method = "GET"
): Promise<void> {
  const response = await app.request(path, { method, headers });
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error: "unauthorized" });
}
