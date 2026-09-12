import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { EventPublisher, RecallService, snapshotIdFromPin, type ConditionalFieldExecutionReceipt } from "@do-soul/alaya-core";
import { MemoryDimension, SNAPSHOT_PIN_NATIVE_WORK, SoulMemorySearchRequestSchema, sourceEvidenceRootTarget, type ContextDeliveryRecord } from "@do-soul/alaya-protocol";
import { closeCachedDatabase, SqliteEventLogRepo, SqliteTrustStateRepo, SqliteFieldSourceRecordRepo, SqliteIndexedRecallProjection } from "@do-soul/alaya-storage";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { createRecallHandler } from "../../../mcp-memory/recall/recall-usage-handlers.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { builtWorkerUrl } from "./recall-read-worker-client-fixture.js";
import { TrustStateRecorder } from "../../../trust/state.js";
import { workerActualCostOf } from "../../../runtime/recall/worker-actual-cost.js";
import { fieldSha256, hashedRecord } from "../../../../../../packages/storage/src/__tests__/repos/field/field-contract-fixture.js";
import { createDependencies } from "../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import { MEM, NOW, WS, RUN, openSourceSlice } from "../../../../../../packages/core/src/__tests__/recall/conditional-field/vertical/source-slice.js";

it("replays the same confirmed page and delivery id after public persistence fails across real worker RPC", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alaya-delivery-ack-"));
  const filename = join(directory, "alaya.db");
  const slice = await openSourceSlice(() => {}, filename);
  for (const [i, id] of [MEM.r, MEM.c, MEM.h, MEM.s].entries()) await slice.writeMemory(id, `needle ${i}`, MemoryDimension.FACT);
  slice.database.close();
  closeCachedDatabase(filename);
  const client = createRecallReadWorkerClient({ databaseFilename: filename, workerUrl: builtWorkerUrl, workerCount: 2 })!;
  try {
    await client.ready();
    const acknowledged: string[] = [];
    const port = { ...client.conditionalFieldPort,
      acknowledge: async (...args: Parameters<NonNullable<typeof client.conditionalFieldPort.acknowledge>>) => {
        const receipt = await client.conditionalFieldPort.acknowledge!(...args);
        acknowledged.push(args[0]);
        return receipt;
      } };
    const service = new RecallService({ ...createDependencies().dependencies, now: () => NOW,
      conditionalFieldPort: port, activeConstraintsPort: client.activeConstraintsPort,
      readSnapshot: client.readSnapshot });
    const deps = { ...createDeps(), recallService: service };
    const records = new Map<string, ContextDeliveryRecord>();
    deps.trustStateRecorder.findDeliveryById = vi.fn(async (id) => records.get(id) ?? null);
    const record = deps.trustStateRecorder.recordDelivery;
    let fail = false;
    let failedDelivery: Omit<ContextDeliveryRecord, "audit_event_id"> | undefined;
    deps.trustStateRecorder.recordDelivery = vi.fn(async (...args: Parameters<typeof record>) => {
      const [input] = args;
      if (fail) { failedDelivery = input; throw new Error("injected public delivery persistence failure"); }
      const result = await record(...args); records.set(input.delivery_id, result); return result;
    });
    const handler = createRecallHandler({ deps, now: () => NOW, generateId: randomUUID, warn: () => {} });
    const context = { workspaceId: WS, runId: RUN, sessionId: RUN, agentTarget: "codex" };
    const request = SoulMemorySearchRequestSchema.parse({ query: "needle", max_results: 1,
      scope_class: null, dimension: null, domain_tags: null,
      protocol_version: 1, supported_result_kinds: ["memory_entry", "source_evidence"],
      supports_source_evidence: true, supports_product_updates: true });
    let release!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => { locked = resolve; });
    const occupied = client.readSnapshot.isolate!(async () => {
      locked();
      await new Promise<void>((resolve) => { release = resolve; });
    });
    await ready;
    // Force the first page onto worker 1, then make worker 0 available for retry.
    const first = await handler(request, context).finally(() => release());
    await occupied;
    expect(first.results).toHaveLength(1);
    expect(first.index?.continuation).not.toBeNull();
    expect(acknowledged).toHaveLength(1);
    fail = true;
    const nextRequest = { ...request, continuation: first.index!.continuation! };
    await expect(handler(nextRequest, context)).rejects.toThrow("injected public delivery persistence failure");
    expect(failedDelivery).toBeDefined();
    fail = false;
    const second = await handler(nextRequest, context);
    expect(second.results).toHaveLength(1);
    expect(second.results[0]!.target).not.toEqual(first.results[0]!.target);
    expect(second.delivery_id).toBe(failedDelivery!.delivery_id);
    expect(second.results.map((result) => result.target)).toEqual(failedDelivery!.delivered_objects?.map((object) => object.target));
    const replay = await handler(nextRequest, context);
    expect(replay.delivery_id).toBe(second.delivery_id);
    expect(replay.results).toEqual(second.results);
    expect(replay.page_purpose).toBe("retry");
    for (const page of [first, second, replay]) {
      expect(page.index!.entries.length + (page.index!.product_updates?.length ?? 0)).toBeLessThanOrEqual(1);
    }
  } finally {
    await client.close();
    closeCachedDatabase(filename);
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it.each(["prepare", "record", "replay"] as const)("rejects source withdrawal during %s without phantom delivery receipts", async (phase) => {
  const fixture = await sourceWorkerFixture("needle initial", 2);
  try {
    let armed = false;
    const withdraw = () => fixture.database.connection.prepare("UPDATE source_records SET source_body = NULL WHERE workspace_id = ?").run(WS);
    fixture.hooks.beforeAcknowledgment = () => {
      if (armed && phase !== "record") withdraw();
    };
    const record = fixture.recorder.recordDelivery.bind(fixture.recorder);
    fixture.recorder.recordDelivery = async (...args) => {
      if (armed && phase === "record") withdraw();
      return await record(...args);
    };
    let request = fixture.request;
    if (phase === "replay") {
      const first = await fixture.handler(request, fixture.context);
      expect(first.index?.continuation).not.toBeNull();
      request = { ...request, continuation: first.index!.continuation! };
      const second = await fixture.handler(request, fixture.context);
      expect(second.results[0]?.content_preview).toBe("needle initial");
    }
    const before = fixture.receiptCounts();
    armed = true;
    await expect(fixture.handler(request, fixture.context)).rejects.toThrow(/source|generation|revok|invalid/i);
    expect(fixture.receiptCounts()).toEqual(before);
  } finally { await fixture.close(); }
}, 30_000);

it("expands the remaining bytes of a final source clipped by the real public response budget", async () => {
  const body = `needle ${"x".repeat(3000)}`;
  const fixture = await sourceWorkerFixture(body);
  try {
    const first = await fixture.handler(fixture.request, fixture.context);
    const result = first.results[0]!;
    expect(result.content_preview).toHaveLength(2000);
    expect(result.target?.kind).toBe("source_evidence");
    if (result.target?.kind !== "source_evidence") throw new Error("source target missing");
    expect(result.target.span).toMatchObject({ content_start: 0, content_end: 2000, content_complete: false });
    expect(first.index?.continuation).not.toBeNull();
    const tail = await fixture.handler({ ...fixture.request, continuation: first.index!.continuation!,
      payload_continuation: { schema_version: 1, purpose: "payload_expansion", target: sourceEvidenceRootTarget(result.target),
        start_offset: 2000, byte_budget: 2000 } }, fixture.context);
    expect(tail.page_purpose).toBe("payload");
    expect(tail.results).toHaveLength(1);
    expect(tail.results[0]?.target).toMatchObject({ root_id: result.target.root_id, span: { content_start: 2000, content_end: 3007, content_complete: true } });
    expect(result.content_preview + tail.results[0]!.content_preview).toBe(body);
  } finally { await fixture.close(); }
}, 30_000);

it("expands a source whose entire public payload was omitted after another source used the byte budget", async () => {
  const body = `needle ${"x".repeat(3000)}`;
  const fixture = await sourceWorkerFixture(body, 2);
  try {
    const request = { ...fixture.request, max_results: 8 };
    const first = await fixture.handler(request, fixture.context);
    expect(first.results).toHaveLength(2);
    const omitted = first.results.find((result) => result.content_preview === "[payload omitted]");
    expect(omitted?.target?.kind).toBe("source_evidence");
    if (omitted?.target?.kind !== "source_evidence") throw new Error("omitted source target missing");
    expect(first.index?.continuation).not.toBeNull();
    const expanded = await fixture.handler({ ...request, continuation: first.index!.continuation!,
      payload_continuation: { schema_version: 1, purpose: "payload_expansion", target: sourceEvidenceRootTarget(omitted.target),
        start_offset: 0, byte_budget: 1200 } }, fixture.context);
    expect(expanded.page_purpose).toBe("payload");
    expect(expanded.results.map((result) => result.content_preview)).toEqual([body.slice(0, 1200)]);
    expect(expanded.results[0]?.target).toMatchObject({ root_id: omitted.target.root_id, span: { content_start: 0, content_end: 1200, content_complete: false } });
  } finally { await fixture.close(); }
}, 30_000);

it.each([false, true])("accounts actual acknowledgment and receipt-generation checks when persistence fails=%s", async (fail) => {
  const fixture = await sourceWorkerFixture("needle initial");
  try {
    let prepared: ConditionalFieldExecutionReceipt | undefined;
    let settled: ConditionalFieldExecutionReceipt | undefined;
    const recall = fixture.service.recall.bind(fixture.service);
    vi.spyOn(fixture.service, "recall").mockImplementation(async (...args) => {
      const result = await recall(...args);
      settled = result.execution_receipt;
      prepared = structuredClone(settled);
      return result;
    });
    const record = fixture.recorder.recordDelivery.bind(fixture.recorder);
    fixture.recorder.recordDelivery = async (...args) => {
      if (fail) fixture.database.connection.prepare("UPDATE source_records SET source_body = NULL WHERE workspace_id = ?").run(WS);
      return await record(...args);
    };
    const response = fixture.handler(fixture.request, fixture.context);
    if (fail) await expect(response).rejects.toThrow(/generation/);
    else await response;
    expect(prepared).toBeDefined();
    expect(settled!.actual!.native_visits - prepared!.actual!.native_visits).toBe(2 * SNAPSHOT_PIN_NATIVE_WORK);
    expect(settled!.actual!.phases.index.native_visits - prepared!.actual!.phases.index.native_visits).toBe(2 * SNAPSHOT_PIN_NATIVE_WORK);
    expect(workerActualCostOf(settled).native_visits - workerActualCostOf(prepared).native_visits).toBe(SNAPSHOT_PIN_NATIVE_WORK);
  } finally { await fixture.close(); }
}, 30_000);

async function sourceWorkerFixture(body: string, count = 1) {
  const directory = await mkdtemp(join(tmpdir(), "alaya-source-delivery-"));
  const filename = join(directory, "alaya.db");
  const { database } = await openSourceSlice(() => {}, filename);
  const records = new SqliteFieldSourceRecordRepo(database, fieldSha256);
  for (let index = 0; index < count; index += 1) records.insert(hashedRecord(WS, body, `source-${index}`));
  const client = createRecallReadWorkerClient({ databaseFilename: filename, workerUrl: builtWorkerUrl, workerCount: 2 })!;
  await client.ready();
  const hooks: { beforeAcknowledgment?: () => void } = {};
  const port = { ...client.conditionalFieldPort,
    acknowledge: async (...args: Parameters<NonNullable<typeof client.conditionalFieldPort.acknowledge>>) => {
      hooks.beforeAcknowledgment?.();
      return await client.conditionalFieldPort.acknowledge!(...args);
    } };
  const service = new RecallService({ ...createDependencies().dependencies, now: () => NOW,
    conditionalFieldPort: port, activeConstraintsPort: client.activeConstraintsPort, readSnapshot: client.readSnapshot });
  const recorder = new TrustStateRecorder({ ready: true, clock: () => NOW, repo: new SqliteTrustStateRepo(database),
    currentSnapshotId: (workspaceId) => snapshotIdFromPin(workspaceId, new SqliteIndexedRecallProjection(database.connection).observablePin(workspaceId)),
    eventPublisher: new EventPublisher({ eventLogRepo: new SqliteEventLogRepo(database),
      runHotStateService: { apply: () => {} }, runtimeNotifier: { notify: async () => {}, notifyEntry: async () => {} } }) });
  const handler = createRecallHandler({ deps: { ...createDeps(), recallService: service, trustStateRecorder: recorder },
    now: () => NOW, generateId: randomUUID, warn: () => {} });
  return { database, client, recorder, handler, hooks, service,
    request: SoulMemorySearchRequestSchema.parse({ query: "needle", max_results: 1, result_kind_view: "source_only",
      scope_class: null, dimension: null, domain_tags: null, protocol_version: 1,
      supported_result_kinds: ["memory_entry", "source_evidence"], supports_source_evidence: true, supports_product_updates: true }),
    context: { workspaceId: WS, runId: RUN, sessionId: RUN, agentTarget: "codex" },
    receiptCounts: () => [
      database.connection.prepare("SELECT COUNT(*) AS n FROM trust_context_delivery").get(),
      database.connection.prepare("SELECT COUNT(*) AS n FROM event_log WHERE event_type = 'memory.delivered'").get()
    ],
    close: async () => { await client.close(); database.close(); closeCachedDatabase(filename); await rm(directory, { recursive: true, force: true }); }
  };
}
