import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => { isolation.restore(); });
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { CoreError, createAuditedSourceAdmission, fieldContractSha256 } from "@do-soul/alaya-core";
import { closeCachedDatabase, initDatabase, SqliteEventLogRepo, SqliteMemoryEntryRepo } from "@do-soul/alaya-storage";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { createRecallReadWorkerClient, type RecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { parseWorkerOperationPayload, type WorkerOperationPayload } from "../../../runtime/recall-read-worker/operation-schemas.js";
import type { RecallReadWorkerRequest } from "../../../runtime/recall-read-worker/protocol.js";
import { BUDGET, CLOCK, ORIGINAL, query, source, correspondenceFor }
  from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-proof-fixture.js";
import { removeTempDirectorySync } from "../../../../../../packages/storage/src/__tests__/temp-directory.js";
import { assertBuiltWorker, builtWorkerUrl, createMemoryEntry } from "./recall-read-worker-client-fixture.js";
import { createRecallRealStorage, REAL_SQLITE_TEST_WORKSPACE_ID as WS }
  from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";

type Payload = Omit<WorkerOperationPayload<"conditionalField.sourceSemantics">, "request" | "comparison"> & {
  request: import("@do-soul/alaya-protocol").SourceSemanticWorkerRequest; comparison?: never;
};
type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
const BODY = "Alice uses tools.";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const payload = (request: Payload["request"]): Payload => ({ workspace_id: WS, as_of: CLOCK,
  lifetime_now: CLOCK, principal: "transport-principal", authorized_scopes: { mode: "named", scopes: ["project"] }, request });
const preparation = () => payload({ kind: "prepare_source", source_id: "transport-source", budget: { ...BUDGET } });
function observePosts() {
  const spy = vi.spyOn(Worker.prototype, "postMessage");
  return {
    spy,
    calls: () => spy.mock.calls.map((args, index) => ({ request: args[0] as RecallReadWorkerRequest,
      worker: spy.mock.contexts[index] as Worker })),
    restore: () => spy.mockRestore()
  };
}
async function actualClient(workerCount = 1) {
  assertBuiltWorker();
  const directory = mkdtempSync(join(tmpdir(), "alaya-source-transport-"));
  const filename = join(directory, "alaya.db");
  const { database } = await createRecallRealStorage(() => undefined, filename);
  let client: RecallReadWorkerClient | null = null;
  const guard = `--import=${new URL("../../../../../bench-runner/src/__tests__/support/provider-free-cli-bootstrap.mjs", import.meta.url).href}`;
  process.execArgv.push(guard);
  const cleanup = async () => {
    await client?.close();
    if (!database.isClosed()) database.close();
    closeCachedDatabase(filename);
    const index = process.execArgv.lastIndexOf(guard);
    if (index !== -1) process.execArgv.splice(index, 1);
    removeTempDirectorySync(directory);
  };
  try {
    const admission = createAuditedSourceAdmission({
      stores: createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) }),
      eventLogRepo: new SqliteEventLogRepo(database), runtimeNotifier: { notifyEntry: async () => undefined }, sha256: fieldContractSha256
    });
    await admission.admit({ workspace_id: WS, source_id: "transport-source", source_version: "1", content_bytes: BODY,
      evidence_object_id: null, recorded_at: CLOCK, event_time: null, valid_from: null, valid_to: null,
      speaker: "user", scope_class: "project", spans: [] }, { workspaceId: WS });
    await new SqliteMemoryEntryRepo(database).create(createMemoryEntry({ object_id: randomUUID(), workspace_id: WS,
      content: "before snapshot", activation_score: 1 }));
    database.close();
    closeCachedDatabase(filename);
    const warn = vi.fn();
    client = createRecallReadWorkerClient({ databaseFilename: filename, workerUrl: builtWorkerUrl,
      workerCount, requestTimeoutMs: 5000, warn });
    if (client === null) throw new Error("expected worker client");
    await client.ready();
    return { client, filename, warn, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
async function captureClient() {
  const directory = mkdtempSync(join(tmpdir(), "alaya-source-capture-"));
  const client = createRecallReadWorkerClient({ databaseFilename: join(directory, "fixture.capture"), workerCount: 1,
    requestTimeoutMs: 3000, workerUrl: new URL("./source-semantic-query-worker-fixture.mjs", import.meta.url) });
  if (client === null) throw new Error("expected capture worker client");
  try {
    await client.ready();
    return { client, cleanup: async () => { await client.close(); removeTempDirectorySync(directory); } };
  } catch (error) { await client.close(); removeTempDirectorySync(directory); throw error; }
}

describe("source semantic worker input capture", () => {
  it("captures the whole nested query payload before queuing without freezing caller-owned data (fixture responses)", async () => {
    const h = await captureClient(), posts = observePosts();
    const opened = deferred(), release = deferred();
    const holder = h.client.readSnapshot.isolate!(async () => { opened.resolve(); await release.promise; });
    try {
      await opened.promise;
      const input = structuredClone({ ...payload({ kind: "prepare_query", original_query: ORIGINAL,
        query_semantics: query(), source_preview_extents: [{ source_id: "transport-source", source_version: "1",
          record_id: `sha256:${"ab".repeat(32)}`, byte_extent: 20 }], budget: { ...BUDGET } }),
        expires_at: "2026-09-18T00:05:00.000Z" }) as Mutable<Payload>;
      // Validate the fixture against the live protocol rather than weakening it.
      parseWorkerOperationPayload("conditionalField.sourceSemantics", input);
      const expected = structuredClone(input);
      const running = h.client.sourceSemanticsPort!.execute(input);
      input.workspace_id = "mutated-workspace";
      input.as_of = "2026-09-19T00:00:00.000Z";
      input.lifetime_now = input.as_of;
      input.principal = "mutated-principal";
      input.expires_at = "2026-09-19T00:05:00.000Z";
      if (input.authorized_scopes.mode === "named") input.authorized_scopes.scopes.push("global");
      if (input.request.kind !== "prepare_query" || input.request.query_semantics === undefined) throw new Error("query expected");
      input.request.original_query = "mutated query";
      input.request.budget.work_units = 1;
      input.request.source_preview_extents![0]!.byte_extent = 1;
      input.request.query_semantics.variables[0]!.id = "mutated-variable";
      input.request.query_semantics.alternatives[0]!.frames[0]!.role_requirements[0]!.support.excerpt = "mutated support";
      input.request.query_semantics.return_variables.push("mutated-return");
      expect(posts.calls()).toHaveLength(0);
      release.resolve();
      await holder;
      await expect(running).resolves.toMatchObject({ kind: "prepare_query" });
      expect(posts.calls()).toHaveLength(1);
      expect(posts.calls()[0]!.request.payload).toEqual(expected);
      expect(Object.isFrozen(input)).toBe(false);
      expect(Object.isFrozen(input.request)).toBe(false);
      expect(Object.isFrozen(input.request.query_semantics.variables)).toBe(false);
    } finally { release.resolve(); await holder.catch(() => undefined); posts.restore(); await h.cleanup(); }
  });

  it("captures nested semantic correspondence arrays before an owning-worker queue wait (fixture rejection)", async () => {
    const h = await captureClient(), posts = observePosts();
    const opened = deferred(), release = deferred();
    let holder: Promise<unknown> | undefined;
    try {
      const prepared = await h.client.sourceSemanticsPort!.execute(payload({ kind: "prepare_query", original_query: ORIGINAL, budget: BUDGET }));
      if (prepared.kind !== "prepare_query" || prepared.query_handle === undefined) throw new Error("query handle expected");
      holder = h.client.readSnapshot.isolate!(async () => { opened.resolve(); await release.promise; });
      await opened.promise;
      const semantics = query(), correspondence = correspondenceFor(source(), semantics);
      const input = structuredClone(payload({ kind: "reason", query_handle: prepared.query_handle,
        source_interpretation_id: correspondence.source_interpretation_id, query_semantics: semantics,
        semantic_correspondence: correspondence, accepts_unreviewed_conditional_results: true, budget: BUDGET,
        output_byte_limit: 1_000_000 })) as Mutable<Payload>;
      parseWorkerOperationPayload("conditionalField.sourceSemantics", input);
      const expected = structuredClone(input);
      posts.spy.mockClear();
      const rejected = expect(h.client.sourceSemanticsPort!.execute(input)).rejects.toThrow("fixture captured non-preparation payload");
      if (input.request.kind !== "reason" || input.request.semantic_correspondence === undefined) throw new Error("reason expected");
      const rows = input.request.semantic_correspondence.correspondences;
      rows[0]!.source_semantic_support.push({ kind: "lexical", mentions: ["mutated-mention"] });
      rows[0]!.query_support.excerpt = "mutated support";
      rows.pop();
      expect(posts.calls()).toHaveLength(0);
      release.resolve(); await holder; await rejected;
      expect(posts.calls()).toHaveLength(1);
      expect(posts.calls()[0]!.request.payload).toEqual(expected);
      expect(Object.isFrozen(rows)).toBe(false);
    } finally { release.resolve(); await holder?.catch(() => undefined); posts.restore(); await h.cleanup(); }
  });

  it("rejects invalid schema before acquisition even while the only worker lease is occupied", async () => {
    const h = await captureClient(), posts = observePosts();
    const opened = deferred(), release = deferred();
    const holder = h.client.readSnapshot.isolate!(async () => { opened.resolve(); await release.promise; });
    try {
      await opened.promise;
      const invalid = payload({ kind: "prepare_source", source_id: "", budget: BUDGET });
      await expect(h.client.sourceSemanticsPort!.execute(invalid)).rejects.toMatchObject({ name: "ZodError" });
      expect(posts.calls()).toHaveLength(0);
      release.resolve();
      await holder;
      await expect(h.client.sourceSemanticsPort!.execute(payload({ kind: "prepare_query", original_query: ORIGINAL, budget: BUDGET })))
        .resolves.toMatchObject({ kind: "prepare_query" });
      expect(posts.calls()).toHaveLength(1);
    } finally { release.resolve(); await holder.catch(() => undefined); posts.restore(); await h.cleanup(); }
  });
});

describe("source semantic worker snapshot and preparation ownership", () => {
  it("reuses the caller's actual SQLite snapshot pin without reopening or switching workers", async () => {
    const h = await actualClient(2), posts = observePosts();
    try {
      await h.client.readSnapshot.isolate!(async () => {
        await h.client.readSnapshot.beginDeferred();
        try {
          expect(await h.client.memoryRepo.findByWorkspaceId(WS)).toHaveLength(1);
          const writer = initDatabase({ filename: h.filename });
          try {
            await new SqliteMemoryEntryRepo(writer).create(createMemoryEntry({ object_id: randomUUID(), workspace_id: WS,
              content: "after snapshot", activation_score: 0.5 }));
          } finally { writer.close(); closeCachedDatabase(h.filename); }
          await expect(h.client.sourceSemanticsPort!.execute(preparation())).resolves.toMatchObject({ kind: "prepare_source" });
          expect(await h.client.memoryRepo.findByWorkspaceId(WS)).toHaveLength(1);
        } finally { await h.client.readSnapshot.rollback(); }
      });
      const snapshotCalls = posts.calls();
      expect(snapshotCalls.map(call => call.request.operation)).toEqual(["snapshot.beginDeferred", "memory.findByWorkspaceId",
        "conditionalField.sourceSemantics", "memory.findByWorkspaceId", "snapshot.rollback"]);
      expect(new Set(snapshotCalls.map(call => call.worker)).size).toBe(1);
      expect(await h.client.memoryRepo.findByWorkspaceId(WS)).toHaveLength(2);
    } finally { posts.restore(); await h.cleanup(); }
  });

  it("rejects a preparation from another pinned worker without substituting or reopening it", async () => {
    const h = await actualClient(2), posts = observePosts();
    try {
      const prepared = await h.client.sourceSemanticsPort!.execute(preparation());
      if (prepared.kind !== "prepare_source") throw new Error("source handle expected");
      const owner = posts.calls()[0]!.worker;
      const validate = payload({ kind: "validate_source", source_handle: prepared.source_handle, budget: BUDGET });
      await h.client.readSnapshot.isolate!(async () => {
        await h.client.readSnapshot.beginDeferred();
        try {
          const pin = posts.calls().at(-1)!.worker;
          expect(pin).not.toBe(owner);
          const count = posts.calls().length;
          await expect(h.client.sourceSemanticsPort!.execute(validate)).rejects.toMatchObject({ code: "VALIDATION",
            message: "preparation handle belongs to another snapshot worker" });
          expect(posts.calls()).toHaveLength(count);
          expect(await h.client.memoryRepo.findByWorkspaceId(WS)).toHaveLength(1);
          expect(posts.calls().at(-1)!.worker).toBe(pin);
        } finally { await h.client.readSnapshot.rollback(); }
      });
      await expect(h.client.sourceSemanticsPort!.execute(validate)).resolves.toMatchObject({ kind: "validate_source", source: BODY });
      expect(posts.calls().at(-1)!.worker).toBe(owner);
      expect(h.warn).not.toHaveBeenCalled();
    } finally { posts.restore(); await h.cleanup(); }
  });

  it("preserves typed domain rejection causes and the live worker for subsequent valid requests", async () => {
    const h = await actualClient(), posts = observePosts();
    try {
      const error = await h.client.sourceSemanticsPort!.execute(payload({ kind: "prepare_source", source_id: "absent-source", budget: BUDGET }))
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(CoreError);
      expect(error).toMatchObject({ code: "NOT_FOUND", message: "source is not currently admitted",
        details: { admission: "no_eligible_source", work: { native_work: expect.any(Number) } } });
      const worker = posts.calls()[0]!.worker;
      expect(worker.threadId).toBeGreaterThan(0);
      const prepared = await h.client.sourceSemanticsPort!.execute(preparation());
      if (prepared.kind !== "prepare_source") throw new Error("source handle expected");
      const validate = payload({ kind: "validate_source", source_handle: prepared.source_handle, budget: BUDGET });
      await expect(h.client.sourceSemanticsPort!.execute({ ...validate, principal: "another-principal" }))
        .rejects.toMatchObject({ code: "VALIDATION", details: { admission: "expired" } });
      await expect(h.client.sourceSemanticsPort!.execute(validate)).resolves.toMatchObject({ kind: "validate_source", source: BODY });
      await expect(h.client.sourceSemanticsPort!.execute({ ...validate, lifetime_now: "2026-09-18T00:11:00.000Z" }))
        .rejects.toMatchObject({ code: "VALIDATION", details: { admission: "expired" } });
      await expect(h.client.sourceSemanticsPort!.execute(validate))
        .rejects.toMatchObject({ code: "VALIDATION", details: { admission: "expired" } });
      expect(new Set(posts.calls().map(call => call.worker))).toEqual(new Set([worker]));
      // Accepted domain rejections keep this worker; they still emit private operator evidence.
      expect(h.warn).toHaveBeenCalledTimes(4);
      expect(h.warn.mock.calls.map(([message]) => message)).toEqual(Array(4).fill("recall read worker request failed"));
    } finally { posts.restore(); await h.cleanup(); }
  });

  it("keeps a real query preparation on its owner when its SQLite revision becomes stale", async () => {
    const h = await actualClient(2), posts = observePosts();
    const opened = deferred(), release = deferred();
    const holder = h.client.readSnapshot.isolate!(async () => { opened.resolve(); await release.promise; });
    try {
      await opened.promise;
      const prepared = await h.client.sourceSemanticsPort!.execute(payload({ kind: "prepare_query", original_query: ORIGINAL,
        query_semantics: query(), budget: BUDGET }));
      if (prepared.kind !== "prepare_query" || prepared.query_handle === undefined) throw new Error("query handle expected");
      expect(prepared.query_semantics_status.status).toBe("admitted");
      const owner = posts.calls().at(-1)!.worker;
      release.resolve(); await holder;
      const request = payload({ kind: "reason", query_handle: prepared.query_handle,
        source_interpretation_id: `sha256:${"ab".repeat(32)}`, accepts_unreviewed_conditional_results: true,
        budget: BUDGET, output_byte_limit: 1_000_000 });
      await expect(h.client.sourceSemanticsPort!.execute(request)).rejects.toMatchObject({ code: "VALIDATION", details: { admission: "bound" } });
      expect(posts.calls().at(-1)!.worker).toBe(owner);
      const writer = initDatabase({ filename: h.filename });
      try {
        await new SqliteMemoryEntryRepo(writer).create(createMemoryEntry({ object_id: randomUUID(), workspace_id: WS,
          content: "changed SQLite revision", activation_score: 0.5 }));
      } finally { writer.close(); closeCachedDatabase(h.filename); }
      await expect(h.client.sourceSemanticsPort!.execute(request)).rejects.toMatchObject({ code: "VALIDATION", details: { admission: "filtered" } });
      await expect(h.client.sourceSemanticsPort!.execute(request)).rejects.toMatchObject({ code: "VALIDATION", details: { admission: "expired" } });
      expect(posts.calls().every(call => call.worker === owner)).toBe(true);
      expect(owner.threadId).toBeGreaterThan(0);
      expect(h.warn).toHaveBeenCalledTimes(3);
      expect(h.warn.mock.calls.map(([message]) => message)).toEqual(Array(3).fill("recall read worker request failed"));
    } finally { release.resolve(); await holder.catch(() => undefined); posts.restore(); await h.cleanup(); }
  });

  it("never redeems an invalidated handle on a replacement worker after the actual owner exits", async () => {
    const h = await actualClient(), posts = observePosts();
    try {
      const prepared = await h.client.sourceSemanticsPort!.execute(preparation());
      if (prepared.kind !== "prepare_source") throw new Error("source handle expected");
      const owner = posts.calls()[0]!.worker;
      const invalid = payload({ kind: "validate_source", source_handle: prepared.source_handle, budget: BUDGET });
      await owner.terminate();
      expect(owner.threadId).toBe(-1);
      const count = posts.calls().length;
      await expect(h.client.sourceSemanticsPort!.execute(invalid)).rejects.toThrow("Recall delivery worker unavailable");
      expect(posts.calls()).toHaveLength(count);
      await expect(h.client.sourceSemanticsPort!.execute(preparation())).resolves.toMatchObject({ kind: "prepare_source" });
      const replacement = posts.calls().at(-1)!.worker;
      expect(replacement).not.toBe(owner);
      const replacedCount = posts.calls().length;
      await expect(h.client.sourceSemanticsPort!.execute(invalid)).rejects.toThrow("Recall delivery worker unavailable");
      expect(posts.calls()).toHaveLength(replacedCount);
      expect(replacement.threadId).toBeGreaterThan(0);
    } finally { posts.restore(); await h.cleanup(); }
  });
});
