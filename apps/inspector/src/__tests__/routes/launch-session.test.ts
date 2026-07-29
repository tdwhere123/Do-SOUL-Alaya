import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createInspectorLaunchSessionStore } from "../../launch/launch-session-store.js";
import { registerInspectorLaunchSessionRoutes } from "../../routes/launch-session.js";

describe("inspector launch session", () => {
  it("redeems a one-time launch code into an inspector token", async () => {
    const app = createApp("launch-code", "secret-token");

    const response = await app.request("/api/launch-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "launch-code" })
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ token: "secret-token" });
  });

  it("rejects invalid, reused, and expired launch codes", async () => {
    let now = 1_000;
    const store = createInspectorLaunchSessionStore(() => now);
    const app = new Hono();
    registerInspectorLaunchSessionRoutes(app, store);
    store.register("expired-code", "secret-token", 1);

    await expectStatus(app, { code: "missing-code" }, 401);

    now = 1_002;
    await expectStatus(app, { code: "expired-code" }, 401);

    now = 1_010;
    store.register("single-use", "secret-token");
    const first = await app.request("/api/launch-session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "single-use" })
    });
    expect(first.status).toBe(200);
    await expectStatus(app, { code: "single-use" }, 401);
  });
});

function createApp(code: string, token: string): Hono {
  const store = createInspectorLaunchSessionStore();
  store.register(code, token);
  const app = new Hono();
  registerInspectorLaunchSessionRoutes(app, store);
  return app;
}

async function expectStatus(app: Hono, body: unknown, status: number): Promise<void> {
  const response = await app.request("/api/launch-session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  expect(response.status).toBe(status);
}
