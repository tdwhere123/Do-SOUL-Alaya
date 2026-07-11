import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFixedWindowRateLimitMiddleware } from "../../middleware/rate-limit.js";
import { createApiSecurityHeadersMiddleware } from "../../middleware/security-headers.js";
import {
  isProtectedRequest,
  registerRateLimitMiddleware,
  registerSecurityHeadersMiddleware
} from "../../middleware/register-security-middleware.js";

vi.mock("@hono/node-server/conninfo", () => ({
  getConnInfo: vi.fn()
}));

import { getConnInfo } from "@hono/node-server/conninfo";

const mockedGetConnInfo = vi.mocked(getConnInfo);

describe("security middleware", () => {
  beforeEach(() => {
    mockedGetConnInfo.mockReset();
  });

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

  it("keys authenticated rate limits by token and socket", async () => {
    mockedGetConnInfo.mockReturnValue({ remote: { address: "203.0.113.10" } } as never);

    const app = new Hono();
    registerRateLimitMiddleware(app, {
      maxRequests: 1,
      windowMs: 60_000,
      nowMs: () => 1_000
    });
    app.get("/api/example", (context) => context.json({ ok: true }));

    const headersA = { "x-request-token": "token-a" };
    const headersB = { "x-request-token": "token-b" };

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

  it("ignores spoofed x-forwarded-for when no request token is present", async () => {
    mockedGetConnInfo.mockReturnValue({ remote: { address: undefined } } as never);

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

    const headersA = { "x-forwarded-for": "203.0.113.1" };
    const headersB = { "x-forwarded-for": "198.51.100.2" };

    expect((await app.request("/api/example", { headers: headersA })).status).toBe(200);
    expect((await app.request("/api/example", { headers: headersB })).status).toBe(429);
  });

  it("keys unauthenticated rate limits by socket remote address", async () => {
    mockedGetConnInfo
      .mockReturnValueOnce({ remote: { address: "203.0.113.10" } } as never)
      .mockReturnValueOnce({ remote: { address: "203.0.113.11" } } as never)
      .mockReturnValueOnce({ remote: { address: "203.0.113.10" } } as never)
      .mockReturnValueOnce({ remote: { address: "203.0.113.11" } } as never);

    const app = new Hono();
    registerRateLimitMiddleware(app, {
      maxRequests: 1,
      windowMs: 60_000,
      nowMs: () => 1_000
    });
    app.get("/api/example", (context) => context.json({ ok: true }));

    expect((await app.request("/api/example")).status).toBe(200);
    expect((await app.request("/api/example")).status).toBe(200);
    expect((await app.request("/api/example")).status).toBe(429);
    expect((await app.request("/api/example")).status).toBe(429);
  });

  it("evicts oldest rate-limit buckets when capacity is exceeded", async () => {
    let keyCounter = 0;
    const app = new Hono();
    app.use(
      "*",
      createFixedWindowRateLimitMiddleware({
        maxRequests: 1,
        windowMs: 60_000,
        maxBuckets: 2,
        nowMs: () => 1_000,
        resolveKey: () => `client-${++keyCounter}`
      })
    );
    app.get("/api/example", (context) => context.json({ ok: true }));

    expect((await app.request("/api/example")).status).toBe(200);
    expect((await app.request("/api/example")).status).toBe(200);
    expect((await app.request("/api/example")).status).toBe(200);

    keyCounter = 0;
    expect((await app.request("/api/example")).status).toBe(200);
  });
});
