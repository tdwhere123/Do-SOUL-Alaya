import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => isolation.restore());
import { Worker } from "node:worker_threads";
import { sourceSemanticExecutionPhases, SoulInterpretationRequestSchema, SNAPSHOT_PIN_NATIVE_WORK,
  type SourceSemanticWorkerResult } from "@do-soul/alaya-protocol";
import { CoreError } from "@do-soul/alaya-core";
import { createRecallRealStorage } from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { workerActualCostOf } from "../../../runtime/recall/worker-actual-cost.js";
import { createSourceSemanticInterpretationHandler } from "../../../mcp-memory/tool/interpretation-handler.js";
import { builtWorkerUrl } from "./recall-read-worker-client-fixture.js";
import { ACCESS_BUDGET, CLOCK, WS, withAccessLibrary } from "./source-semantic-access.test-support.js";
import { fixtureSources, ORIGINAL } from "./source-semantic-library-binding-coverage.js";
import { publishIndexedGeneration } from "./recall-storage.test-support.js";

const SCOPES = { mode: "named" as const, scopes: ["project"] };
const request = { kind: "recall" as const, accepts_unreviewed_conditional_results: true as const,
  original_query: ORIGINAL, semantic_correspondences: [], budget: { ...ACCESS_BUDGET, page_budget: 1 },
  output_byte_limit: 1_000_000 };
type Recall = Extract<SourceSemanticWorkerResult, { kind: "recall" }> & {
  preparation_id: string; previews: Record<string, string>; field_execution_receipt: Parameters<typeof workerActualCostOf>[0];
};
const sources = fixtureSources().map(({ id, text }) => ({ id, text }));
const indexed = { prepareDatabase: async (database: Parameters<typeof publishIndexedGeneration>[0]) => {
  await publishIndexedGeneration(database, sources.map(row => ({ text: row.text })));
} };
const payload = (now = CLOCK) => ({ workspace_id: WS, as_of: now, lifetime_now: now,
  authorized_scopes: SCOPES, request });
const minute = (value: number) => new Date(Date.parse(CLOCK) + value * 60_000).toISOString();

/** Faults are installed below the actual compiled owner, never as fabricated RPC results.
 * The provider-free guard runs before storage/Core imports and worker native startup.
 */
function instrumentedWorker(install: string): URL {
  const guard = new URL("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.ts", import.meta.url);
  const storage = new URL("../../../../../../packages/storage/dist/index.js", import.meta.url);
  const core = new URL("../../../../../../packages/core/dist/index.js", import.meta.url);
  return new URL(`data:text/javascript,${encodeURIComponent(`
    const { installProviderFreeBoundary } = await import(${JSON.stringify(guard.href)});
    installProviderFreeBoundary();
    const storage = await import(${JSON.stringify(storage.href)});
    const { CoreError } = await import(${JSON.stringify(core.href)});
    ${install}
    await import(${JSON.stringify(builtWorkerUrl.href)});
  `)}`);
}

it("preserves native acquisition failure and unknown cost through compiled worker and MCP, then retries", async () => {
  await withAccessLibrary(sources, async ({ filename }) => {
    const workerUrl = instrumentedWorker(`
      const native = storage.SqliteSourceIndexRepository.prototype.readLexicalCandidates;
      let fail = true;
      storage.SqliteSourceIndexRepository.prototype.readLexicalCandidates = function(...args) {
        const result = native.apply(this, args);
        if (fail) { fail = false; throw new Error("failure after real native lexical read"); }
        return result;
      };
    `);
    const client = createRecallReadWorkerClient({ databaseFilename: filename, workerUrl, workerCount: 1 })!;
    try {
      await client.ready();
      const handler = createSourceSemanticInterpretationHandler({ now: () => CLOCK, sourceSemanticsPort: client.sourceSemanticsPort });
      const { kind, ...fields } = request;
      const publicRequest = SoulInterpretationRequestSchema.parse({ ...fields, operation: kind });
      const context = { workspaceId: WS, runId: "failure", sessionId: "failure", agentTarget: "codex" };
      const failed = await handler(publicRequest, context);
      const phase = sourceSemanticExecutionPhases(failed.execution).acquisition;
      expect(phase).toMatchObject({ status: "failed", reason: "acquisition_failed", accounting: "partial" });
      expect(JSON.stringify(phase)).toContain("acquisition_failed_unknown_additional_cost");
      if (failed.operation !== "recall") throw new Error("recall expected");
      expect(failed.coverage.discovery).not.toBe("complete");
      expect(failed.work.logical_work).toBeGreaterThan(0);
      const retried = await handler(publicRequest, context);
      expect(sourceSemanticExecutionPhases(retried.execution).acquisition).toMatchObject({ status: "executed", accounting: "complete" });
      if (retried.operation !== "recall") throw new Error("recall expected");
      expect(retried.index!.entries.length).toBeGreaterThan(0);
    } finally { await client.close(); }
  }, indexed);
}, 60_000);

