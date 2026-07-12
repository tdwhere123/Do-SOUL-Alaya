import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { EngineError, EngineErrorKind } from "@do-soul/alaya-protocol";
import { StorageError } from "@do-soul/alaya-storage";
import { registerErrorHandler } from "../../middleware/error-handler.js";

describe("registerErrorHandler", () => {
  it("routes sanitized daemon diagnostics through the injected logger", async () => {
    const app = new Hono();
    const logger = { error: vi.fn() };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      app.use("*", async (context, next) => {
        (context as typeof context & { set(name: string, value: string): void }).set("requestId", "req-123");
        await next();
      });
      registerErrorHandler(app, logger as never);
      app.get("/engine-error", () => {
        throw new EngineError("provider leaked token abcd1234", EngineErrorKind.AUTH);
      });

      const response = await app.request("/engine-error", {
        headers: { "x-request-id": "req-123" }
      });

      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toEqual({
        success: false,
        error: "The conversation provider rejected the configured credentials.",
        kind: EngineErrorKind.AUTH
      });
      expect(logger.error).toHaveBeenCalledWith(
        "[daemon] sanitized engine error",
        expect.objectContaining({
          kind: EngineErrorKind.AUTH,
          messageRedacted: true,
          publicMessage: "The conversation provider rejected the configured credentials.",
          request_id: "req-123"
        })
      );
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("redacts unhandled exception messages before logging", async () => {
    const app = new Hono();
    const logger = { error: vi.fn() };

    app.use("*", async (context, next) => {
      (context as typeof context & { set(name: string, value: string): void }).set("requestId", "req-secret");
      await next();
    });
    registerErrorHandler(app, logger as never);
    app.get("/unhandled", () => {
      throw new Error("token abcd1234");
    });

    const response = await app.request("/unhandled");

    expect(response.status).toBe(500);
    expect(logger.error).toHaveBeenCalledWith(
      "[daemon] unhandled error",
      expect.objectContaining({
        name: "Error",
        messageRedacted: true,
        request_id: "req-secret"
      })
    );
    const loggedMeta = logger.error.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(JSON.stringify(loggedMeta)).not.toContain("abcd1234");
  });

  it("sanitizes Zod validation failures without leaking field paths", async () => {
    const app = new Hono();
    const logger = { error: vi.fn() };

    registerErrorHandler(app, logger as never);
    app.get("/zod", () => {
      z.object({ workspace_path: z.string() }).parse({ workspace_path: 1 });
      return new Response(null, { status: 204 });
    });

    const response = await app.request("/zod");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Invalid request"
    });
    expect(logger.error).toHaveBeenCalledWith(
      "[daemon] sanitized zod validation error",
      expect.objectContaining({
        name: "ZodError",
        messageRedacted: true,
        publicMessage: "Invalid request"
      })
    );
    const loggedMeta = logger.error.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(JSON.stringify(loggedMeta)).not.toContain("workspace_path");
  });

  it("maps structured storage conflicts without exposing storage details", async () => {
    const app = new Hono();
    const logger = { error: vi.fn() };

    registerErrorHandler(app, logger as never);
    app.get("/storage-conflict", () => {
      throw new StorageError("DUPLICATE_KEY", "sqlite detail must stay private");
    });

    const response = await app.request("/storage-conflict");

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Request conflict"
    });
    expect(logger.error).toHaveBeenCalledWith(
      "[daemon] sanitized storage error",
      expect.objectContaining({ code: "DUPLICATE_KEY", messageRedacted: true })
    );
    expect(JSON.stringify(logger.error.mock.calls[0]?.[1])).not.toContain("sqlite detail");
  });
});
