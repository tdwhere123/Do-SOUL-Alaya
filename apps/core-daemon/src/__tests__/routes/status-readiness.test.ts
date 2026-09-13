import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "../../runtime/app.js";
import { registerStatusRoutes } from "../../routes/workspace/status/status.js";

describe("daemon readiness vs liveness", () => {
  it("keeps /health ok when the database is unreachable and marks /status not ready", async () => {
    const lifecycle = {
      drainState: { isDraining: false },
      inFlight: { count: 0 }
    };
    const app = createApp(
      {
        requestProtection: {
          allowedOrigin: "http://localhost:5173",
          requestToken: "token"
        },
        routes: {
          status: {
            startupStepsProvider: () => ["database", "http-app"],
            principalCodingEngineAvailableProvider: () => true,
            probeDatabase: () => false,
            isDraining: () => false,
            mcp: {
              listAllowedServerNames: () => [],
              listEnrolledToolIds: () => [],
              getHealth: () => ({ servers: [] })
            },
            clock: () => "2026-05-05T00:00:00.000Z"
          }
        }
      },
      lifecycle
    );

    const liveness = await app.request("/health");
    const status = await app.request("/status", {
      headers: {
        "x-request-token": "token",
        "x-alaya-desktop": "1"
      }
    });
    const body = await status.json() as {
      success: boolean;
      data: { daemon: { ready: boolean; db_reachable: boolean } };
    };

    expect(liveness.status).toBe(200);
    await expect(liveness.json()).resolves.toMatchObject({ status: "ok" });
    expect(status.status).toBe(200);
    expect(body.data.daemon.db_reachable).toBe(false);
    expect(body.data.daemon.ready).toBe(false);
  });

  it("marks ready false while draining even if dependencies are healthy", async () => {
    const app = new Hono();
    registerStatusRoutes(app, {
      startupStepsProvider: () => ["http-app"],
      principalCodingEngineAvailableProvider: () => true,
      probeDatabase: () => true,
      isDraining: () => true,
      mcp: {
        listAllowedServerNames: () => [],
        listEnrolledToolIds: () => [],
        getHealth: () => ({ servers: [] })
      },
      clock: () => "2026-05-05T00:00:00.000Z"
    });

    const response = await app.request("/status");
    const body = await response.json() as {
      data: { daemon: { ready: boolean } };
    };
    expect(body.data.daemon.ready).toBe(false);
  });
});
