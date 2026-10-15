import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => { isolation.restore(); });
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { RecallReadWorkerLifecycle } from "../../../runtime/recall/recall-read-worker-lifecycle.js";
import { removeTempDirectorySync } from "../../../../../../packages/storage/src/__tests__/temp-directory.js";
import { createMemoryEntry } from "./recall-read-worker-client-fixture.js";

const fixtureUrl = new URL("./recall-read-native-lock-worker-fixture.mjs", import.meta.url);
const pause = async (ms: number) => await new Promise<void>(resolve => setTimeout(resolve, ms));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
type Event = { kind: string; threadId: number; id?: number; operation?: string; payload?: { workspaceId?: string } };

async function harness(workerCount = 1, requestTimeoutMs = 600) {
  const directory = mkdtempSync(join(tmpdir(), "alaya-native-worker-lifecycle-"));
  const filename = join(directory, "native.db");
  const database = new Database(filename);
  database.exec("PRAGMA journal_mode=DELETE; CREATE TABLE transport_probe(value TEXT); INSERT INTO transport_probe VALUES ('present')");
  const unavailable = vi.fn();
  const posts = vi.spyOn(Worker.prototype, "postMessage");
  const lifecycle = new RecallReadWorkerLifecycle({ databaseFilename: filename,
    workerUrl: fixtureUrl, workerCount, requestTimeoutMs, onUnavailable: unavailable });
  const workers: Worker[] = [];
  const exited = new Set<Worker>();
  const events = (): Event[] => !existsSync(`${filename}.events`) ? []
    : readFileSync(`${filename}.events`, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Event);
  const track = (worker: Worker) => {
    if (!workers.includes(worker)) {
      workers.push(worker);
      worker.once("exit", () => { exited.add(worker); });
    }
    return worker;
  };
  const cleanup = async () => {
    if (database.inTransaction) database.exec("ROLLBACK");
    await lifecycle.close();
    posts.mockRestore();
    database.close();
    removeTempDirectorySync(directory);
  };
  try {
    for (let index = 0; index < workerCount; index += 1) {
      await lifecycle.isolate(async () => {
        track(lifecycle.pinnedWorker()!);
        await lifecycle.request("ready", {});
      }, undefined, index);
    }
    return { lifecycle, database, unavailable, workers, exited, events, posts, track, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
const read = (lifecycle: RecallReadWorkerLifecycle, workspaceId: string, preferred?: Worker) =>
  lifecycle.request("memory.findByWorkspaceId", { workspaceId }, undefined, preferred);
const dispatched = (events: readonly Event[], workspaceId: string) =>
  events.filter(event => event.kind === "dispatch" && event.payload?.workspaceId === workspaceId);

// These exercise actual Worker/SQLite resource ownership. Synthetic response
// delays are explicitly confined to the fixture and make no production CPU claim.
describe("recall read worker deadline and native quarantine", () => {
  it("rejects while native SQL remains locked and charges quarantine until actual exit", async () => {
    const h = await harness();
    try {
      const original = h.workers[0]!;
      h.database.exec("BEGIN EXCLUSIVE");
      const blocked = read(h.lifecycle, "native-lock");
      const rejected = expect(blocked).rejects.toThrow(/timed out after 600ms/);
      await expect.poll(() => h.events().filter(event => event.kind === "sql-enter").length).toBe(1);
      await rejected;
      expect(h.database.inTransaction).toBe(true);
      expect(h.events().some(event => event.kind === "sql-return")).toBe(false);
      expect(original.threadId).toBeGreaterThan(0);
      expect(h.exited.has(original)).toBe(false);
      expect(h.unavailable).toHaveBeenCalledExactlyOnceWith(original);
      let queuedSettled = false;
      const queued = read(h.lifecycle, "after-native-exit").finally(() => { queuedSettled = true; });
      const queuedResult = expect(queued).resolves.toEqual([]);
      await pause(40);
      expect(queuedSettled).toBe(false);
      expect(dispatched(h.events(), "after-native-exit")).toHaveLength(0);
      expect(new Set(h.posts.mock.contexts)).toEqual(new Set([original]));
      expect(h.posts.mock.calls.some(args => args[0].payload.workspaceId === "after-native-exit")).toBe(false);
      expect(h.events().filter(event => event.kind === "spawn")).toHaveLength(1);
      h.database.exec("ROLLBACK");
      await queuedResult;
      expect(h.exited.has(original)).toBe(true);
      expect(h.events().filter(event => event.kind === "spawn")).toHaveLength(2);
      expect(dispatched(h.events(), "after-native-exit")).toHaveLength(1);
      await expect(read(h.lifecycle, "subsequent")).resolves.toEqual([]);
    } finally { await h.cleanup(); }
  });

  it("removes expired queue waiters without dispatching or replacing quarantined native workers", async () => {
    const h = await harness(1, 400);
    try {
      h.database.exec("BEGIN EXCLUSIVE");
      const blockedResult = expect(read(h.lifecycle, "native-lock")).rejects.toThrow(/timed out/);
      await expect.poll(() => h.events().some(event => event.kind === "sql-enter")).toBe(true);
      const expiredResult = expect(read(h.lifecycle, "expired-in-queue")).rejects.toThrow(/timed out/);
      await Promise.all([blockedResult, expiredResult]);
      expect(h.exited.size).toBe(0);
      expect(dispatched(h.events(), "expired-in-queue")).toHaveLength(0);
      expect(h.events().filter(event => event.kind === "spawn")).toHaveLength(1);
      h.database.exec("ROLLBACK");
      await expect.poll(() => h.exited.size).toBe(1);
      await expect(read(h.lifecycle, "fresh")).resolves.toEqual([]);
      expect(dispatched(h.events(), "expired-in-queue")).toHaveLength(0);
      expect(h.posts.mock.calls.some(args => args[0].payload.workspaceId === "expired-in-queue")).toBe(false);
      expect(dispatched(h.events(), "fresh")).toHaveLength(1);
    } finally { await h.cleanup(); }
  });

  it("shares one deadline across queue acquisition and fixture-delayed dispatch", async () => {
    const h = await harness(1, 800);
    const release = deferred(), opened = deferred();
    const holder = h.lifecycle.isolate(async () => { opened.resolve(); await release.promise; });
    const holderResult = expect(holder).resolves.toBeUndefined();
    try {
      await opened.promise;
      const operation = read(h.lifecycle, "delay:500");
      const result = expect(operation).rejects.toThrow(/timed out after 800ms/);
      await pause(500);
      release.resolve();
      await holderResult;
      await expect.poll(() => dispatched(h.events(), "delay:500").length).toBe(1);
      await result;
      // A reset on dispatch would allow the 500ms fixture response after its
      // 500ms queue wait; the shared 800ms budget must reject it instead.
      expect(h.unavailable).toHaveBeenCalledTimes(1);
    } finally { release.resolve(); await holder.catch(() => undefined); await h.cleanup(); }
  });

  it("bounds two live plus quarantined slots and ignores duplicate old-worker events", async () => {
    const h = await harness(2, 700);
    try {
      h.database.exec("BEGIN EXCLUSIVE");
      const originals = [...h.workers];
      const failures = originals.map(worker => expect(read(h.lifecycle, "native-lock", worker)).rejects.toThrow(/timed out/));
      await expect.poll(() => h.events().filter(event => event.kind === "sql-enter").length).toBe(2);
      await Promise.all(failures);
      const queued = ["replacement-one", "replacement-two"].map(key => expect(read(h.lifecycle, key)).resolves.toEqual([]));
      await pause(30);
      expect(h.exited.size).toBe(0);
      expect(h.events().filter(event => event.kind === "spawn")).toHaveLength(2);
      expect(dispatched(h.events(), "replacement-one")).toHaveLength(0);
      expect(new Set(h.posts.mock.contexts)).toEqual(new Set(originals));
      h.database.exec("ROLLBACK");
      await Promise.all(queued);
      expect(h.exited.size).toBe(2);
      expect(h.events().filter(event => event.kind === "spawn").length - h.exited.size).toBeLessThanOrEqual(2);
      await h.lifecycle.isolate(async () => {
        const replacement = h.track(h.lifecycle.pinnedWorker()!);
        expect(originals).not.toContain(replacement);
        let settled = false;
        const request = read(h.lifecycle, "delay:100").finally(() => { settled = true; });
        const requestResult = expect(request).resolves.toEqual([]);
        await expect.poll(() => dispatched(h.events(), "delay:100").length).toBe(1);
        const id = dispatched(h.events(), "delay:100")[0]!.id!;
        // Deliberately inject duplicate events after actual native exit: these are
        // fixture-only stale notifications, not claims that Worker emits two exits.
        for (const old of originals) {
          old.emit("message", { id, ok: true, result: [createMemoryEntry({
            object_id: "00000000-0000-4000-8000-000000000001", workspace_id: "stale-worker",
            content: "must not fulfill the replacement request", activation_score: 1
          })] });
          old.emit("exit", 0);
        }
        expect(settled).toBe(false);
        expect(h.lifecycle.isAvailable(replacement)).toBe(true);
        await requestResult;
      });
      await expect(read(h.lifecycle, "after-stale-events")).resolves.toEqual([]);
      expect(h.events().filter(event => event.kind === "spawn").length - 2).toBeLessThanOrEqual(2);
    } finally { await h.cleanup(); }
  });

  it("close rejects active and queued calls and awaits every active or quarantined native exit", async () => {
    const h = await harness(2, 600);
    try {
      h.database.exec("BEGIN EXCLUSIVE");
      const timedOut = expect(read(h.lifecycle, "native-lock", h.workers[0])).rejects.toThrow(/timed out/);
      await expect.poll(() => h.events().filter(event => event.kind === "sql-enter").length).toBe(1);
      await timedOut;
      const active = read(h.lifecycle, "native-lock", h.workers[1]);
      const activeResult = expect(active).rejects.toThrow(/closed/);
      await expect.poll(() => h.events().filter(event => event.kind === "sql-enter").length).toBe(2);
      const queued = read(h.lifecycle, "never-on-close");
      const queueResult = expect(queued).rejects.toThrow(/closed/);
      let closed = false, repeatedClosed = false;
      const closing = h.lifecycle.close().then(() => { closed = true; });
      const repeatedClose = h.lifecycle.close();
      const repeated = repeatedClose.then(() => { repeatedClosed = true; });
      expect(h.lifecycle.close()).toBe(repeatedClose);
      await Promise.all([activeResult, queueResult]);
      // Both close callers remain pending behind a native lock barrier, not an
      // assumed minimum close duration. Neither actual worker has exited.
      expect(h.database.inTransaction).toBe(true);
      expect(h.workers.every(worker => worker.threadId > 0)).toBe(true);
      expect(closed).toBe(false);
      expect(repeatedClosed).toBe(false);
      expect(h.exited.size).toBe(0);
      expect(dispatched(h.events(), "never-on-close")).toHaveLength(0);
      h.database.exec("ROLLBACK");
      await Promise.all([closing, repeated]);
      expect(closed).toBe(true);
      expect(repeatedClosed).toBe(true);
      expect(h.exited.size).toBe(2);
      await expect(h.lifecycle.close()).resolves.toBeUndefined();
      await expect(read(h.lifecycle, "after-close")).rejects.toThrow(/closed/);
      expect(h.events().filter(event => event.kind === "spawn")).toHaveLength(2);
    } finally { await h.cleanup(); }
  });

  it("rejects nested concurrent work under its inherited deadline without releasing a running lease", async () => {
    const h = await harness(1, 450);
    try {
      const run = h.lifecycle.isolate(async () => {
        const settled = await Promise.allSettled([read(h.lifecycle, "delay:1000"), read(h.lifecycle, "delay:1001")]);
        expect(settled.every(result => result.status === "rejected")).toBe(true);
      });
      await expect(run).rejects.toThrow(/timed out/);
      const requests = h.events().filter(event => event.payload?.workspaceId?.startsWith("delay:"));
      expect(new Set(requests.map(event => event.threadId)).size).toBe(1);
      expect(requests.filter(event => event.kind === "dispatch")).toHaveLength(2);
      expect(h.unavailable).toHaveBeenCalledTimes(1);
      await expect(read(h.lifecycle, "after-concurrent-timeout")).resolves.toEqual([]);
    } finally { await h.cleanup(); }
  });

  it("quarantines unfinished fire-and-forget work and prevents callbacks reusing finished leases", async () => {
    const h = await harness();
    let leaked!: () => Promise<unknown>;
    let unfinished!: Promise<unknown>;
    const trigger = deferred(), callbackReady = deferred();
    let callback!: Promise<unknown>;
    try {
      await h.lifecycle.isolate(async () => {
        callback = trigger.promise.then(async () => { callbackReady.resolve(); return await read(h.lifecycle, "leaked-callback"); });
        leaked = async () => await read(h.lifecycle, "unbound-function");
      });
      const callbackResult = expect(callback).rejects.toThrow(/lease is no longer active/);
      trigger.resolve();
      await callbackReady.promise;
      await callbackResult;
      expect(dispatched(h.events(), "leaked-callback")).toHaveLength(0);
      // Defining a function under ALS does not capture it; the leaked promise
      // callback above is the actual inherited-context case.
      await expect(leaked()).resolves.toEqual([]);
      let unfinishedResult!: Promise<void>;
      await h.lifecycle.isolate(async () => {
        unfinished = read(h.lifecycle, "delay:1000");
        unfinishedResult = expect(unfinished).rejects.toThrow(/snapshot ended with requests still running/);
        await expect.poll(() => dispatched(h.events(), "delay:1000").length).toBe(1);
      });
      await unfinishedResult;
      expect(h.unavailable).toHaveBeenCalledTimes(1);
      await expect(read(h.lifecycle, "after-unfinished-work")).resolves.toEqual([]);
    } finally { trigger.resolve(); await callback?.catch(() => undefined); await unfinished?.catch(() => undefined); await h.cleanup(); }
  });
});
