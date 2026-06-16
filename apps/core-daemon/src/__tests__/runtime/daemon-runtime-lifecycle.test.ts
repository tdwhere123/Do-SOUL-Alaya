import { describe, expect, it, vi } from "vitest";
import { createDaemonLifecycleControls } from "../../runtime/daemon-runtime-lifecycle.js";

function createControls(
  tokenSource: "env" | "ephemeral",
  overrides: Partial<{
    runBackgroundPass: ReturnType<typeof vi.fn>;
    runBulkEnrichPass: ReturnType<typeof vi.fn>;
    runEmbeddingBackfillPass: ReturnType<typeof vi.fn>;
  }> = {}
) {
  const warn = vi.fn();
  const runBackgroundPass =
    overrides.runBackgroundPass ?? vi.fn(async () => undefined);
  const runBulkEnrichPass =
    overrides.runBulkEnrichPass ?? vi.fn(async () => undefined);
  const runEmbeddingBackfillPass =
    overrides.runEmbeddingBackfillPass ?? vi.fn(async () => undefined);
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
      runBackgroundPass,
      runBulkEnrichPass,
      runEmbeddingBackfillPass
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

  return { controls, warn, runBackgroundPass, runBulkEnrichPass, runEmbeddingBackfillPass };
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

  it("waits for the startup pass before running targeted bulk enrich", async () => {
    let resolveStartup: (() => void) | undefined;
    const runBackgroundPass = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveStartup = resolve;
        })
    );
    const runBulkEnrichPass = vi.fn(async () => undefined);
    const { controls } = createControls("env", {
      runBackgroundPass,
      runBulkEnrichPass
    });

    controls.startBackgroundServices();
    const targetedDrain = controls.runGardenBulkEnrichPass("workspace-1");

    expect(runBulkEnrichPass).not.toHaveBeenCalled();
    resolveStartup?.();
    await targetedDrain;

    expect(runBackgroundPass).toHaveBeenCalledTimes(1);
    expect(runBulkEnrichPass).toHaveBeenCalledWith("workspace-1");
  });
});
