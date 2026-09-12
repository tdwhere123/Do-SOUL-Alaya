import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeCachedDatabase, initDatabase } from "@do-soul/alaya-storage";
import { removeTempDirectorySync } from "../../../../../../packages/storage/src/__tests__/temp-directory.js";
import {
  createCoreDaemonLifecycleState,
  createDaemonLifecycleControls
} from "../../../runtime/daemon/lifecycle/daemon-runtime-lifecycle.js";

type ExitMock = ReturnType<typeof vi.fn> & ((code?: number) => void);

type FakeSignalProcess = EventEmitter & {
  exitCode?: number | string | null;
  exit: ExitMock;
};

const temporaryRoots: string[] = [];

afterEach(() => {
  while (temporaryRoots.length > 0) {
    removeTempDirectorySync(temporaryRoots.pop()!);
  }
});

function createFakeSignalProcess(): FakeSignalProcess {
  const emitter = new EventEmitter() as FakeSignalProcess;
  emitter.exitCode = undefined;
  emitter.exit = vi.fn() as ExitMock;
  return emitter;
}

async function allocateEphemeralPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  if (port <= 0) {
    throw new Error("failed to allocate an ephemeral port");
  }
  return port;
}

async function waitForHttp(url: string): Promise<Response> {
  const deadline = Date.now() + 5_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await fetch(url);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function isPortFree(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const tester = createServer()
      .once("error", () => resolve(false))
      .once("listening", () => {
        tester.close(() => resolve(true));
      })
      .listen(port, "127.0.0.1");
  });
}

describe("daemon HTTP shutdown authenticity", () => {
  it("releases the listening port and closes SQLite after a real serve() shutdown", async () => {
    const directory = mkdtempSync(join(tmpdir(), "alaya-daemon-shutdown-"));
    temporaryRoots.push(directory);
    const databasePath = join(directory, "alaya.db");
    const database = initDatabase({ filename: databasePath });
    const probe = database.connection.prepare("SELECT 1 AS ok").get() as { readonly ok: number };
    expect(probe.ok).toBe(1);

    const port = await allocateEphemeralPort();
    const processPort = createFakeSignalProcess();
    const controls = createDaemonLifecycleControls({
      app: { fetch: async () => new Response("ok") },
      lifecycleState: createCoreDaemonLifecycleState(),
      warnLogger: { warn: vi.fn() },
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
        runBulkEnrichPass: vi.fn(async () => undefined),
        runEmbeddingBackfillPass: vi.fn(async () => undefined)
      },
      securityStatusService: { close: vi.fn() },
      daemonMcpRuntimeRegistry: { close: vi.fn(async () => undefined) },
      globalMemoryRecallInvalidationSubscription: null,
      database,
      requestProtection: {
        allowedOrigin: "http://localhost:5173",
        requestToken: "secret-token",
        tokenSource: "env"
      },
      processPort
    });

    try {
      await controls.startHttpServer({ hostname: "127.0.0.1", port });
      const response = await waitForHttp(`http://127.0.0.1:${port}/`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");

      await controls.shutdown();

      await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
      expect(await isPortFree(port)).toBe(true);
      expect(database.isClosed()).toBe(true);
    } finally {
      if (!database.isClosed()) {
        database.close();
      }
      closeCachedDatabase(databasePath);
    }
  });
});
