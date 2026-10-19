import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  const bootstrap = new URL("../../../../../bench-runner/src/__tests__/support/provider-free-cli-bootstrap.mjs", import.meta.url).href;
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `${previous ?? ""} --import=${bootstrap}`.trim();
  return { ...installProviderFreeBoundary(), previous };
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => {
  isolation.restore();
  if (isolation.previous === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = isolation.previous;
});
import { LocalOnnxEmbeddingClient } from "@do-soul/alaya-core";
import { SqliteEventLogRepo, SqliteMemoryEntryRepo } from "@do-soul/alaya-storage";
import { createForkLocalOnnxEmbeddingHost, type LocalOnnxEmbeddingIpcHost } from "../../../../../../packages/core/src/embedding-recall/local-onnx-process/ipc-client.js";
import type { LocalOnnxEmbeddingIpcRequest, LocalOnnxEmbeddingIpcSuccess } from "../../../../../../packages/core/src/embedding-recall/local-onnx-process/protocol.js";
import { fixture, publishSource, WORKSPACE } from "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { createDaemonEmbeddingRuntime } from "../../../ai/daemon-embedding-runtime.js";
import { createSourceIndexProducer } from "../../../runtime/source-index/source-index-producer.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function isolatedChild(hold: "source" | "binding") {
  const inner = createForkLocalOnnxEmbeddingHost(fileURLToPath(new URL(
    "../../../../../../packages/core/src/__tests__/embedding-recall/local-onnx-embedding-ipc-stub-child.mjs", import.meta.url)));
  const running = deferred(), unrelatedReturned = deferred(), exited = deferred();
  const requests = new Map<number, LocalOnnxEmbeddingIpcRequest>();
  const kills: Array<NodeJS.Signals | undefined> = [];
  let releaseUnrelated: (() => void) | undefined;
  let spawns = 0;
  const host: LocalOnnxEmbeddingIpcHost = { spawn() {
    spawns++;
    const child = inner.spawn();
    child.on("exit", () => exited.resolve());
    return new Proxy(child, { get(target, property, receiver) {
      if (property === "kill") return (signal?: NodeJS.Signals) => { kills.push(signal); return target.kill(signal); };
      if (property === "send") return (request: LocalOnnxEmbeddingIpcRequest, callback?: (error: Error | null) => void) => {
        requests.set(request.id, structuredClone(request));
        return target.send(request, callback);
      };
      if (property === "on") return (event: string, listener: (value: unknown) => void) => {
        if (event !== "message") return Reflect.apply(target.on, target, [event, listener]);
        return target.on("message", message => {
          if ((message as { fixture?: string }).fixture === "source_running") { running.resolve(); return; }
          const request = requests.get((message as LocalOnnxEmbeddingIpcSuccess).id);
          if (hold === "binding" && request?.op === "bind_source") { running.resolve(); return; }
          if (request?.op === "embed" && request.texts?.[0] === "unrelated") {
            releaseUnrelated = () => listener(message); unrelatedReturned.resolve(); return;
          }
          listener(message);
        });
      };
      return Reflect.get(target, property, receiver);
    } });
  } };
  return { host, running: running.promise, unrelatedReturned: unrelatedReturned.promise,
    release: () => releaseUnrelated?.(), kills, exited: exited.promise, requests, spawns: () => spawns };
}

// Actual child/IPC plus file SQLite and daemon binding. Fixture vectors are not real-model readiness.
it.each(["stop", "deadline", "binding"] as const)("keeps shared IPC requests alive through producer %s and reaps only on provider close", async kind => {
  const directory = mkdtempSync(join(tmpdir(), "source-index-isolation-"));
  const environment = fixture(join(directory, "index.sqlite"));
  const child = isolatedChild(kind === "binding" ? "binding" : "source");
  const provider = new LocalOnnxEmbeddingClient({ ipcHost: child.host });
  const runtime = createDaemonEmbeddingRuntime({ database: environment.database,
    configEnv: new Map([["ALAYA_ENABLE_EMBEDDING_SUPPLEMENT", "true"], ["ALAYA_EMBEDDING_PROVIDER", "local_onnx"]]),
    eventLogRepo: new SqliteEventLogRepo(environment.database), memoryEntryRepo: new SqliteMemoryEntryRepo(environment.database),
    runtimeNotifier: { notifyEntry: () => undefined }, healthJournalService: {
      getRecentEvents: async () => [], record: async () => undefined
    }, warn: vi.fn(), embeddingProviderOverride: provider });
  const producer = createSourceIndexProducer({ database: environment.database,
    bindSourceEmbedding: options => runtime.bindLocalSourceIndex(options), warn: vi.fn(),
    limits: { stepDeadlineMs: kind === "stop" ? 5000 : 100, intervalMs: 60_000 } });
  try {
    await expect(runtime.providerWarmup).resolves.toBe("ready");
    publishSource(environment, "__delay_exit__");
    const pass = producer.runPass();
    await child.running;
    const unrelated = provider.embedTexts(["unrelated"], { timeoutMs: 5000 });
    // Attach both handlers before a potentially regressing producer cancellation can reject it.
    const observed = unrelated.then(value => ({ status: "ready" as const, value }), error => ({ status: "failed" as const, error }));
    await child.unrelatedReturned;
    if (kind === "stop") await producer.stop();
    await pass;
    await producer.stop();
    expect(child.kills).toEqual([]);
    expect(child.spawns()).toBe(1);
    expect(environment.index.state(WORKSPACE).status).not.toBe("ready");
    const before = child.requests.size;
    producer.start();
    await producer.runPass();
    expect(child.requests.size).toBe(before); // native binding/inference still owns occupancy
    child.release();
    const result = await observed;
    expect(result.status).toBe("ready");
    if (result.status === "ready") expect(result.value[0]).toHaveLength(384);
    expect(child.kills).toEqual([]);
    await producer.stop();
    await runtime.closeProvider();
    await child.exited;
    expect(child.kills).toContain("SIGTERM");
    expect(child.spawns()).toBe(1);
  } finally {
    child.release();
    await producer.stop();
    await runtime.closeProvider();
    environment.database.close({ optimize: false });
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
