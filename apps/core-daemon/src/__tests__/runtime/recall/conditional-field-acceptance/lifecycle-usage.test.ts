import { mkdtemp, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryDimension, type InformationIndex, type SoulMemorySearchResponse, type UsageReport } from "@do-soul/alaya-protocol";
import { capableRecallConsumerDeclaration, EventPublisher, RecallService, attributeUsageReports } from "@do-soul/alaya-core";
import { SqliteTrustStateRepo, SqliteEventLogRepo, SqliteMemoryEntryRepo, SqliteRunRepo, initDatabase, type StorageDatabase } from "@do-soul/alaya-storage";
import { createConditionalFieldObserverReaders } from "../../../../runtime/recall-read-worker/observer-operations.js";
import { createBoundedActiveConstraintsReader } from "../../../../runtime/recall-read-worker/active-constraints.js";
import { createRecallReadWorkerClient } from "../../../../runtime/recall/recall-read-worker-client.js";
import { createMcpMemoryToolHandler } from "../../../../mcp-memory/tool/tool-handler.js";
import { TrustStateRecorder } from "../../../../trust/state.js";
import { createToolsCommand } from "../../../../cli/tools.js";
import { createDeps } from "../../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { createDependencies, createTaskSurface } from "../../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import { openSourceSlice, WS, RUN, MEM } from "../../../../../../../packages/core/src/__tests__/recall/conditional-field/vertical/source-slice.js";
import { compileConditionalFieldQuery } from "../../../../../../../packages/core/src/recall/conditional-field/query/compile-query.js";
import { observeConditionalField, startObserverCursor } from "../../../../../../../packages/core/src/recall/conditional-field/observers/observe.js";