it.each([false, true])("preserves independent owner records and measured worker cost through replacement errors, frozen=%s", async frozen => {
  await withAccessLibrary(sources, async ({ filename }) => {
    const workerUrl = instrumentedWorker(`
      const hydrate = storage.SqliteSourceRootRecallReader.prototype.hydrate;
      storage.SqliteSourceRootRecallReader.prototype.hydrate = function(...args) {
        hydrate.apply(this, args);
        const error = new CoreError("CONFLICT", "native hydrate refusal", {
          subCode: "RETRYABLE_BACKPRESSURE", details: {
            execution_receipt: { owner: "controlled-core-receipt", native_visits: 37 },
            work: { native_work: 11, native_bytes: 17, logical_work: 23, logical_memory_bytes: 29, rss_bytes: 31 }
          }
        });
        throw ${frozen ? "Object.freeze(error)" : "error"};
      };
    `);
    const client = createRecallReadWorkerClient({ databaseFilename: filename, workerUrl, workerCount: 1 })!;
    try {
      await client.ready();
      const error = await client.sourceSemanticsPort!.execute(payload()).then(() => undefined, error => error as CoreError);
      expect(error).toBeInstanceOf(CoreError);
      expect(error).toMatchObject({ code: "CONFLICT", subCode: "RETRYABLE_BACKPRESSURE", message: "native hydrate refusal" });
      expect(error!.details!.execution_receipt).toEqual({ owner: "controlled-core-receipt", native_visits: 37 });
      expect(error!.details!.work).toEqual({ native_work: 11, native_bytes: 17, logical_work: 23, logical_memory_bytes: 29, rss_bytes: 31 });
      const physical = error!.details!.worker as { native_visits: number; rss_bytes: number };
      expect(physical.native_visits).toBeGreaterThan(0);
      expect(physical.rss_bytes).toBeGreaterThan(0);
    } finally { await client.close(); }
  }, indexed);
}, 60_000);

it("reports the latest physical pin read on a real SQLite generation refusal during acknowledgment", async () => {
  await withAccessLibrary(sources, async ({ port, filename }) => {
    const recalled = await port.execute(payload()) as Recall;
    const before = workerActualCostOf(recalled.field_execution_receipt);
    const { database } = await createRecallRealStorage(() => undefined, filename);
    try { database.connection.prepare("UPDATE source_records SET source_body = NULL WHERE workspace_id = ?").run(WS); }
    finally { database.close(); }
    const error = await port.acknowledge!(recalled.preparation_id, recalled.index, new Map(Object.entries(recalled.previews)))
      .then(() => undefined, error => error as CoreError);
    expect(error).toBeDefined();
    expect(error!.message).toMatch(/source|generation|revok|invalid/iu);
    const worker = error!.details!.worker as typeof before;
    expect(worker.native_visits).toBe(before.native_visits + SNAPSHOT_PIN_NATIVE_WORK);
    expect(worker.bytes_read).toBe(before.bytes_read);
    expect(worker.row_visits).toBe(before.row_visits);
    expect(worker.elapsed_ms).toBeGreaterThanOrEqual(before.elapsed_ms);
  }, indexed);
}, 60_000);

