import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => isolation.restore());
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { createRecallHandler } from "../../../mcp-memory/recall/recall-usage-handlers.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { conditionalRecallPayload } from "../field/query-only-hydration-fixture.js";
import { RecallService, capableRecallConsumerDeclaration } from "@do-soul/alaya-core";
import { createDependencies, createTaskSurface } from "../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import { CLOCK, WS, deferred, queryClient, queryDatabase } from "./source-semantic-query-preparation-fixture.js";

function serviceFor(h: Pick<Awaited<ReturnType<typeof queryClient>>, "client">) {
  return new RecallService({ ...createDependencies().dependencies, now: () => CLOCK,
    readSnapshot: h.client.readSnapshot, conditionalFieldPort: h.client.conditionalFieldPort,
    activeConstraintsPort: h.client.activeConstraintsPort });
}
const params = (signal: AbortSignal) => ({ workspaceId: WS, strategy: "chat" as const,
  taskSurface: createTaskSurface(), queryText: "Alice tools", defer_delivery: true,
  abortSignal: signal, ...capableRecallConsumerDeclaration() });
const turn = async () => await new Promise(resolve => setImmediate(resolve));

it("cancels a deferred ACK in the real Worker queue without dispatching it or retiring its holder", async () => {
  const h = await queryClient(), controller = new AbortController();
  const reason = new Error("deferred ACK caller cancelled"), release = deferred(), entered = deferred();
  let holder: Promise<void> | undefined;
  const posts = vi.spyOn(Worker.prototype, "postMessage");
  try {
    const page = await serviceFor(h).recall(params(controller.signal));
    holder = h.client.readSnapshot.isolate!(async () => { entered.resolve(); await release.promise; });
    await entered.promise; posts.mockClear();
    let outcome: unknown;
    const ack = page.acknowledge_delivery!(page.index, new Map()).catch(error => { outcome = error; });
    await turn(); controller.abort(reason);
    await expect.poll(() => outcome).toBe(reason);
    expect(posts).not.toHaveBeenCalled();
    release.resolve(); await holder; await ack; await turn();
    expect(posts).not.toHaveBeenCalled();
    await page.discard_delivery!();
    expect(posts.mock.calls.map(([message]) => message.operation)).toEqual(["conditionalField.discard"]);
    await expect(h.client.memoryRepo.findByWorkspaceId(WS)).resolves.toEqual([]);
  } finally { release.resolve(); await holder; await h.cleanup(); }
});

it("rejects a late deferred callback after its original caller aborts, but still discards the preparation", async () => {
  const h = await queryClient(), controller = new AbortController(), reason = new Error("late ACK cancelled");
  const posts = vi.spyOn(Worker.prototype, "postMessage");
  try {
    const page = await serviceFor(h).recall(params(controller.signal));
    posts.mockClear(); controller.abort(reason);
    await expect(page.acknowledge_delivery!(page.index, new Map())).rejects.toBe(reason);
    expect(posts).not.toHaveBeenCalled();
    await page.discard_delivery!();
    expect(posts.mock.calls.map(([message]) => message.operation)).toEqual(["conditionalField.discard"]);
  } finally { await h.cleanup(); }
});

it("cancels direct-port ACK admission before and during queueing, then acknowledges and replays without duplicate debit", async () => {
  const h = await queryClient(), controller = new AbortController(), reason = new Error("direct ACK cancelled");
  const release = deferred(), entered = deferred();
  let holder: Promise<void> | undefined;
  const posts = vi.spyOn(Worker.prototype, "postMessage");
  try {
    const port = h.client.conditionalFieldPort;
    const page = await port.recall({ ...conditionalRecallPayload("Alice tools"), workspace_id: WS });
    const ack = (signal?: AbortSignal) => port.acknowledge!(page.preparation_id!, page.index,
      new Map(Object.entries(page.previews)), signal);
    holder = h.client.readSnapshot.isolate!(async () => { entered.resolve(); await release.promise; });
    await entered.promise; posts.mockClear();
    const rejected = expect(ack(controller.signal)).rejects.toBe(reason);
    await turn(); controller.abort(reason); await rejected;
    await expect(ack(controller.signal)).rejects.toBe(reason);
    release.resolve(); await holder; await turn();
    expect(posts).not.toHaveBeenCalled();
    const receipt = await ack();
    expect(receipt?.actual).toBeDefined();
    expect(await ack()).toEqual(receipt);
    // Direct consumers can still discard inside their currently owned snapshot lease.
    await h.client.readSnapshot.isolate!(async () => await port.discard!(page.preparation_id!));
    expect(posts.mock.calls.map(([message]) => message.operation)).toEqual([
      "conditionalField.acknowledge", "conditionalField.acknowledge", "conditionalField.discard"
    ]);
    await expect(ack()).rejects.toThrow("Recall delivery worker unavailable");
  } finally { release.resolve(); await holder; await h.cleanup(); }
});

