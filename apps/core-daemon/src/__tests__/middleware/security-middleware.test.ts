import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createFixedWindowRateLimitMiddleware } from "../../middleware/rate-limit.js";
import { createApiSecurityHeadersMiddleware } from "../../middleware/security-headers.js";
import {
  isProtectedRequest,
  registerRateLimitMiddleware,
  registerSecurityHeadersMiddleware
} from "../../middleware/register-security-middleware.js";

describe("security middleware", () => {
  it("applies CSP and frame protections on responses", async () => {
    const app = new Hono();
    registerSecurityHeadersMiddleware(app);
    app.get("/api/example", (context) => context.json({ ok: true }));

    const response = await app.request("/api/example");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("returns 429 when the fixed-window rate limit is exceeded", async () => {
    const app = new Hono();
    app.use(
      "*",
      createFixedWindowRateLimitMiddleware({
        maxRequests: 1,
        windowMs: 60_000,
        nowMs: () => 1_000
      })
    );
    app.get("/api/example", (context) => context.json({ ok: true }));

    expect((await app.request("/api/example")).status).toBe(200);
    const limited = await app.request("/api/example");
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toEqual({
      success: false,
      error: "Rate limit exceeded"
    });
  });

  it("keys protected rate limits by request token only", async () => {
    const app = new Hono();
    registerRateLimitMiddleware(app, {
      maxRequests: 1,
      windowMs: 60_000,
      nowMs: () => 1_000
    });
    app.get("/api/example", (context) => context.json({ ok: true }));

    const headersA = { "x-request-token": "token-a" };
    const headersB = { "x-request-token": "token-b", "x-forwarded-for": "203.0.113.1" };

    expect((await app.request("/api/example", { headers: headersA })).status).toBe(200);
    expect((await app.request("/api/example", { headers: headersB })).status).toBe(200);
    expect((await app.request("/api/example", { headers: headersA })).status).toBe(429);
    expect((await app.request("/api/example", { headers: headersB })).status).toBe(429);
  });

  it("skips rate limiting for health checks and OPTIONS requests", () => {
    expect(isProtectedRequest("GET", "/health")).toBe(false);
    expect(isProtectedRequest("OPTIONS", "/api/example")).toBe(false);
    expect(isProtectedRequest("GET", "/api/example")).toBe(true);
  });
});
