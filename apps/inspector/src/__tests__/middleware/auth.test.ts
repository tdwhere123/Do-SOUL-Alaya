import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { constantTimeTokenEqual, createInspectorAuthMiddleware } from "../../middleware/auth.js";

describe("inspector auth", () => {
  it("rejects missing and wrong tokens", async () => {
    const app = createApp();

    await expectStatus(app, "/", 401);
    await expectStatus(app, "/?token=wrong", 401);
    await expectStatus(app, "/?token=secret-token", 401);
    await expectStatus(app, "/", 401, { "x-alaya-inspector-token": "wrong" });
  });

  it("accepts header or bearer tokens without echoing them", async () => {
    const app = createApp();

    const headerResponse = await app.request("/", {
      headers: { "x-alaya-inspector-token": "secret-token" }
    });
    const bearerResponse = await app.request("/", {
      headers: { authorization: "Bearer secret-token" }
    });

    expect(headerResponse.status).toBe(200);
    expect(bearerResponse.status).toBe(200);
    expect(await headerResponse.text()).not.toContain("secret-token");
    expect(await bearerResponse.text()).not.toContain("secret-token");
  });

  it("uses length-safe constant-time comparison", () => {
    expect(constantTimeTokenEqual("secret-token", "secret-token")).toBe(true);
    expect(constantTimeTokenEqual("secret-token", "secret-token-2")).toBe(false);
    expect(constantTimeTokenEqual("short", "a-much-longer-token")).toBe(false);
  });

  it("accepts a valid inspector session cookie without the process token", async () => {
    const sessions = new Set(["session-1"]);
    const app = new Hono();
    app.use("*", createInspectorAuthMiddleware("secret-token", {
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
    app.use("*", createInspectorAuthMiddleware("secret-token", {
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
  app.use("*", createInspectorAuthMiddleware("secret-token"));
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
