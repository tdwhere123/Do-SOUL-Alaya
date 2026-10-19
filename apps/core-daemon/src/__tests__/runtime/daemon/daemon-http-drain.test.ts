import { EventEmitter, once } from "node:events";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { serve } from "@hono/node-server";
import { closeCachedDatabase, initDatabase } from "@do-soul/alaya-storage";
import { describe, expect, it, vi } from "vitest";
import { removeTempDirectorySync } from "../../../../../../packages/storage/src/__tests__/temp-directory.js";
import { createApp } from "../../../runtime/app.js";
import { defaultLifecycleTimerPort } from "../../../runtime/daemon/lifecycle/daemon-runtime-timing.js";
import {
  createCoreDaemonLifecycleState,
  createDaemonLifecycleControls
} from "../../../runtime/daemon/lifecycle/daemon-runtime-lifecycle.js";

type LifecycleInput = Parameters<typeof createDaemonLifecycleControls>[0];

function createHttpLifecycle(
  fetch: LifecycleInput["app"]["fetch"],
  database: LifecycleInput["database"],
  serverFactory: NonNullable<LifecycleInput["serverFactory"]>,
  overrides: Partial<LifecycleInput> = {}
) {
  const processPort = Object.assign(new EventEmitter(), { exit: vi.fn() });
  return createDaemonLifecycleControls({
    app: { fetch },
    lifecycleState: createCoreDaemonLifecycleState(),
    warnLogger: { warn: vi.fn() },
    gardenBacklogTelemetryService: { start() {}, async stop() {} },
    gardenRuntime: {
      backgroundManager: { start() {}, async stop() {} },
      setBacklogTelemetryObserver() {},
      async runBackgroundPass() {},
      async runBulkEnrichPass() {},
      async runEmbeddingBackfillPass() {}
    },
    securityStatusService: { close() {} },
    daemonMcpRuntimeRegistry: { async close() {} },
    globalMemoryRecallInvalidationSubscription: null,
    database,
    requestProtection: {
      allowedOrigin: "http://localhost:5173",
      requestToken: "test-token",
      tokenSource: "env"
    },
    processPort,
    serverFactory,
    ...overrides
  });
}