it("cancels non-deferred ACK queueing and completes discard outside the cancelled preparation scope", async () => {
  const h = await queryClient(), controller = new AbortController(), reason = new Error("immediate ACK cancelled");
  const start = deferred(), entered = deferred(), release = deferred(), ackEntered = deferred(), discarded = deferred();
  // Start the holder in an independent caller context, not the scope being cancelled.
  const holder = (async () => {
    await start.promise;
    await h.client.readSnapshot.isolate!(async () => { entered.resolve(); await release.promise; });
  })();
  const port = h.client.conditionalFieldPort;
  const acknowledge = port.acknowledge!, discard = port.discard!;
  vi.spyOn(port, "acknowledge").mockImplementation(async (...args) => {
    start.resolve(); await entered.promise; ackEntered.resolve();
    return await acknowledge(...args);
  });
  vi.spyOn(port, "discard").mockImplementation(async id => { await discard(id); discarded.resolve(); });
  const posts = vi.spyOn(Worker.prototype, "postMessage");
  try {
    const running = serviceFor(h).recall({ ...params(controller.signal), defer_delivery: false });
    const rejected = expect(running).rejects.toBe(reason);
    await ackEntered.promise; await turn(); posts.mockClear(); controller.abort(reason); await rejected;
    expect(posts).not.toHaveBeenCalled();
    release.resolve(); await holder; await discarded.promise;
    expect(posts.mock.calls.map(([message]) => message.operation)).toEqual(["conditionalField.discard"]);
    await expect(h.client.memoryRepo.findByWorkspaceId(WS)).resolves.toEqual([]);
  } finally { start.resolve(); release.resolve(); await holder; await h.cleanup(); }
});

it("cancels the handler's deferred ACK queue without persisting or exposing a delivery", async () => {
  const h = await queryClient(), controller = new AbortController(), reason = new Error("handler ACK cancelled");
  const start = deferred(), entered = deferred(), release = deferred(), ackEntered = deferred();
  const holder = (async () => {
    await start.promise;
    await h.client.readSnapshot.isolate!(async () => { entered.resolve(); await release.promise; });
  })();
  const service = serviceFor(h), originalRecall = service.recall.bind(service);
  vi.spyOn(service, "recall").mockImplementation(async input => {
    const result = await originalRecall(input);
    start.resolve(); await entered.promise; return result;
  });
  const port = h.client.conditionalFieldPort, acknowledge = port.acknowledge!;
  vi.spyOn(port, "acknowledge").mockImplementation(async (...args) => {
    ackEntered.resolve(); return await acknowledge(...args);
  });
  const deps = { ...createDeps(), recallService: service };
  const record = vi.spyOn(deps.trustStateRecorder, "recordDelivery");
  const handler = createRecallHandler({ deps, now: () => CLOCK, warn: vi.fn(), generateId: () => "aaaaaaaa-aaaa-4aaa-8aaa-999999999999" });
  const posts = vi.spyOn(Worker.prototype, "postMessage");
  try {
    const running = handler({ query: "Alice tools", scope_class: "project", dimension: null,
      domain_tags: null, max_results: 5, ...capableRecallConsumerDeclaration() },
    { workspaceId: WS, runId: "run-1", agentTarget: "codex", sessionId: "cancel-ack", abortSignal: controller.signal });
    const rejected = expect(running).rejects.toBe(reason);
    await ackEntered.promise; await turn(); posts.mockClear(); controller.abort(reason); await turn();
    expect(posts).not.toHaveBeenCalled(); expect(record).not.toHaveBeenCalled();
    release.resolve(); await holder; await rejected;
    expect(posts.mock.calls.map(([message]) => message.operation)).toEqual(["conditionalField.discard"]);
    expect(record).not.toHaveBeenCalled();
  } finally { start.resolve(); release.resolve(); await holder; await h.cleanup(); }
});

it("retains dispatched ACK occupancy under real native SQLite until Worker exit, without claiming rollback", async () => {
  const h = await queryDatabase(), gate = new Database(`${h.filename}.gate`);
  gate.exec("PRAGMA journal_mode=DELETE; CREATE TABLE gate(value TEXT); INSERT INTO gate VALUES ('held')");
  const client = createRecallReadWorkerClient({ databaseFilename: h.filename,
    workerUrl: new URL("./recall-ack-native-lock-worker-fixture.mjs", import.meta.url),
    workerCount: 1, requestTimeoutMs: 60_000 })!;
  const controller = new AbortController(), reason = new Error("dispatched ACK caller cancelled");
  const nativePost = Worker.prototype.postMessage, workers = new Set<Worker>();
  const posts = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function(this: Worker, ...args) {
    workers.add(this); return Reflect.apply(nativePost, this, args);
  });
  try {
    await client.ready();
    const page = await serviceFor({ client }).recall(params(controller.signal));
    const original = [...workers][0]!, exited = once(original, "exit");
    gate.exec("BEGIN EXCLUSIVE"); posts.mockClear();
    const rejected = expect(page.acknowledge_delivery!(page.index, new Map())).rejects.toBe(reason);
    await expect.poll(() => existsSync(`${h.filename}.ack-entered`)).toBe(true);
    controller.abort(reason); await rejected;
    expect(posts.mock.calls.map(([message]) => message.operation)).toEqual(["conditionalField.acknowledge"]);
    expect(original.threadId).toBeGreaterThan(0); expect(gate.inTransaction).toBe(true);
    posts.mockClear();
    await page.discard_delivery!();
    let settled = false;
    const next = client.memoryRepo.findByWorkspaceId(WS).finally(() => { settled = true; });
    const result = expect(next).resolves.toEqual([]);
    await turn();
    expect(settled).toBe(false); expect(posts).not.toHaveBeenCalled();
    gate.exec("ROLLBACK"); await Promise.all([exited, result]);
    expect(original.threadId).toBe(-1);
    expect(posts.mock.contexts.every(worker => worker !== original)).toBe(true);
  } finally {
    if (gate.inTransaction) gate.exec("ROLLBACK");
    await client.close(); gate.close(); h.cleanup();
  }
});
