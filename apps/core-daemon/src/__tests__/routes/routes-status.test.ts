import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { registerStatusRoutes } from "../../routes/status.js";

describe("status route", () => {
  it("returns the exported AlayaStatus envelope", async () => {
    const app = new Hono();
    registerStatusRoutes(app, {
      startupStepsProvider: () => ["database", "http-app"],
      principalCodingEngineAvailableProvider: () => true,
      mcp: {
        listAllowedServerNames: () => ["filesystem"],
        listEnrolledToolIds: () => ["tool.exec_shell", "tool.write_file"]
      },
      clock: () => "2026-04-30T00:00:00.000Z"
    });

    const response = await app.request("/status");
    const body = await response.json() as {
      success: boolean;
      data: unknown;
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      data: {
        checked_at: "2026-04-30T00:00:00.000Z",
        daemon: {
          ready: true,
          startup_steps: ["database", "http-app"],
          principal_coding_engine_available: true
        },
        mcp: {
          enrolled_tools: 2,
          allowed_servers: ["filesystem"]
        }
      }
    });
  });
});
