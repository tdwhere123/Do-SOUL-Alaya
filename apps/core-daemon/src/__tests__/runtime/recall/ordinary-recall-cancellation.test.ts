import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => isolation.restore());
import { RecallService, capableRecallConsumerDeclaration } from "@do-soul/alaya-core";
import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { once } from "node:events";
import Database from "better-sqlite3";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { createDependencies } from "../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { createRecallHandler } from "../../../mcp-memory/recall/recall-usage-handlers.js";
import { CLOCK, WS, deferred, embedded, queryClient, queryDatabase } from "./source-semantic-query-preparation-fixture.js";

function ordinary(h: { client: NonNullable<ReturnType<typeof createRecallReadWorkerClient>> }) {
  const service = new RecallService({ ...createDependencies().dependencies, now: () => CLOCK,
    readSnapshot: h.client.readSnapshot, conditionalFieldPort: h.client.conditionalFieldPort,
    activeConstraintsPort: h.client.activeConstraintsPort });
  const recall = createRecallHandler({ deps: { ...createDeps(), recallService: service },
    now: () => CLOCK, warn: vi.fn(), generateId: () => "aaaaaaaa-aaaa-4aaa-8aaa-999999999999" });
  return (signal: AbortSignal) => recall({ ...capableRecallConsumerDeclaration(), query: "Alice tools",
    scope_class: "project", dimension: null, domain_tags: null, max_results: 5 },
  { workspaceId: WS, runId: "run-1", agentTarget: "codex", sessionId: "cancel-test", abortSignal: signal });
}

it("rejects pre-aborted ordinary callers before binding or worker dispatch", async () => {
  const h = await queryClient(), controller = new AbortController();
  const reason = new Error("ordinary caller already gone");
  const posts = vi.spyOn(Worker.prototype, "postMessage");
  try {
    controller.abort(reason);
    await expect(ordinary(h)(controller.signal)).rejects.toBe(reason);
    expect(h.prepare).not.toHaveBeenCalled(); expect(posts).not.toHaveBeenCalled();
  } finally { await h.cleanup(); }
});

it("links ordinary caller cancellation into in-flight embedding and discards late preparation without dispatch", async () => {
  const entered = deferred(), release = deferred(), finished = deferred();
  let signal!: AbortSignal;
  const h = await queryClient({ embed: async (inputs, options) => {
    signal = options.signal!; entered.resolve();
    await release.promise; finished.resolve(); return embedded(inputs);
  } });
  const controller = new AbortController(), reason = new Error("ordinary caller cancelled inference");
  const posts = vi.spyOn(Worker.prototype, "postMessage");
  try {
    const running = ordinary(h)(controller.signal), rejected = expect(running).rejects.toBe(reason);
    await entered.promise; controller.abort(reason); await rejected;
    expect(signal.aborted).toBe(true); expect(signal.reason).toBe(reason);
    expect(posts).not.toHaveBeenCalled();
    release.resolve(); await finished.promise; await new Promise(resolve => setImmediate(resolve));
    expect(posts).not.toHaveBeenCalled();
    // The unchanged binding owner, not the rejected caller, owns actual inference settlement.
    expect(h.bind).toHaveBeenCalledTimes(1);
  } finally { release.resolve(); await h.cleanup(); }
});

it("quarantines an ordinary dispatched call until the real native lock releases and Worker actually exits", async () => {
  const h = await queryDatabase(), gate = new Database(`${h.filename}.gate`);
  gate.exec("PRAGMA journal_mode=DELETE; CREATE TABLE gate(value TEXT); INSERT INTO gate VALUES ('held')");
  const nativePost = Worker.prototype.postMessage, workers = new Set<Worker>();
  const posts = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, ...args) {
    workers.add(this); return Reflect.apply(nativePost, this, args);
  });
  const client = createRecallReadWorkerClient({ databaseFilename: h.filename,
    workerUrl: new URL("./ordinary-recall-native-lock-worker-fixture.mjs", import.meta.url),
    workerCount: 1, requestTimeoutMs: 60_000 })!;
  const controller = new AbortController(), reason = new Error("ordinary native caller cancelled");
  try {
    await client.ready(); const original = [...workers][0]!, exit = once(original, "exit");
    gate.exec("BEGIN EXCLUSIVE");
    const rejected = expect(ordinary({ client })(controller.signal)).rejects.toBe(reason);
    await expect.poll(() => existsSync(`${h.filename}.entered`)).toBe(true);
    controller.abort(reason); await rejected;
    expect(original.threadId).toBeGreaterThan(0); expect(gate.inTransaction).toBe(true);
    posts.mockClear();
    let settled = false;
    const next = client.memoryRepo.findByWorkspaceId(WS).finally(() => { settled = true; });
    const result = expect(next).resolves.toEqual([]);
    await new Promise(resolve => setImmediate(resolve));
    expect(settled).toBe(false); expect(posts).not.toHaveBeenCalled(); expect(workers.size).toBe(1);
    gate.exec("ROLLBACK"); await Promise.all([exit, result]);
    expect(original.threadId).toBe(-1); expect(workers.size).toBe(2);
  } finally {
    if (gate.inTransaction) gate.exec("ROLLBACK");
    await client.close(); gate.close(); h.cleanup();
  }
});

it("removes an ordinary caller cancelled in the real worker acquisition queue without retiring the holder", async () => {
  const h = await queryClient(), entered = deferred(), release = deferred();
  const holder = h.client.readSnapshot.isolate!(async () => { entered.resolve(); await release.promise; });
  const controller = new AbortController(), reason = new Error("ordinary queued caller cancelled");
  const posts = vi.spyOn(Worker.prototype, "postMessage");
  try {
    await entered.promise;
    const running = ordinary(h)(controller.signal), rejected = expect(running).rejects.toBe(reason);
    await expect.poll(() => h.prepare.mock.calls.length).toBe(1);
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(reason); await rejected;
    release.resolve(); await holder;
    await new Promise(resolve => setImmediate(resolve));
    expect(posts).not.toHaveBeenCalled();
    await expect(h.client.memoryRepo.findByWorkspaceId(WS)).resolves.toEqual([]);
  } finally { release.resolve(); await holder; await h.cleanup(); }
});
