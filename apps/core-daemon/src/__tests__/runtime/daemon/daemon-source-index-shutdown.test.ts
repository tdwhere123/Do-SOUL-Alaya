import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { initDatabase } from "@do-soul/alaya-storage";
import { createSourceIndexProducer } from "../../../runtime/source-index/source-index-producer.js";
import { createCoreDaemonLifecycleState, createDaemonLifecycleControls } from "../../../runtime/daemon/lifecycle/daemon-runtime-lifecycle.js";
import { fixture, publishSource, WORKSPACE } from "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";

describe("idle source index shutdown", () => {
  it("settles a real lexical pass before closing SQLite and releasing the runtime lease", async () => {
    const directory = mkdtempSync(join(tmpdir(), "daemon-idle-source-shutdown-"));
    const filename = join(directory, "source.db");
    const environment = fixture(filename);
    publishSource(environment, "native source for lexical preparation", "shutdown-source");
    const order: string[] = [];
    const bindSourceEmbedding = vi.fn(async () => ({ status: "unsupported" as const, reason: "provider_disabled" as const }));
    const producer = createSourceIndexProducer({ database: environment.database, bindSourceEmbedding, warn: vi.fn() });
    const stop = producer.stop.bind(producer);
    vi.spyOn(producer, "stop").mockImplementation(async () => { await stop(); order.push("source-settled"); });
    const controls = createDaemonLifecycleControls({
      app: { fetch: async () => new Response("ok") },
      lifecycleState: createCoreDaemonLifecycleState(),
      warnLogger: { warn: vi.fn() },
      gardenBacklogTelemetryService: { start: vi.fn(), stop: vi.fn(async () => undefined) },
      gardenRuntime: {
        backgroundManager: { start: vi.fn(), stop: vi.fn(async () => undefined) },
        setBacklogTelemetryObserver: vi.fn(), runBackgroundPass: vi.fn(async () => undefined),
        runBulkEnrichPass: vi.fn(async () => undefined), runEmbeddingBackfillPass: vi.fn(async () => undefined)
      },
      securityStatusService: { close: vi.fn() },
      daemonMcpRuntimeRegistry: { close: vi.fn(async () => undefined) },
      globalMemoryRecallInvalidationSubscription: null,
      sourceIndexProducer: producer,
      database: { close: () => { order.push("database-closed"); environment.database.close(); } },
      temporalRuntimeLease: { release: async () => { order.push("lease-released"); } },
      requestProtection: { requestToken: "fixture-token", tokenSource: "env", allowedOrigin: "http://localhost" }
    });
    try {
      const pass = controls.runSourceIndexLexicalPass(WORKSPACE, "segmented-unicode61.v1");
      await controls.shutdown();
      await pass;
      expect(order).toEqual(["source-settled", "database-closed", "lease-released"]);
      expect(environment.database.isClosed()).toBe(true);
      expect(bindSourceEmbedding).not.toHaveBeenCalled();
      const reopened = initDatabase({ filename });
      expect(reopened.connection.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      reopened.close();
    } finally {
      await producer.stop();
      if (!environment.database.isClosed()) environment.database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
