import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary({
    ownedTemporaryFixtures: true,
    descendantPreload: new URL("../../../../../../scripts/test-support/provider-free/provider-free-cli-bootstrap.mjs", import.meta.url).href
  });
});
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { initDatabase, type StorageDatabase } from "@do-soul/alaya-storage";
import { BackgroundServiceManager } from "../../../background/bootstrap.js";
import { createDaemonLifecycleControls } from "../../../runtime/daemon/lifecycle/daemon-runtime-lifecycle.js";
import { acquireTemporalRuntimeLease } from "../../../runtime/temporal-cutover/lease.js";

const NativeDatabase = createRequire(import.meta.url)("better-sqlite3") as new (filename: string) => StorageDatabase["connection"];
afterEach(() => expect(isolation.violations).toEqual([]));
afterAll(() => isolation.restore());

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

async function fixture(options: {
  backgroundTask?: () => Promise<void>;
  manualPass?: () => Promise<void>;
  closeEmbeddingProvider?: () => Promise<void>;
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "alaya-garden-quiescence-"));
  const filename = join(directory, "alaya.db");
  const lease = await acquireTemporalRuntimeLease(filename);
  const database = initDatabase({ filename });
  database.connection.exec("CREATE TABLE garden_shutdown_probe(value TEXT NOT NULL)");
  const manager = new BackgroundServiceManager(options.backgroundTask === undefined ? [] : [
    { name: "writer", intervalMs: 2, task: options.backgroundTask }
  ], { logger: { warn: () => undefined } });
  const warn = vi.fn();
  const controls = createDaemonLifecycleControls({
    app: { fetch: async () => new Response("ok") },
    lifecycleState: { drainState: { isDraining: false }, inFlight: { count: 0 } },
    warnLogger: { warn },
    gardenBacklogTelemetryService: { start: () => undefined, stop: async () => undefined },
    gardenRuntime: {
      backgroundManager: { start: () => manager.start(), stop: () => manager.stop({ timeoutMs: 1 }),
        whenIdle: () => manager.whenIdle() },
      setBacklogTelemetryObserver: () => undefined,
      runBackgroundPass: options.manualPass ?? (async () => undefined),
      runBulkEnrichPass: options.manualPass ?? (async () => undefined),
      runEmbeddingBackfillPass: options.manualPass ?? (async () => undefined)
    },
    securityStatusService: { close: () => undefined },
    daemonMcpRuntimeRegistry: { close: async () => undefined },
    globalMemoryRecallInvalidationSubscription: null,
    closeEmbeddingProvider: options.closeEmbeddingProvider,
    database,
    temporalRuntimeLease: lease,
    requestProtection: { allowedOrigin: "http://localhost:5173", requestToken: "fixture", tokenSource: "env" }
  });
  return { filename, directory, lease, database, controls, warn };
}

it("keeps a timed-out scheduled writer fenced after later cleanup fails and shutdown is retried", async () => {
  const blocked = gate();
  let entered = false;
  let db!: StorageDatabase;
  let embeddingCloses = 0;
  const f = await fixture({
    backgroundTask: async () => {
      entered = true;
      await blocked.promise;
      db.connection.prepare("INSERT INTO garden_shutdown_probe VALUES (?)").run("scheduled");
    },
    closeEmbeddingProvider: async () => { if (++embeddingCloses === 1) throw new Error("close failed"); }
  });
  db = f.database;
  try {
    f.controls.startBackgroundServices();
    await vi.waitFor(() => expect(entered).toBe(true));
    await expect(f.controls.shutdown()).rejects.toThrow("close failed");
    await expect(acquireTemporalRuntimeLease(f.filename)).rejects.toThrow("must be stopped");
    const retry = f.controls.shutdown();
    await vi.waitFor(() => expect(f.warn).toHaveBeenCalledWith("waiting for garden background drain before sqlite close", {}));
    expect(f.database.isClosed()).toBe(false);
    await expect(acquireTemporalRuntimeLease(f.filename)).rejects.toThrow("must be stopped");
    blocked.release();
    await retry;
    const reader = new NativeDatabase(f.filename);
    expect(reader.prepare("SELECT value FROM garden_shutdown_probe").all()).toEqual([{ value: "scheduled" }]);
    reader.close();
    const successor = await acquireTemporalRuntimeLease(f.filename);
    await successor.release();
  } finally {
    blocked.release();
    await f.controls.shutdown().catch(() => undefined);
    await f.lease.release();
    rmSync(f.directory, { recursive: true, force: true });
  }
});

it.each(["background", "bulk", "embedding"] as const)("drains accepted manual %s work and refuses later passes", async kind => {
  const blocked = gate();
  let entered = false;
  let db!: StorageDatabase;
  const f = await fixture({ manualPass: async () => {
    entered = true;
    await blocked.promise;
    db.connection.prepare("INSERT INTO garden_shutdown_probe VALUES (?)").run(kind);
  } });
  db = f.database;
  try {
    const accepted = kind === "background" ? f.controls.runGardenBackgroundPass()
      : kind === "bulk" ? f.controls.runGardenBulkEnrichPass("workspace")
      : f.controls.runGardenEmbeddingBackfillPass("workspace");
    await vi.waitFor(() => expect(entered).toBe(true));
    const shutdown = f.controls.shutdown();
    await expect(f.controls.runGardenBackgroundPass()).rejects.toThrow("shutdown has started");
    await expect(f.controls.runGardenBulkEnrichPass("workspace")).rejects.toThrow("shutdown has started");
    await expect(f.controls.runGardenEmbeddingBackfillPass("workspace")).rejects.toThrow("shutdown has started");
    await expect(acquireTemporalRuntimeLease(f.filename)).rejects.toThrow("must be stopped");
    expect(f.database.isClosed()).toBe(false);
    blocked.release();
    await accepted;
    await shutdown;
    const reader = new NativeDatabase(f.filename);
    expect(reader.prepare("SELECT value FROM garden_shutdown_probe").all()).toEqual([{ value: kind }]);
    reader.close();
  } finally {
    blocked.release();
    await f.controls.shutdown().catch(() => undefined);
    await f.lease.release();
    rmSync(f.directory, { recursive: true, force: true });
  }
});
