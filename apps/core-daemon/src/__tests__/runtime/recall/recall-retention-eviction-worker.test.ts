import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => isolation.restore());
import { Worker } from "node:worker_threads";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { conditionalRecallPayload } from "../field/query-only-hydration-fixture.js";
import { queryDatabase, WS } from "./source-semantic-query-preparation-fixture.js";

type Snapshot = { retained_bytes: number; entries: number; executions: number };
type Probe = { kind: "fixture.retention"; before: Snapshot; after: Snapshot; protected?: string };
function probe(worker: Worker, fill = false, protect?: string): Promise<Probe> {
  return new Promise(resolve => {
    const listen = (message: Probe) => {
      if (message.kind !== "fixture.retention") return;
      worker.off("message", listen); resolve(message);
    };
    worker.on("message", listen);
    worker.postMessage({ operation: "fixture.retention", workspace: WS, fill, protect });
  });
}

it("reduces prepared charge on ACK and revokes evicted handles through the shipped Worker notification", async () => {
  const h = await queryDatabase();
  let worker!: Worker;
  const nativePost = Worker.prototype.postMessage;
  const posts = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, ...args) {
    worker = this; return Reflect.apply(nativePost, this, args);
  });
  const client = createRecallReadWorkerClient({ databaseFilename: h.filename, workerCount: 1,
    workerUrl: new URL("./recall-retention-pressure-worker-fixture.mjs", import.meta.url) })!;
  try {
    await client.ready();
    const removals: { reason: string; handles: string[] }[] = [];
    worker.on("message", message => { if (message.kind === "recall_retention_removed") removals.push(message); });
    const payload = { ...conditionalRecallPayload("Alice tools"), workspace_id: WS, result_kind_view: "source_only" as const };
    const port = client.conditionalFieldPort;
    const first = await port.recall(payload);
    expect(first.index.entries.length).toBeGreaterThan(0);
    const prepared = await probe(worker);
    await port.acknowledge!(first.preparation_id!, first.index, new Map(Object.entries(first.previews)));
    const acknowledged = await probe(worker);
    expect(acknowledged.after.retained_bytes).toBeLessThan(prepared.after.retained_bytes);
    const fill = await probe(worker, true, first.preparation_id);
    expect(fill.protected).toBeDefined(); expect(fill.after.retained_bytes).toBeGreaterThan(60 * 1024 * 1024);
    const later = await port.recall(payload);
    expect(later.index.entries).toEqual(first.index.entries);
    expect(removals.some(event => event.reason === "evicted" && event.handles.includes(first.preparation_id!))).toBe(true);
    posts.mockClear();
    await expect(port.acknowledge!(first.preparation_id!, first.index, new Map(Object.entries(first.previews))))
      .rejects.toThrow("Recall delivery worker unavailable");
    // A worker-side missing handle error alone would not establish parent route revocation.
    expect(posts).not.toHaveBeenCalled(); expect(worker.threadId).toBeGreaterThan(0);
    await expect(port.acknowledge!(later.preparation_id!, later.index, new Map(Object.entries(later.previews))))
      .resolves.toBeDefined();
  } finally { await client.close(); h.cleanup(); }
});
