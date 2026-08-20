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

  it("rate-limits consecutive invalid redeems and resets on success", async () => {
    let now = 1_000;
    const store = createInspectorLaunchSessionStore(() => now);
    const app = new Hono();
    registerInspectorLaunchSessionRoutes(app, store, {
      maxConsecutiveFailures: 3,
      windowMs: 60_000,
      nowMs: () => now
    });

    await expectStatus(app, { code: "bad-1" }, 401);
    await expectStatus(app, { code: "bad-2" }, 401);
    const limited = await redeem(app, { code: "bad-3" });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    await expectStatus(app, { code: "bad-4" }, 429);

    now = 61_001;
    store.register("good-code", "secret-token");
    const success = await redeem(app, { code: "good-code" });
    expect(success.status).toBe(200);
    expect(await success.json()).toEqual({ token: "secret-token" });

    await expectStatus(app, { code: "bad-after-reset" }, 401);
  });

  it("keys failure limits by client identity", async () => {
    const store = createInspectorLaunchSessionStore();
    const app = new Hono();
    let clientKey = "client-a";
    registerInspectorLaunchSessionRoutes(app, store, {
      maxConsecutiveFailures: 2,
      windowMs: 60_000,
      resolveClientKey: () => clientKey
    });

    await expectStatus(app, { code: "bad-a1" }, 401);
    await expectStatus(app, { code: "bad-a2" }, 429);

    clientKey = "client-b";
    await expectStatus(app, { code: "bad-b1" }, 401);
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
  const response = await redeem(app, body);
  expect(response.status).toBe(status);
}

async function redeem(app: Hono, body: unknown): Promise<Response> {
  return await app.request("/api/launch-session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}