describe("daemon HTTP drain before SQLite disposal", () => {
  it("keeps SQLite open until a real active HTTP response finishes and the server closes", async () => {
    const root = mkdtempSync(join(tmpdir(), "alaya-http-drain-"));
    const databasePath = join(root, "alaya.db");
    const database = initDatabase({ filename: databasePath });
    const order: string[] = [];
    let finishResponse!: () => void;
    let responseFinished = false;
    let httpServer!: Server;
    let closeStarted!: () => void;
    const closingStarted = new Promise<void>((resolve) => { closeStarted = resolve; });
    const controls = createHttpLifecycle(
      () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("started "));
          finishResponse = () => {
            if (responseFinished) return;
            responseFinished = true;
            // Response work can outlive the fetch/middleware's in-flight count.
            database.connection.prepare("SELECT 1 AS ok").get();
            order.push("response");
            controller.enqueue(new TextEncoder().encode("finished"));
            controller.close();
          };
        }
      })),
      { close() { order.push("sqlite"); database.close(); } },
      (options) => {
        httpServer = serve(options) as Server;
        httpServer.once("close", () => { order.push("http"); });
        const nativeClose = httpServer.close.bind(httpServer);
        vi.spyOn(httpServer, "close").mockImplementation((...args) => {
          closeStarted();
          return nativeClose(...args);
        });
        return httpServer;
      }
    );
    let shutdown: Promise<void> | undefined;
    let body: Promise<string> | undefined;
    try {
      await controls.startHttpServer({ hostname: "127.0.0.1", port: 0 });
      const address = httpServer.address();
      if (address === null || typeof address === "string") throw new Error("missing HTTP port");
      const response = await fetch(`http://127.0.0.1:${address.port}/`, {
        headers: { Connection: "close" }
      });
      body = response.text();
      shutdown = controls.shutdown();
      await closingStarted;
      await nextTurn();
      expect(database.isClosed()).toBe(false);
      expect(order).toEqual([]);
      finishResponse();
      expect(await body).toBe("started finished");
      await shutdown;
      expect(order).toEqual(["response", "http", "sqlite"]);
      expect(database.isClosed()).toBe(true);
    } finally {
      if (!database.isClosed()) finishResponse?.();
      httpServer?.closeAllConnections();
      await body?.catch(() => undefined);
      await shutdown;
      if (!database.isClosed()) database.close();
      closeCachedDatabase(databasePath);
      removeTempDirectorySync(root);
    }
  });

  it("closes timed-out HTTP transport but awaits tracked handler completion before disposing resources", async () => {
    const root = mkdtempSync(join(tmpdir(), "alaya-http-handler-drain-"));
    const databasePath = join(root, "alaya.db");
    const database = initDatabase({ filename: databasePath });
    const lifecycleState = createCoreDaemonLifecycleState();
    const app = createApp({ requestProtection: {
      allowedOrigin: "http://localhost:5173", requestToken: "test-token"
    } }, lifecycleState);
    let releaseHandler!: () => void;
    const handlerGate = new Promise<void>((resolve) => { releaseHandler = resolve; });
    const order: string[] = [];
    app.get("/work", async (context) => {
      await handlerGate;
      database.connection.prepare("SELECT 1 AS ok").get();
      order.push("handler");
      return context.text("finished");
    });
    let httpServer!: Server;
    const securityStatusService = { close: vi.fn() };
    const controls = createHttpLifecycle(app.fetch,
      { close() { order.push("sqlite"); database.close(); } },
      (options) => { httpServer = serve(options) as Server; return httpServer; },
      { lifecycleState, securityStatusService,
        // Accelerate only lifecycle deadlines; HTTP and SQLite remain real.
        timerPort: { ...defaultLifecycleTimerPort, now: () => Date.now() * 100,
          setTimeout: (callback, ms) => setTimeout(callback, Math.max(1, ms / 100)) } }
    );
    let shutdown: Promise<void> | undefined;
    let response: Promise<unknown> | undefined;
    let shutdownFinished = false;
    try {
      await controls.startHttpServer({ hostname: "127.0.0.1", port: 0 });
      const address = httpServer.address();
      if (address === null || typeof address === "string") throw new Error("missing HTTP port");
      response = fetch(`http://127.0.0.1:${address.port}/work`, {
        headers: { origin: "http://localhost:5173", "x-request-token": "test-token" }
      }).then((result) => result.text()).catch((error: unknown) => error);
      await vi.waitFor(() => expect(lifecycleState.inFlight.count).toBe(1));
      const transportClosed = once(httpServer, "close");
      shutdown = controls.shutdown().then(() => { shutdownFinished = true; });
      await transportClosed;
      expect(await response).toBeInstanceOf(TypeError);
      await nextTurn();
      expect(lifecycleState.drainState.forced).toBe(true);
      expect(lifecycleState.inFlight.count).toBe(1);
      expect((await app.request("/work")).status).toBe(503);
      expect(database.isClosed()).toBe(false);
      expect(securityStatusService.close).not.toHaveBeenCalled();
      expect(shutdownFinished).toBe(false);
      releaseHandler();
      await shutdown;
      expect(lifecycleState.inFlight.count).toBe(0);
      expect(order).toEqual(["handler", "sqlite"]);
      expect(database.isClosed()).toBe(true);
      expect(securityStatusService.close).toHaveBeenCalledTimes(1);
    } finally {
      releaseHandler();
      httpServer?.closeAllConnections();
      await (shutdown ?? controls.shutdown());
      await response;
      if (!database.isClosed()) database.close();
      closeCachedDatabase(databasePath);
      removeTempDirectorySync(root);
    }
  });

  it("does not dispose SQLite when the HTTP close callback reports failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "alaya-http-close-error-"));
    const databasePath = join(root, "alaya.db");
    const database = initDatabase({ filename: databasePath });
    const failure = new Error("HTTP close callback failed");
    const controls = createHttpLifecycle(
      async () => new Response("ok"),
      database,
      () => ({ close(callback) { callback?.(failure); } })
    );
    try {
      await controls.startHttpServer({ hostname: "127.0.0.1", port: 0 });
      await expect(controls.shutdown()).rejects.toBe(failure);
      expect(database.isClosed()).toBe(false);
      expect(database.connection.prepare("SELECT 1 AS ok").get()).toEqual({ ok: 1 });
    } finally {
      database.close();
      closeCachedDatabase(databasePath);
      removeTempDirectorySync(root);
    }
  });
});
