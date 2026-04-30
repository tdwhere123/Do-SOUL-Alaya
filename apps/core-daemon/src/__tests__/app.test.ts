import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";

describe("createApp", () => {
  it("requires a timing-safe request token for mutating routes", async () => {
    const app = createApp({
      requestProtection: {
        allowedOrigin: "http://localhost:5173",
        requestToken: "secret-token"
      }
    });

    const missing = await app.request("/unknown", {
      method: "POST",
      headers: {
        origin: "http://localhost:5173"
      }
    });
    expect(missing.status).toBe(403);
    await expect(missing.json()).resolves.toEqual({
      success: false,
      error: "X-Request-Token is required"
    });

    const wrong = await app.request("/unknown", {
      method: "POST",
      headers: {
        origin: "http://localhost:5173",
        "x-request-token": "wrong-token"
      }
    });
    expect(wrong.status).toBe(403);
    await expect(wrong.json()).resolves.toEqual({
      success: false,
      error: "Invalid X-Request-Token"
    });
  });

  it("exposes request token only to allowed local origins", async () => {
    const app = createApp({
      requestProtection: {
        allowedOrigin: "http://localhost:5173",
        requestToken: "secret-token"
      }
    });

    const response = await app.request("/session/request-token", {
      headers: {
        origin: "http://localhost:5173"
      }
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        request_token: "secret-token"
      }
    });
  });
});
