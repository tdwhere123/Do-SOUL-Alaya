import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { CoreError } from "@do-what/core";
import { EngineError, EngineErrorKind } from "@do-what/protocol";
import { registerErrorHandler } from "../middleware/error-handler.js";

describe("error handler", () => {
  it("sanitizes engine errors before returning them to the client", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = new Hono();

    registerErrorHandler(app);
    app.get("/engine-error", () => {
      const error = new EngineError(
        "provider failed against https://internal.example/v1",
        EngineErrorKind.RATE_LIMIT
      );
      error.cause = new Error("upstream secret cause from https://internal.example/v1");
      throw error;
    });

    try {
      const response = await app.request("/engine-error");

      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toEqual({
        success: false,
        error: "The conversation provider rate limit was reached.",
        kind: EngineErrorKind.RATE_LIMIT
      });
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[daemon] sanitized engine error",
        expect.objectContaining({
          kind: EngineErrorKind.RATE_LIMIT,
          messageRedacted: true,
          causeName: "Error",
          causeRedacted: true,
          publicMessage: "The conversation provider rate limit was reached."
        })
      );
      expect(JSON.stringify(consoleErrorSpy.mock.calls[0]?.[1])).not.toContain(
        "https://internal.example/v1"
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("keeps explicit safe validation messages but hides field-level validation details", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = new Hono();

    registerErrorHandler(app);
    app.get("/safe-validation", () => {
      throw new CoreError("VALIDATION", "Invalid override payload");
    });
    app.get("/hidden-validation", () => {
      throw new CoreError(
        "VALIDATION",
        "worker dispatch field denied_tool_categories is invalid",
        {
          cause: new Error("validator detail denied_tool_categories failed")
        }
      );
    });

    try {
      const safeResponse = await app.request("/safe-validation");
      expect(safeResponse.status).toBe(400);
      await expect(safeResponse.json()).resolves.toEqual({
        success: false,
        error: "Invalid override payload"
      });

      const hiddenResponse = await app.request("/hidden-validation");
      expect(hiddenResponse.status).toBe(400);
      await expect(hiddenResponse.json()).resolves.toEqual({
        success: false,
        error: "Invalid request"
      });
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        "[daemon] sanitized core validation error",
        expect.objectContaining({
          code: "VALIDATION",
          messageRedacted: true,
          causeName: "Error",
          causeRedacted: true,
          publicMessage: "Invalid request"
        })
      );
      const hiddenLogPayload = JSON.stringify(consoleErrorSpy.mock.calls[0]?.[1]);
      expect(hiddenLogPayload).not.toContain("denied_tool_categories");
      expect(hiddenLogPayload).not.toContain("validator detail");
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