it("bounds initial and resumed continuation expiry by the advancing query capability lifetime", async () => {
  await withAccessLibrary(sources, async ({ port, filename }) => {
    const prepared = await port.execute({ ...payload(), expires_at: minute(10), request: {
      kind: "prepare_query", original_query: ORIGINAL, budget: request.budget } });
    if (prepared.kind !== "prepare_query" || prepared.query_handle === undefined) throw new Error("query handle required");
    const bound = { ...request, original_query: undefined, query_handle: prepared.query_handle };
    const page = async (now: string, continuation?: Recall["index"]["continuation"]) => {
      const recalled = await port.execute({ ...payload(now), expires_at: minute(25), request: {
        ...bound, ...(continuation == null ? {} : { continuation: continuation as never }) } }) as Recall;
      await port.acknowledge!(recalled.preparation_id, recalled.index, new Map(Object.entries(recalled.previews)));
      return recalled;
    };
    const first = await page(minute(9));
    expect(first.index.continuation).not.toBeNull();
    expect(first.index.continuation!.expires_at).toBe(minute(10));
    const second = await page(minute(9.5), first.index.continuation);
    expect(second.index.completeness.logical_index).not.toBe("invalidated");
    expect(second.index.continuation).not.toBeNull();
    expect(second.index.continuation!.expires_at).toBe(minute(10));
    const near = await page(minute(9.99), second.index.continuation);
    expect(near.index.completeness.logical_index).not.toBe("invalidated");
    await expect(page(minute(10), first.index.continuation)).rejects.toThrow(/expired/u);
    // A separate valid handle is revoked by real source mutation before its expiry.
    const fresh = await port.execute({ ...payload(minute(11)), request: {
      kind: "prepare_query", original_query: ORIGINAL, budget: request.budget } });
    if (fresh.kind !== "prepare_query" || fresh.query_handle === undefined) throw new Error("query handle required");
    const { database } = await createRecallRealStorage(() => undefined, filename);
    try { database.connection.prepare("UPDATE source_records SET source_body = NULL WHERE workspace_id = ?").run(WS); }
    finally { database.close(); }
    await expect(port.execute({ ...payload(minute(11.1)), request: { ...bound, query_handle: fresh.query_handle } }))
      .rejects.toThrow(/snapshot is no longer current/u);
  }, indexed);
}, 60_000);

it("arbitrates cancellation during an in-flight compiled acknowledgment and denies replay", async () => {
  await withAccessLibrary(sources, async ({ filename }) => {
    const workerUrl = instrumentedWorker(`
      const { parentPort } = await import("node:worker_threads");
      const on = parentPort.on.bind(parentPort);
      parentPort.on = (event, listener) => event !== "message" ? on(event, listener) : on(event, async message => {
        if (message.operation === "conditionalField.acknowledge") {
          await new Promise(resolve => {
            const resume = value => { if (value.test === "resume") { parentPort.off("message", resume); resolve(); } };
            on("message", resume);
            parentPort.postMessage({ test: "ack-paused" });
          });
        }
        if (message.test !== "resume") listener(message);
      });
    `);
    const client = createRecallReadWorkerClient({ databaseFilename: filename, workerUrl, workerCount: 1 })!;
    const controller = new AbortController();
    let posted = 0, preparationId: string | undefined, recalled: Recall | undefined;
    let resume: (() => Promise<SourceSemanticWorkerResult>) | undefined;
    const post = Worker.prototype.postMessage;
    vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function(this: Worker, message, ...args) {
      if (message.operation === "conditionalField.acknowledge") {
        posted++;
        const worker = this;
        const paused = (value: { test?: string }) => {
          if (value.test !== "ack-paused") return;
          worker.off("message", paused);
          controller.abort(new Error("caller cancelled in-flight acknowledgment"));
          controller.abort(new Error("repeat cancellation"));
          post.call(worker, { test: "resume" });
        };
        worker.on("message", paused);
      }
      return post.call(this, message, ...args);
    });
    try {
      await client.ready();
      const port = client.sourceSemanticsPort!;
      const handler = createSourceSemanticInterpretationHandler({ now: () => CLOCK, sourceSemanticsPort: {
        ...port, execute: async input => {
          const result = await port.execute(input); recalled = result as Recall; preparationId = recalled.preparation_id;
          const continuation = recalled.index.continuation;
          expect(continuation).not.toBeNull();
          if (input.request.kind === "recall") {
            const request = input.request;
            resume = () => port.execute({ ...input, request: { ...request, continuation: continuation as never } });
          }
          return result;
        }
      } });
      const { kind, ...fields } = request;
      const error = await handler(SoulInterpretationRequestSchema.parse({ operation: kind, ...fields }), {
        workspaceId: WS, runId: "cancel", sessionId: "cancel", agentTarget: "codex", abortSignal: controller.signal
      }).then(() => undefined, error => error as CoreError);
      expect(posted).toBe(1);
      expect(error?.details?.delivery_settlement).toBe("cancelled");
      expect((error?.details?.work as { logical_work: number }).logical_work).toBeGreaterThan(0);
      expect((error?.details?.worker as { native_visits: number }).native_visits).toBeGreaterThan(0);
      expect(error?.details?.execution_receipt).toBeDefined();
      // The staged successor did not become an issued continuation at Core's owner.
      const unissued = await resume!();
      if (unissued.kind !== "recall") throw new Error("recall expected");
      expect(unissued.index.completeness.logical_index).toBe("invalidated");
      expect(unissued.index.entries).toEqual([]);
      await expect(port.acknowledge!(preparationId!, recalled!.index, new Map(Object.entries(recalled!.previews))))
        .rejects.toThrow(/expired or discarded/u);
      await port.discard!(preparationId!);
      await port.discard!(preparationId!);
      await expect(port.acknowledge!(preparationId!, recalled!.index, new Map(Object.entries(recalled!.previews))))
        .rejects.toThrow(/worker unavailable/u);
    } finally { await client.close(); }
  }, indexed);
}, 60_000);

