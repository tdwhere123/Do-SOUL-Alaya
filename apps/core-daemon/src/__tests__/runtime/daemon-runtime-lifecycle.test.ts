import { describe, expect, it, vi } from "vitest";
import { createDaemonLifecycleControls } from "../../runtime/daemon-runtime-lifecycle.js";

function createControls(tokenSource: "env" | "ephemeral") {
  const warn = vi.fn();
  const controls = createDaemonLifecycleControls({
    app: { fetch: async () => new Response("ok") },
    lifecycleState: {
      drainState: { isDraining: false },
      inFlight: { count: 0 }
    },
    warnLogger: { warn },
    gardenBacklogTelemetryService: {
      start: vi.fn(),
      stop: vi.fn(async () => undefined)
    },
    gardenRuntime: {
      backgroundManager: {
        start: vi.fn(),
        stop: vi.fn(async () => undefined)
      },
      setBacklogTelemetryObserver: vi.fn(),
      runBackgroundPass: vi.fn(async () => undefined),
      runEmbeddingBackfillPass: vi.fn(async () => undefined)
    },
    securityStatusService: { close: vi.fn() },
    daemonMcpRuntimeRegistry: { close: vi.fn(async () => undefined) },
    globalMemoryRecallInvalidationSubscription: null,
    database: { close: vi.fn() },
    requestProtection: {
      allowedOrigin: "http://localhost:5173",
      requestToken: "secret-token",
      tokenSource
    }
  });

  return { controls, warn };
}

describe("createDaemonLifecycleControls", () => {
  it("fails closed for ephemeral request tokens unless explicitly allowed", async () => {
    const { controls } = createControls("ephemeral");

    await expect(controls.startHttpServer({ port: 0 })).rejects.toThrow(
      "ALAYA_REQUEST_TOKEN must be set before starting the daemon HTTP server"
    );
  });

  it("allows managed ephemeral request tokens when explicitly requested", async () => {
    const { controls, warn } = createControls("ephemeral");

    const server = await controls.startHttpServer({
      port: 0,
      allowEphemeralRequestToken: true
    });

    expect(server.port).toBeGreaterThanOrEqual(0);
    expect(warn).toHaveBeenCalledWith(
      "starting managed daemon with ephemeral request token",
      expect.objectContaining({
        host: "127.0.0.1"
      })
    );

    await server.close();
  });
});