const NOW = "2026-09-07T00:00:00.000Z";
const databases = new Set<StorageDatabase>();
const directories: string[] = [];
afterEach(async () => {
  for (const db of databases) db.close();
  databases.clear();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

function serviceFor(database: StorageDatabase, now: () => string = () => NOW,
  worker?: NonNullable<ReturnType<typeof createRecallReadWorkerClient>>) {
  const { dependencies } = createDependencies();
  const readBounded = createBoundedActiveConstraintsReader(database);
  const service = new RecallService({ ...dependencies, now,
    activeConstraintsPort: worker?.activeConstraintsPort ?? {
      ...dependencies.activeConstraintsPort!, readBounded: async (request) => readBounded(request)
    },
    ...(worker === undefined ? { observerReaders: createConditionalFieldObserverReaders(database) }
      : { readSnapshot: worker.readSnapshot, conditionalFieldPort: worker.conditionalFieldPort }) });
  const recall = service.recall.bind(service);
  service.recall = (params) => recall({ ...capableRecallConsumerDeclaration(), ...params });
  return service;
}

function recorderFor(database: StorageDatabase) {
  return new TrustStateRecorder({ ready: true, clock: () => NOW,
    repo: new SqliteTrustStateRepo(database),
    eventPublisher: new EventPublisher({ eventLogRepo: new SqliteEventLogRepo(database),
      runHotStateService: { apply: () => {} }, runtimeNotifier: { notify: async () => {}, notifyEntry: async () => {} } }) });
}

function handlerFor(database: StorageDatabase, service = serviceFor(database)) {
  const memory = new SqliteMemoryEntryRepo(database);
  return createMcpMemoryToolHandler({ ...createDeps(), generateId: randomUUID, now: () => NOW, recallService: service,
    trustStateRecorder: recorderFor(database),
    memoryService: { ...createDeps().memoryService,
      findByIdScoped: async (id, workspace) => (await memory.findByIds(workspace, [id]))[0] ?? null,
      findByIdsScoped: (ids, workspace) => memory.findByIds(workspace, ids) } });
}

const context = { workspaceId: WS, runId: RUN, agentTarget: "codex", sessionId: RUN };
async function recall(handler: ReturnType<typeof handlerFor>, continuation?: InformationIndex["continuation"], max = 1) {
  const response = await handler.call({ toolName: "soul.recall", arguments: {
    protocol_version: 1, supported_result_kinds: ["memory_entry", "source_evidence"],
    supports_source_evidence: true, supports_product_updates: true,
    query: "needle", max_results: max,
    scope_class: null, dimension: null, domain_tags: null,
    ...(continuation == null ? {} : { continuation }) }, context });
  if (!response.ok) throw new Error(response.error.message);
  return response.output as SoulMemorySearchResponse & { index: InformationIndex };
}

async function collectBoundaryPages(handler: ReturnType<typeof handlerFor>) {
  const entries: InformationIndex["entries"][number][] = [];
  let continuation: InformationIndex["continuation"] = null;
  let first: InformationIndex | null = null;
  for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
    const page = await recall(handler, continuation, 8);
    first ??= page.index;
    expect(page.index.query_id).toBe(first.query_id);
    expect(page.index.snapshot_id).toBe(first.snapshot_id);
    expect(page.index.interpretation_id).toBe(first.interpretation_id);
    expect(page.index.as_of).toBe(first.as_of);
    expect(page.index.result_version).toBe(first.result_version);
    expect(page.results.map((result) => result.object_id)).toEqual(page.index.entries.map((entry) => entry.object_id));
    expect(page.results.every((result) => result.content_preview.includes("needle boundary"))).toBe(true);
    entries.push(...page.index.entries);
    continuation = page.index.continuation;
    if (continuation === null) {
      expect(page.index.completeness.observed_coverage).toBe("unknown");
      expect(page.index.completeness.logical_index).toBe("open");
      break;
    }
  }
  expect(continuation).toBeNull();
  return entries;
}

describe("conditional-field lifecycle and verified usage through actual consumers", () => {
  it("admits a timeless SQLite assertion only under the explicit reader governance policy", async () => {
    const slice = await openSourceSlice((db) => databases.add(db), ":memory:", new Set(["accepted-policy"]));
    await slice.writeMemory(MEM.r, "needle", MemoryDimension.FACT);
    await slice.writeMemory(MEM.c, "configuration", MemoryDimension.FACT);
    await slice.admitRelation({ evidenceId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000999", assertionId: "timeless-test",
      sourceId: MEM.r, targetId: MEM.c, resultObjectId: MEM.c, relationKind: "config_direct",
      validity: { kind: "timeless", governance_policy_id: "accepted-policy" }, gist: "configuration" });
    const query = compileConditionalFieldQuery({ source: "ordinary", text: "needle", snapshot_id: `sha256:${"a".repeat(64)}`,
      interpretation_clock: NOW, budget: { schema_version: 1, work_units: 100, memory_bytes: 1000000,
        page_budget: 10, finalization_reserve: 20, min_envelope: 1 } });
    const observe = (policies: readonly string[]) => observeConditionalField({ query,
      lease: { schema_version: 1, lease_id: "lease", query_id: query.query_id, snapshot_id: query.snapshot_id, status: "active" },
      cursor: startObserverCursor({ cursor_id: "adj", region_id: "adj", query_id: query.query_id, snapshot_id: query.snapshot_id }),
      action: { schema_version: 1, region_id: "adj", action: "adjacency", work_limit: 7 }, page_limit: 1,
      workspace_id: WS, relation_subject: MEM.r, relation_kind: "config_direct", as_of: NOW,
      readers: createConditionalFieldObserverReaders(slice.database, policies) });
    expect(observe([]).page.observations).toEqual([]);
    expect(observe(["accepted-policy"]).page.observations.map((row) => row.object_id)).toEqual([MEM.c]);
  });

  it.each([false, true])("invalidates changed source and expired tokens through direct/worker=%s MCP", async (workerMode) => {
    const dir = await mkdtemp(join(tmpdir(), "alaya-field-lifecycle-")); directories.push(dir);
    const filename = join(dir, "field.sqlite");
    const slice = await openSourceSlice((db) => databases.add(db), filename);
    for (const [id, text] of [[MEM.r, "needle first"], [MEM.c, "needle second"], [MEM.h, "needle third"]]) {
      await slice.writeMemory(id!, text!, MemoryDimension.FACT);
    }
    const worker = workerMode ? createRecallReadWorkerClient({ databaseFilename: filename, workerCount: 1,
      workerUrl: new URL("../../../../../dist/runtime/recall/recall-read-worker.js", import.meta.url) })! : undefined;
    try {
      if (worker) await worker.ready();
      let now = NOW;
      const service = serviceFor(slice.database, () => now, worker);
      const handler = handlerFor(slice.database, service);
      const cancelled = await service.recall({ workspaceId: WS, taskSurface: { ...createTaskSurface(), display_name: "needle" },
        strategy: "chat", cancelled: true });
      expect(cancelled.index!.completeness.observed_coverage).toBe("cancelled");
      expect(cancelled.index!.entries).toEqual([]);
      const first = await recall(handler);
      expect(first.index.continuation).not.toBeNull();
      expect(first.results[0]?.content_preview).toContain("needle");
      now = "2026-09-07T01:00:00.000Z";
      const expired = await recall(handler, first.index.continuation);
      expect(expired.index.completeness.logical_index).toBe("invalidated");
      expect(expired.index.continuation).toBeNull();
      const beforeChange = await recall(handler);
      await slice.memoryEntryRepo.update(MEM.c, { content: "removed lexical match", updated_at: now });
      const changed = await recall(handler, beforeChange.index.continuation);
      expect(changed.index.completeness.logical_index).toBe("invalidated");
      expect(changed.index.entries).toEqual([]);
      const beforeScope = await recall(handler);
      slice.database.connection.prepare("UPDATE memory_entries SET scope_class = ?, updated_at = ? WHERE object_id = ?")
        .run("global_core", "2026-09-07T01:01:00.000Z", MEM.h);
      const scopeChanged = await recall(handler, beforeScope.index.continuation);
      expect(scopeChanged.index.completeness.logical_index).toBe("invalidated");
    } finally { await worker?.close(); }
  });

  it("recovers all 40 matches across native32 worker pages and preserves the pinned midnight interpretation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alaya-worker-boundary-")); directories.push(dir);
    const filename = join(dir, "field.sqlite");
    const slice = await openSourceSlice((db) => databases.add(db), filename);
    const ids = Array.from({ length: 40 }, (_, index) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(index + 2000).padStart(12, "0")}`);
    for (const id of ids) await slice.writeMemory(id, "needle boundary", MemoryDimension.FACT);
    const worker = createRecallReadWorkerClient({ databaseFilename: filename, workerCount: 1,
      workerUrl: new URL("../../../../../dist/runtime/recall/recall-read-worker.js", import.meta.url) });
    if (worker === null) throw new Error("real worker required");
    try {
      await worker.ready();
      let now = "2026-09-07T23:59:59.000Z";
      const direct = await collectBoundaryPages(handlerFor(slice.database, serviceFor(slice.database, () => now)));
      const service = serviceFor(slice.database, () => now, worker);
      const handler = handlerFor(slice.database, service);
      const entries = await collectBoundaryPages(handler);
      expect(entries).toEqual(direct);
      expect(entries).toHaveLength(40);
      expect(new Set(entries.map((entry) => entry.object_id))).toEqual(new Set(ids));
      let evening = await recall(handler, null, 8);
      for (let attempt = 0; evening.index.entries.length === 0 && attempt < 20; attempt += 1) {
        expect(evening.index.continuation).not.toBeNull();
        evening = await recall(handler, evening.index.continuation, 8);
      }
      expect(evening.index.entries.length).toBeGreaterThan(0);
      expect(evening.index.continuation).not.toBeNull();
      expect(evening.index.as_of).toBe(now);
      now = "2026-09-08T00:00:01.000Z";
      const morning = await recall(handler, evening.index.continuation, 8);
      expect(morning.index.entries.length).toBeGreaterThan(0);
      expect(morning.index).toMatchObject({ query_id: evening.index.query_id,
        snapshot_id: evening.index.snapshot_id, interpretation_id: evening.index.interpretation_id,
        result_version: evening.index.result_version, as_of: evening.index.as_of });
      expect(morning.index.entries.every((entry) => entry.time_state === evening.index.as_of)).toBe(true);
      expect(morning.index.continuation?.interpretation_clock).toBe(evening.index.as_of);
    } finally { await worker.close(); }
  });

  it("admits source validity at semantic as-of and recovers all identities after low memory", async () => {
    const slice = await openSourceSlice((db) => databases.add(db));
    for (const id of [MEM.r, MEM.c, MEM.h]) await slice.writeMemory(id, "needle", MemoryDimension.FACT);
    slice.database.connection.prepare("UPDATE memory_entries SET valid_to = ? WHERE object_id = ?").run(NOW, MEM.c);
    slice.database.connection.prepare("UPDATE memory_entries SET valid_from = ? WHERE object_id = ?").run("2026-09-08T00:00:00.000Z", MEM.h);
    const current = await recall(handlerFor(slice.database), null, 100);
    expect(current.index.entries.map((entry) => entry.object_id)).toEqual([MEM.r]);
    const historical = await recall(handlerFor(slice.database, serviceFor(slice.database, () => "2026-09-06T18:00:00.000Z")), null, 100);
    expect(historical.index.entries.map((entry) => entry.object_id).sort()).toEqual([MEM.r, MEM.c].sort());
    slice.database.connection.prepare("UPDATE memory_entries SET valid_from = NULL, valid_to = NULL").run();
    const service = serviceFor(slice.database);
    const params = { workspaceId: WS, taskSurface: { ...createTaskSurface(), display_name: "needle" }, strategy: "chat" as const,
      budget: { schema_version: 1 as const, work_units: 10000, memory_bytes: 600, page_budget: 100, finalization_reserve: 100, min_envelope: 1 } };
    const first = await service.recall(params);
    expect(first.index?.continuation).not.toBeNull();
    const resumed = await service.recall({ ...params, budget: { ...params.budget, memory_bytes: 1000000 },
      continuation: first.index!.continuation });
    expect([...new Set([...first.index!.entries, ...resumed.index!.entries].map((entry) => entry.object_id))].sort()).toEqual([MEM.r, MEM.c, MEM.h].sort());
    const tightReserve = await service.recall({ ...params, budget: { ...params.budget, memory_bytes: 1000000, finalization_reserve: 1 } });
    expect(tightReserve.index!.completeness.observed_coverage).toBe("unknown");
    expect(tightReserve.index!.continuation).toBeNull();
    expect(tightReserve.index!.entries.map((entry) => entry.object_id).sort()).toEqual([MEM.r, MEM.c, MEM.h].sort());
  });

  it("bounds physical lexical, source and relation visits by one request allowance", async () => {
    const slice = await openSourceSlice((db) => databases.add(db));
    for (const id of [MEM.r, MEM.c, MEM.h]) await slice.writeMemory(id, "needle", MemoryDimension.FACT);
    const readers = createConditionalFieldObserverReaders(slice.database);
    for (const work_units of [5, 8, 12, 20]) {
      let visits = 0;
      const { dependencies } = createDependencies();
      const service = new RecallService({ ...dependencies, now: () => NOW,
        observerReaders: { ...readers,
          source: (input) => { const page = readers.source!(input); visits += page.rowsRead; return page; },
          lexical: (input) => { const page = readers.lexical!(input); visits += page.nativeVisits; return page; },
          relation: (input) => { const page = readers.relation!(input); visits += page.nativeVisits; return page; } } });
      await service.recall({ ...capableRecallConsumerDeclaration(), workspaceId: WS, taskSurface: { ...createTaskSurface(), display_name: "needle" }, strategy: "chat",
        budget: { schema_version: 1 as const, work_units, memory_bytes: 1000000, page_budget: 100, finalization_reserve: 1, min_envelope: 1 } });
      expect(visits).toBeLessThanOrEqual(work_units);
    }
  });

  it.each([10, 64])("advances public page width %s with the same allowance after observation has exhausted", async (pageWidth) => {
    const slice = await openSourceSlice((db) => databases.add(db));
    const ids: string[] = [];
    for (let index = 0; index < 120; index += 1) {
      const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(index + 1000).padStart(12, "0")}`;
      ids.push(id); await slice.writeMemory(id, `needle ${index}`, MemoryDimension.FACT);
    }
    const handler = handlerFor(slice.database);
    const delivered = new Set<string>();
    const payloads = new Set<string>();
    let continuation: InformationIndex["continuation"] = null;
    for (let pageNumber = 0; pageNumber < 80; pageNumber += 1) {
      const page = await recall(handler, continuation, pageWidth);
      expect(page.index.completeness.logical_index).not.toBe("invalidated");
      const delivery = await new SqliteTrustStateRepo(slice.database).findDeliveryById(page.delivery_id);
      const audit = slice.database.connection.prepare("SELECT payload_json FROM event_log WHERE event_id = ?")
        .get(delivery!.audit_event_id) as { payload_json: string };
      expect(audit.payload_json.length).toBeLessThanOrEqual(16384);
      const payload = JSON.parse(audit.payload_json) as Record<string, unknown>;
      if ((delivery!.witness_exposures?.length ?? 0) > 0) {
        expect(payload.witness_exposures).toEqual({ count: delivery!.witness_exposures!.length,
          sha256: createHash("sha256").update(JSON.stringify(delivery!.witness_exposures), "utf8").digest("hex") });
      }
      if ((delivery!.delivered_objects?.length ?? 0) > 0) {
        expect(payload.delivered_objects).toEqual({ count: delivery!.delivered_objects!.length,
          sha256: createHash("sha256").update(JSON.stringify(delivery!.delivered_objects), "utf8").digest("hex") });
      }
      for (const entry of page.index.entries) {
        if (entry.object_id !== undefined) delivered.add(entry.object_id);
      }
      for (const result of page.results) {
        if (result.content_preview.includes("needle") && result.object_id !== undefined) {
          payloads.add(result.object_id);
        }
      }
      continuation = page.index.continuation;
      if (continuation === null) break;
    }
    expect(continuation).toBeNull();
    expect([...delivered].sort()).toEqual(ids.sort());
    expect([...payloads].sort()).toEqual(ids.sort());
  });

  it("persists real worker witness exposure, rejects forged/stale reports, and accepts CLI reporting after restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alaya-field-usage-")); directories.push(dir);
    const filename = join(dir, "usage.sqlite");
    const slice = await openSourceSlice((db) => databases.add(db), filename);
    await slice.writeMemory(MEM.r, "needle", MemoryDimension.FACT);
    const worker = createRecallReadWorkerClient({ databaseFilename: filename, workerCount: 1,
      workerUrl: new URL("../../../../../dist/runtime/recall/recall-read-worker.js", import.meta.url) });
    if (worker === null) throw new Error("real worker required");
    let handler = handlerFor(slice.database, serviceFor(slice.database, () => NOW, worker));
    let delivered: Awaited<ReturnType<typeof recall>>;
    try { await worker.ready(); delivered = await recall(handler, null, 100); }
    finally { await worker.close(); }
    expect(delivered.index.explanations?.length).toBeGreaterThan(0);
    const expandedWitnesses = new Set(delivered.index.explanations?.map((node) => node.derivation_id));
    expect(delivered.index.entries.every((entry) => entry.program_state !== undefined && entry.time_state !== undefined
      && entry.explanation_ids.every((id) => expandedWitnesses.has(id)))).toBe(true);
    const repo = new SqliteTrustStateRepo(slice.database);
    const delivery = await repo.findDeliveryById(delivered.delivery_id);
    const exposure = delivery?.witness_exposures?.[0];
    expect(exposure).toBeDefined();
    const report = { ...exposure!, reported_use: "used" as const };
    expect(attributeUsageReports([report])[0]?.witness_credit).toBe("unknown");
    expect(attributeUsageReports([report], delivery!.witness_exposures)[0]?.witness_credit).toBe("claimed");
    for (const forged of [{ ...report, witness_id: "never-exposed" }, { ...report, interpretation_id: "stale" }]) {
      const rejected = await handler.call({ toolName: "soul.report_context_usage", arguments: {
        delivery_id: delivered.delivery_id, usage_state: "used", witness_reports: [forged] }, context });
      expect(rejected.ok).toBe(false);
    }
    slice.database.close(); databases.delete(slice.database);
    const reopened = initDatabase({ filename }); databases.add(reopened);
    handler = handlerFor(reopened);
    const runs = new SqliteRunRepo(reopened);
    const command = createToolsCommand({ handler, defaultWorkspaceId: WS, defaultRunId: RUN, defaultAgentTarget: "codex",
      runService: { getById: async (id) => { const run = await runs.getById(id); if (!run) throw new Error("missing run"); return run; } } });
    const args = command.argsSchema.safeParse(["call", "soul.report_context_usage", JSON.stringify({
      delivery_id: delivered.delivery_id, usage_state: "used", witness_reports: [report] }), "--workspace", WS, "--run", RUN]);
    if (!args.success) throw new Error("CLI parse failed");
    const result = await command.handler({ cwd: dir, env: {}, argv: [], stdin: new PassThrough(), stdout: new PassThrough(),
      stderr: new PassThrough(), isTTY: false, jsonRequested: true, daemon: { startupSteps: [] } }, args.data);
    expect(result.exitCode).toBe(0);
    const history = await new SqliteTrustStateRepo(reopened).listUsageByDeliveryIds([delivered.delivery_id]);
    expect(history[0]?.witness_reports).toEqual([report]);
    const duplicate = await command.handler({ cwd: dir, env: {}, argv: [], stdin: new PassThrough(), stdout: new PassThrough(),
      stderr: new PassThrough(), isTTY: false, jsonRequested: true, daemon: { startupSteps: [] } }, args.data);
    expect(duplicate.exitCode).not.toBe(0);
    expect(await new SqliteTrustStateRepo(reopened).listUsageByDeliveryIds([delivered.delivery_id])).toHaveLength(1);
  });
});