it("returns the committed result when cancellation arrives after issuance but before the IPC reply", async () => {
  await withAccessLibrary(sources, async ({ filename }) => {
    const workerUrl = instrumentedWorker(`
      const { parentPort } = await import("node:worker_threads");
      const on = parentPort.on.bind(parentPort), post = parentPort.postMessage.bind(parentPort);
      const acknowledgments = new Set();
      parentPort.on = (event, listener) => event !== "message" ? on(event, listener) : on(event, message => {
        if (message.operation === "conditionalField.acknowledge") acknowledgments.add(message.id);
        if (message.test !== "resume") listener(message);
      });
      parentPort.postMessage = message => {
        if (acknowledgments.delete(message.id) && message.ok) {
          const resume = value => { if (value.test === "resume") { parentPort.off("message", resume); post(message); } };
          on("message", resume); post({ test: "committed" });
        } else post(message);
      };
    `);
    const client = createRecallReadWorkerClient({ databaseFilename: filename, workerUrl, workerCount: 1 })!;
    const controller = new AbortController(), post = Worker.prototype.postMessage;
    let committed = 0;
    vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function(this: Worker, message, ...args) {
      if (message.operation === "conditionalField.acknowledge") {
        const worker = this;
        const paused = (value: { test?: string }) => {
          if (value.test !== "committed") return;
          worker.off("message", paused); committed++;
          controller.abort(new Error("cancelled after commit"));
          post.call(worker, { test: "resume" });
        };
        worker.on("message", paused);
      }
      return post.call(this, message, ...args);
    });
    try {
      await client.ready();
      const handler = createSourceSemanticInterpretationHandler({ now: () => CLOCK, sourceSemanticsPort: client.sourceSemanticsPort });
      const { kind, ...fields } = request;
      const result = await handler(SoulInterpretationRequestSchema.parse({ operation: kind, ...fields }), {
        workspaceId: WS, runId: "committed", sessionId: "committed", agentTarget: "codex", abortSignal: controller.signal
      });
      expect(committed).toBe(1);
      expect(controller.signal.aborted).toBe(true);
      expect(result.operation).toBe("recall");
      if (result.operation !== "recall") throw new Error("recall expected");
      expect(result.index!.entries.length).toBeGreaterThan(0);
    } finally { await client.close(); }
  }, indexed);
}, 60_000);

it("honors pre-dispatch cancellation but never relabels a completed acknowledgment as cancelled", async () => {
  await withAccessLibrary(sources, async ({ port }) => {
    const first = await port.execute(payload()) as Recall;
    const controller = new AbortController(); controller.abort(new Error("already cancelled"));
    await expect(port.acknowledge!(first.preparation_id, first.index, new Map(Object.entries(first.previews)), controller.signal))
      .rejects.toMatchObject({ details: { delivery_settlement: "cancelled" } });
    const second = await port.execute(payload()) as Recall;
    const previews = new Map(Object.entries(second.previews));
    const settled = await port.acknowledge!(second.preparation_id, second.index, previews);
    expect(settled).toMatchObject({ schema_version: 1, query_id: second.index.query_id });
    await expect(port.acknowledge!(second.preparation_id, second.index, previews, controller.signal)).resolves.toEqual(settled);
    await expect(port.acknowledge!(second.preparation_id, second.index, previews)).resolves.toEqual(settled);
  }, indexed);
}, 60_000);
