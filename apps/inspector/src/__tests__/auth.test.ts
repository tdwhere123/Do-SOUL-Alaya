import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { constantTimeTokenEqual, createInspectorAuthMiddleware } from "../auth.js";

describe("inspector auth", () => {
  it("rejects missing and wrong tokens", async () => {
    const app = createApp();

    await expectStatus(app, "/", 401);
    await expectStatus(app, "/?token=wrong", 401);
    await expectStatus(app, "/", 401, { "x-alaya-inspector-token": "wrong" });
  });

  it("accepts query or header tokens without echoing them", async () => {
    const app = createApp();

    const queryResponse = await app.request("/?token=secret-token");
    const headerResponse = await app.request("/", {
      headers: { "x-alaya-inspector-token": "secret-token" }
    });

    expect(queryResponse.status).toBe(200);
    expect(headerResponse.status).toBe(200);
    expect(await queryResponse.text()).not.toContain("secret-token");
    expect(await headerResponse.text()).not.toContain("secret-token");
  });

  it("uses length-safe constant-time comparison", () => {
    expect(constantTimeTokenEqual("secret-token", "secret-token")).toBe(true);
    expect(constantTimeTokenEqual("secret-token", "secret-token-2")).toBe(false);
    expect(constantTimeTokenEqual("short", "a-much-longer-token")).toBe(false);
  });
});

function createApp(): Hono {
  const app = new Hono();
  app.use("*", createInspectorAuthMiddleware("secret-token"));
  app.get("/", (context) => context.json({ ok: true }));
  return app;
}

async function expectStatus(app: Hono, path: string, status: number, headers?: HeadersInit): Promise<void> {
  const response = await app.request(path, { headers });
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error: "unauthorized" });
}
