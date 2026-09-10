import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  MemoryDimension,
  QueryViewSchema,
  canonicalIndexEntryIdentity,
  memoryProductStateKey,
  type FieldSnapshot,
  type FieldValue,
  type InformationIndex,
  type PayloadContinuationRequest,
  type SoulMemorySearchResponse
} from "@do-soul/alaya-protocol";
import { EventPublisher, RecallService, fieldContractSha256 } from "@do-soul/alaya-core";
import {
  continueAcceptingIndex,
  projectAcceptingIndex
} from "../../../../../../../packages/core/src/recall/conditional-field/index/project-accepting-index.js";
import {
  SqliteEventLogRepo,
  SqliteFieldSourceRecordRepo,
  SqliteTrustStateRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { createConditionalFieldObserverReaders } from "../../../../runtime/recall-read-worker/observer-operations.js";
import { createBoundedActiveConstraintsReader } from "../../../../runtime/recall-read-worker/active-constraints.js";
import { createRecallReadWorkerClient } from "../../../../runtime/recall/recall-read-worker-client.js";
import { createReportContextUsageHandler } from "../../../../mcp-memory/recall/recall-usage-handlers.js";
import { createMcpMemoryToolHandler } from "../../../../mcp-memory/tool/tool-handler.js";
import { TrustStateRecorder } from "../../../../trust/state.js";
import { createToolsCommand } from "../../../../cli/tools.js";
import { ALAYA_SYSEXITS, type AlayaCliContext } from "../../../../cli/bridge.js";
import { createDeps } from "../../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { createDependencies } from
  "../../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import {
  MEM,
  WS,
  openBoundSlice,
  plantSourceRecord,
  recallReadWorkerUrl,
  recallThroughHandler,
  toConsumer,
  type SourceSlice
} from "./planted-handler.js";
import { assertTargetConsumer } from "./consumer-contract.js";

const NOW = "2026-09-07T00:00:00.000Z";
const SOURCE_BODY = "record-only surface root for mixed recall";
const OPEN = { kind: "open" as const, valid_from: "2026-01-01T00:00:00.000Z" };
const databases = new Set<StorageDatabase>();
const directories: string[] = [];

beforeAll(() => {
  const daemonRoot = fileURLToPath(new URL("../../../../../", import.meta.url));
  const repoRoot = fileURLToPath(new URL("../../../../../../../", import.meta.url));
  const overlay = join(daemonRoot, "dist/node_modules/@do-soul");
  mkdirSync(overlay, { recursive: true });
  mkdirSync(join(repoRoot, "packages/core/dist/node_modules/@do-soul"), { recursive: true });
  for (const [from, to] of [
    [join(overlay, "alaya-core"), join(repoRoot, "packages/core")],
    [join(overlay, "alaya-protocol"), join(repoRoot, "packages/protocol")],
    [join(overlay, "alaya-storage"), join(repoRoot, "packages/storage")],
    [join(overlay, "alaya-soul"), join(repoRoot, "packages/soul")],
    [join(overlay, "alaya-graph-algorithms"), join(repoRoot, "packages/graph-algorithms")],
    [join(repoRoot, "packages/core/dist/node_modules/@do-soul/alaya-protocol"), join(repoRoot, "packages/protocol")],
    [join(repoRoot, "packages/core/dist/node_modules/@do-soul/alaya-graph-algorithms"),
      join(repoRoot, "packages/graph-algorithms")]
  ] as const) {
    if (!existsSync(from)) symlinkSync(to, from);
  }
});

afterEach(async () => {
  for (const database of databases) database.close();
  databases.clear();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function serviceFor(
  database: StorageDatabase,
  now: () => string = () => NOW,
  worker?: NonNullable<ReturnType<typeof createRecallReadWorkerClient>>,
  readers = createConditionalFieldObserverReaders(database)
) {
  const { dependencies } = createDependencies();
  const readBounded = createBoundedActiveConstraintsReader(database);
  return new RecallService({
    ...dependencies,
    now,
    activeConstraintsPort: worker?.activeConstraintsPort ?? {
      ...dependencies.activeConstraintsPort!,
      readBounded: async (request) => readBounded(request)
    },
    ...(worker === undefined
      ? { observerReaders: readers }
      : { readSnapshot: worker.readSnapshot, conditionalFieldPort: worker.conditionalFieldPort })
  });
}

function recorderFor(database: StorageDatabase) {
  return new TrustStateRecorder({
    ready: true,
    clock: () => NOW,
    repo: new SqliteTrustStateRepo(database),
    eventPublisher: new EventPublisher({
      eventLogRepo: new SqliteEventLogRepo(database),
      runHotStateService: { apply: () => {} },
      runtimeNotifier: { notify: async () => {}, notifyEntry: async () => {} }
    })
  });
}

let generatedIds = 0;

function handlerFor(
  database: StorageDatabase,
  service = serviceFor(database),
  now: () => string = () => NOW
) {
  const sourceRepo = new SqliteFieldSourceRecordRepo(database, fieldContractSha256);
  return createMcpMemoryToolHandler({
    ...createDeps(),
    generateId: () => `00000000-0000-4000-8000-${String(++generatedIds).padStart(12, "0")}`,
    now,
    recallService: service,
    trustStateRecorder: recorderFor(database),
    fieldSource: {
      findRecordById: (workspaceId, recordId) => sourceRepo.findById(workspaceId, recordId)
    }
  });
}

const context = { workspaceId: WS, runId: "run-cp09", agentTarget: "codex", sessionId: "cp09" };

async function callRecall(
  handler: ReturnType<typeof handlerFor>,
  input: Readonly<{
    readonly query: string;
    readonly max_results: number;
    readonly continuation?: InformationIndex["continuation"];
    readonly result_kind_view?: "mixed" | "memory_only" | "source_only";
    readonly enumeration_policy?: "canonical" | "associative";
    readonly payload_continuation?: PayloadContinuationRequest;
  }>
) {
  const response = await handler.call({
    toolName: "soul.recall",
    arguments: {
      query: input.query,
      max_results: input.max_results,
      scope_class: null,
      dimension: null,
      domain_tags: null,
      ...(input.continuation == null ? {} : { continuation: input.continuation }),
      ...(input.result_kind_view === undefined ? {} : { result_kind_view: input.result_kind_view }),
      ...(input.enumeration_policy === undefined ? {} : { enumeration_policy: input.enumeration_policy }),
      ...(input.payload_continuation === undefined ? {} : { payload_continuation: input.payload_continuation })
    },
    context
  });
  if (!response.ok) throw new Error(response.error.message);
  return response.output as SoulMemorySearchResponse & { index: InformationIndex };
}

function milligradeValue(objectId: string, milligrades: number): FieldValue {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    state: memoryProductStateKey({
      workspace_id: WS,
      object_id: objectId,
      source_revision: "rev",
      program_state: "accepting",
      hypothesis_id: "h0",
      binding_context: "default",
      time_state: "as_of"
    }),
    milligrades,
    accepting: true
  };
}

function snapshotOf(values: readonly FieldValue[]): FieldSnapshot {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    snapshot_id: `sha256:${"c".repeat(64)}`,
    query_id: "failed-deployment",
    seeds: [],
    values,
    retained_transitions: [],
    facets: []
  };
}

function openObserver(): NonNullable<Parameters<typeof projectAcceptingIndex>[0]["observer"]> {
  return {
    outcome: { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, status: "open" },
    open_regions: [{
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      region_id: "seed",
      kind: "seed",
      status: "open"
    }]
  };
}

function projectTypedUpdateIndex(): InformationIndex {
  const a = milligradeValue("aaaaaaaa-aaaa-4aaa-8aaa-000000000201", 600);
  const b = milligradeValue("aaaaaaaa-aaaa-4aaa-8aaa-000000000202", 900);
  const budget = {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    work_units: 64,
    page_budget: 1,
    memory_bytes: 65_536,
    min_envelope: 1,
    finalization_reserve: 16
  };
  const view = QueryViewSchema.parse({
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    enumeration_policy: "associative",
    result_kind_view: "mixed",
    include_routing_only: false,
    requested_roles: ["requested", "associated"]
  });
  const base = {
    view,
    observer: openObserver(),
    query_id: "failed-deployment",
    snapshot_id: `sha256:${"c".repeat(64)}`,
    result_version: "v1",
    budget,
    expires_at: "2099-01-01T00:00:00.000Z"
  };
  const first = projectAcceptingIndex({ ...base, snapshot: snapshotOf([a]) });
  const second = continueAcceptingIndex(first, { ...base, snapshot: snapshotOf([a, b]) });
  return continueAcceptingIndex(second, {
    ...base,
    snapshot: snapshotOf([{ ...a, milligrades: 950 }, b])
  });
}



describe("CP09 worker MCP CLI surfaces", () => {
  it("delivers a source-record-only root and accepts span usage without object_id", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    const record = plantSourceRecord(slice.database, SOURCE_BODY);
    const gardenBefore = slice.pendingGarden().length;
    const mcp = await recallThroughHandler(slice, {
      query: SOURCE_BODY,
      max_results: 32,
      result_kind_view: "source_only"
    });
    expect(assertTargetConsumer(toConsumer(mcp, "mcp"))).toEqual([]);
    expect(slice.pendingGarden()).toHaveLength(gardenBefore);
    const result = mcp.results.find((row) => row.object_kind === "source_evidence");
    expect(result?.object_id).toBeUndefined();
    if (result?.target.kind !== "source_evidence") throw new Error("expected source_evidence");
    expect(result.target).toMatchObject({
      root_kind: "source_record",
      root_id: record.record_id,
      evidence_object_id: null
    });
    expect(result.target.span).toBeDefined();

    const handler = handlerFor(slice.database, serviceFor(slice.database));
    const delivered = await callRecall(handler, {
      query: SOURCE_BODY,
      max_results: 32,
      result_kind_view: "source_only"
    });
    const deliveredSource = delivered.results.find((row) => row.object_kind === "source_evidence");
    if (deliveredSource?.target.kind !== "source_evidence") throw new Error("expected delivered source");
    const usage = createReportContextUsageHandler({
      deps: {
        ...createDeps(),
        trustStateRecorder: recorderFor(slice.database),
        fieldSource: {
          findRecordById: (workspaceId, recordId) =>
            new SqliteFieldSourceRecordRepo(slice.database, fieldContractSha256)
              .findById(workspaceId, recordId)
        }
      },
      now: () => NOW,
      warn: () => undefined
    });
    const accepted = await usage({
      delivery_id: delivered.delivery_id,
      usage_state: "used",
      delivered_objects: [{
        object_kind: "source_evidence",
        target: deliveredSource.target,
        usage_status: "used"
      }]
    }, context);
    expect(accepted.status).toBe("recorded");
    await expect(usage({
      delivery_id: delivered.delivery_id,
      usage_state: "used",
      delivered_objects: [{
        object_id: "ffffffffffffffffffffffffffffffff",
        object_kind: "source_evidence",
        target: deliveredSource.target,
        usage_status: "used"
      }]
    }, context)).rejects.toThrow(/must not fill object_id/);
  });

  it("encodes a projector typed-update index through executeRecall, MCP, and CLI", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    const index = projectTypedUpdateIndex();
    expect(index.page_purpose).toBe("update");
    expect(index.product_updates).toHaveLength(1);
    const { dependencies } = createDependencies();
    const service = new RecallService({
      ...dependencies,
      now: () => NOW,
      observerReaders: createConditionalFieldObserverReaders(slice.database),
      conditionalFieldPort: {
        recall: async () => ({
          index,
          previews: Object.fromEntries(index.entries.flatMap((entry) => {
            const preview = entry.object_id === "aaaaaaaa-aaaa-4aaa-8aaa-000000000202" ? "needle b" : "needle a";
            return entry.object_id === undefined ? [] : [[entry.object_id, preview] as const];
          }))
        })
      }
    });
    const handler = handlerFor(slice.database, service);
    const mcp = await callRecall(handler, {
      query: "yesterday failed deployment",
      max_results: 1,
      enumeration_policy: "associative"
    });
    expect(mcp.page_purpose).toBe("update");
    expect(mcp.index.page_purpose).toBe("update");
    expect(mcp.product_updates).toEqual(index.product_updates);
    const command = createToolsCommand({
      handler,
      defaultWorkspaceId: WS,
      defaultAgentTarget: "codex"
    });
    const parsed = command.argsSchema.safeParse([
      "call",
      "soul.recall",
      JSON.stringify({
        query: "yesterday failed deployment",
        scope_class: null,
        dimension: null,
        domain_tags: null,
        max_results: 1,
        enumeration_policy: "associative"
      }),
      "--workspace",
      WS
    ]);
    if (!parsed.success) throw new Error("CLI args parse failed");
    const cli = await command.handler(cliContext(), parsed.data);
    expect(cli.exitCode).toBe(ALAYA_SYSEXITS.OK);
    const json = cli.json as SoulMemorySearchResponse;
    expect(json.page_purpose).toBe("update");
    expect(json.product_updates).toEqual(index.product_updates);
  });

  it("keeps direct and native worker mixed-kind product identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "alaya-cp09-mixed-"));
    directories.push(directory);
    const filename = join(directory, "field.sqlite");
    const slice = await openBoundSlice((database) => databases.add(database), filename);
    await slice.writeMemory(MEM.r, `memory ${SOURCE_BODY}`, MemoryDimension.FACT);
    const record = plantSourceRecord(slice.database, SOURCE_BODY);
    const worker = createRecallReadWorkerClient({
      databaseFilename: filename,
      workerCount: 1,
      workerUrl: recallReadWorkerUrl()
    });
    if (worker === null) throw new Error("real worker required");
    try {
      await worker.ready();
      const query = { query: SOURCE_BODY, max_results: 32, result_kind_view: "mixed" as const };
      const direct = await callRecall(handlerFor(slice.database, serviceFor(slice.database)), query);
      const native = await callRecall(handlerFor(slice.database, serviceFor(slice.database, () => NOW, worker)), query);
      expect(native.index.entries.map(canonicalIndexEntryIdentity))
        .toEqual(direct.index.entries.map(canonicalIndexEntryIdentity));
      expect(native.results.map((row) => row.object_kind).sort())
        .toEqual(direct.results.map((row) => row.object_kind).sort());
      expect(native.results.some((row) => row.object_kind === "source_evidence")).toBe(true);
      expect(native.results.some((row) => row.object_id === MEM.r)).toBe(true);
      expect(native.results.find((row) => row.object_kind === "source_evidence")?.target)
        .toMatchObject({ root_kind: "source_record", root_id: record.record_id, evidence_object_id: null });
      expect(native.results.find((row) => row.object_kind === "source_evidence")?.object_id)
        .toBeUndefined();
    } finally {
      await worker.close();
    }
  });

  it("invalidates continuation after worker restart and lease expiry without protected bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "alaya-cp09-lease-"));
    directories.push(directory);
    const filename = join(directory, "field.sqlite");
    const slice = await openBoundSlice((database) => databases.add(database), filename);
    plantSourceRecord(slice.database, SOURCE_BODY);
    await slice.writeMemory(MEM.r, "needle first", MemoryDimension.FACT);
    await slice.writeMemory(MEM.c, "needle second", MemoryDimension.FACT);
    const firstWorker = createRecallReadWorkerClient({
      databaseFilename: filename, workerCount: 1, workerUrl: recallReadWorkerUrl()
    });
    if (firstWorker === null) throw new Error("real worker required");
    let first: Awaited<ReturnType<typeof callRecall>>;
    try {
      await firstWorker.ready();
      const handler = handlerFor(slice.database, serviceFor(slice.database, () => NOW, firstWorker));
      first = await callRecall(handler, { query: "needle", max_results: 1 });
      expect(first.index.continuation).not.toBeNull();
      const second = await callRecall(handler, {
        query: "needle",
        max_results: 1,
        continuation: first.index.continuation
      });
      const replayed = await callRecall(handler, {
        query: "needle",
        max_results: 1,
        continuation: first.index.continuation
      });
      expect(replayed.page_purpose).toBe("retry");
      expect(replayed.delivery_id).toBe(second.delivery_id);
      expect(replayed.results.map((row) => row.object_id ?? row.target)).toEqual(
        second.results.map((row) => row.object_id ?? row.target)
      );
    } finally {
      await firstWorker.close();
    }
    const restarted = createRecallReadWorkerClient({
      databaseFilename: filename, workerCount: 1, workerUrl: recallReadWorkerUrl()
    });
    if (restarted === null) throw new Error("real worker required");
    try {
      await restarted.ready();
      const lost = await callRecall(
        handlerFor(slice.database, serviceFor(slice.database, () => NOW, restarted)),
        { query: "needle", max_results: 1, continuation: first.index.continuation }
      );
      expect(lost.index.completeness.logical_index).toBe("invalidated");
      expect(lost.index.continuation).toBeNull();
      expect(JSON.stringify(lost)).not.toContain(SOURCE_BODY);
      expect(JSON.stringify(lost.results)).not.toContain("needle first");
    } finally {
      await restarted.close();
    }
    let now = NOW;
    const live = createRecallReadWorkerClient({
      databaseFilename: filename, workerCount: 1, workerUrl: recallReadWorkerUrl()
    });
    if (live === null) throw new Error("real worker required");
    try {
      await live.ready();
      const opened = await callRecall(
        handlerFor(slice.database, serviceFor(slice.database, () => now, live)),
        { query: "needle", max_results: 1 }
      );
      now = "2026-09-07T01:00:00.000Z";
      const expired = await callRecall(
        handlerFor(slice.database, serviceFor(slice.database, () => now, live)),
        { query: "needle", max_results: 1, continuation: opened.index.continuation }
      );
      expect(expired.index.completeness.logical_index).toBe("invalidated");
      expect(expired.index.continuation).toBeNull();
    } finally {
      await live.close();
    }
  });

  it("replays a terminal last page with the same delivery_id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "alaya-cp09-last-page-"));
    directories.push(directory);
    const filename = join(directory, "field.sqlite");
    const slice = await openBoundSlice((database) => databases.add(database), filename);
    plantSourceRecord(slice.database, SOURCE_BODY);
    plantSourceRecord(slice.database, `${SOURCE_BODY} trailing`, "speaker-b");
    const worker = createRecallReadWorkerClient({
      databaseFilename: filename, workerCount: 1, workerUrl: recallReadWorkerUrl()
    });
    if (worker === null) throw new Error("real worker required");
    try {
      await worker.ready();
      const handler = handlerFor(slice.database, serviceFor(slice.database, () => NOW, worker));
      const query = { query: SOURCE_BODY, max_results: 1, result_kind_view: "source_only" as const };
      const first = await callRecall(handler, query);
      expect(first.index.continuation).not.toBeNull();
      const last = await callRecall(handler, { ...query, continuation: first.index.continuation });
      expect(last.index.continuation).toBeNull();
      expect(last.results.length).toBeGreaterThan(0);
      const retry = await callRecall(handler, { ...query, continuation: first.index.continuation });
      expect(retry.page_purpose).toBe("retry");
      expect(retry.delivery_id).toBe(last.delivery_id);
      expect(retry.results.map((row) => row.object_id ?? row.target)).toEqual(
        last.results.map((row) => row.object_id ?? row.target)
      );
    } finally {
      await worker.close();
    }
  });

  it("does not re-expose a withdrawn source on native-worker issued-page retry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "alaya-cp09-withdraw-"));
    directories.push(directory);
    const filename = join(directory, "field.sqlite");
    const slice = await openBoundSlice((database) => databases.add(database), filename);
    plantSourceRecord(slice.database, SOURCE_BODY);
    plantSourceRecord(slice.database, `${SOURCE_BODY} trailing`, "speaker-b");
    plantSourceRecord(slice.database, `${SOURCE_BODY} extra`, "speaker-c");
    const worker = createRecallReadWorkerClient({
      databaseFilename: filename, workerCount: 1, workerUrl: recallReadWorkerUrl()
    });
    if (worker === null) throw new Error("real worker required");
    try {
      await worker.ready();
      const handler = handlerFor(slice.database, serviceFor(slice.database, () => NOW, worker));
      const query = { query: SOURCE_BODY, max_results: 1, result_kind_view: "source_only" as const };
      const first = await callRecall(handler, query);
      expect(first.index.continuation).not.toBeNull();
      const issued = await callRecall(handler, { ...query, continuation: first.index.continuation });
      expect(issued.index.continuation).not.toBeNull();
      const issuedRoot = issued.results.find((row) => row.target.kind === "source_evidence");
      if (issuedRoot?.target.kind !== "source_evidence") throw new Error("expected issued source");
      const withdrawnId = issuedRoot.target.root_id;
      const withdrawnPreview = issuedRoot.content_preview;
      const replayed = await callRecall(handler, { ...query, continuation: first.index.continuation });
      expect(replayed.page_purpose).toBe("retry");
      expect(replayed.delivery_id).toBe(issued.delivery_id);
      expect(JSON.stringify(replayed)).toContain(withdrawnPreview);
      slice.database.connection.prepare(
        "UPDATE source_records SET source_body = NULL WHERE workspace_id = ? AND record_id = ?"
      ).run(WS, withdrawnId);
      const retry = await callRecall(handler, { ...query, continuation: first.index.continuation });
      expect(retry.index.completeness.logical_index).toBe("invalidated");
      expect(retry.results).toEqual([]);
      expect(JSON.stringify(retry)).not.toContain(withdrawnPreview);
    } finally {
      await worker.close();
    }
  });

  it("keeps mixed source rows and serves memory_only as the compatible view", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    await slice.writeMemory(MEM.r, `memory ${SOURCE_BODY}`, MemoryDimension.FACT);
    plantSourceRecord(slice.database, SOURCE_BODY);
    const handler = handlerFor(slice.database);
    const mixed = await callRecall(handler, {
      query: SOURCE_BODY,
      max_results: 32,
      result_kind_view: "mixed"
    });
    expect(mixed.results.some((row) => row.object_kind === "source_evidence")).toBe(true);
    expect(mixed.results.some((row) => row.object_kind === "memory_entry")).toBe(true);
    const compatible = await callRecall(handler, {
      query: SOURCE_BODY,
      max_results: 32,
      result_kind_view: "memory_only"
    });
    expect(compatible.results.every((row) => row.object_kind === "memory_entry")).toBe(true);
    expect(compatible.results.some((row) => row.object_kind === "source_evidence")).toBe(false);
    expect(mixed.results.some((row) => row.object_kind === "source_evidence")).toBe(true);
  });

  it("executes producer-worker-public slots for source, payload, retry, and usage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "alaya-cp09-matrix-"));
    directories.push(directory);
    const filename = join(directory, "field.sqlite");
    const slice = await openBoundSlice((database) => databases.add(database), filename);
    const longBody = `${SOURCE_BODY} ${"payload-chunk ".repeat(400)}`;
    const record = plantSourceRecord(slice.database, longBody);
    await slice.writeMemory(MEM.r, "needle matrix", MemoryDimension.FACT);
    await slice.writeMemory(MEM.c, "needle matrix two", MemoryDimension.FACT);
    const worker = createRecallReadWorkerClient({
      databaseFilename: filename, workerCount: 1, workerUrl: recallReadWorkerUrl()
    });
    if (worker === null) throw new Error("real worker required");
    try {
      await worker.ready();
      const handler = handlerFor(slice.database, serviceFor(slice.database, () => NOW, worker));
      const sourceOnly = await callRecall(handler, {
        query: SOURCE_BODY,
        max_results: 8,
        result_kind_view: "source_only"
      });
      const sourceRow = sourceOnly.results.find((row) => row.object_kind === "source_evidence");
      if (sourceRow?.target.kind !== "source_evidence") throw new Error("matrix source-only missing");
      expect(sourceRow.object_id).toBeUndefined();
      expect(sourceRow.target.root_id).toBe(record.record_id);
      expect(sourceRow.target.span).toBeDefined();

      const usage = createReportContextUsageHandler({
        deps: {
          ...createDeps(),
          trustStateRecorder: recorderFor(slice.database),
          fieldSource: {
            findRecordById: (workspaceId, recordId) =>
              new SqliteFieldSourceRecordRepo(slice.database, fieldContractSha256)
                .findById(workspaceId, recordId)
          }
        },
        now: () => NOW,
        warn: () => undefined
      });
      const used = await usage({
        delivery_id: sourceOnly.delivery_id,
        usage_state: "used",
        delivered_objects: [{
          object_kind: "source_evidence",
          target: sourceRow.target,
          usage_status: "used"
        }]
      }, context);
      expect(used.status).toBe("recorded");

      if (sourceRow.target.span !== undefined && sourceRow.target.span.content_complete === false) {
        const expanded = await callRecall(handler, {
          query: SOURCE_BODY,
          max_results: 8,
          result_kind_view: "source_only",
          payload_continuation: {
            schema_version: 1,
            purpose: "payload_expansion",
            target: sourceRow.target,
            start_offset: sourceRow.target.span.content_end
          }
        });
        const expandedRow = expanded.results.find((row) => row.object_kind === "source_evidence");
        if (expandedRow?.target.kind !== "source_evidence") throw new Error("matrix payload continuation missing");
        expect(expandedRow.target.span?.content_start).toBe(sourceRow.target.span.content_end);
        expect(expandedRow.target.span?.content_end ?? 0)
          .toBeGreaterThan(sourceRow.target.span.content_end);
      }

      const page = await callRecall(handler, { query: "needle matrix", max_results: 1 });
      expect(page.index.continuation).not.toBeNull();
      const issued = await callRecall(handler, {
        query: "needle matrix",
        max_results: 1,
        continuation: page.index.continuation
      });
      const retry = await callRecall(handler, {
        query: "needle matrix",
        max_results: 1,
        continuation: page.index.continuation
      });
      expect(retry.page_purpose).toBe("retry");
      expect(retry.delivery_id).toBe(issued.delivery_id);
    } finally {
      await worker.close();
    }
  });

  it("exposes page_purpose through in-process CLI without Garden enqueue", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    await slice.writeMemory(MEM.r, "needle cli", MemoryDimension.FACT);
    const before = slice.pendingGarden().length;
    const command = createToolsCommand({
      handler: handlerFor(slice.database),
      defaultWorkspaceId: WS,
      defaultAgentTarget: "codex"
    });
    const parsed = command.argsSchema.safeParse([
      "call",
      "soul.recall",
      JSON.stringify({
        query: "needle cli",
        scope_class: null,
        dimension: null,
        domain_tags: null,
        max_results: 8
      }),
      "--workspace",
      WS
    ]);
    if (!parsed.success) throw new Error("CLI args parse failed");
    const result = await command.handler(cliContext(), parsed.data);
    expect(result.exitCode).toBe(ALAYA_SYSEXITS.OK);
    const json = result.json as SoulMemorySearchResponse;
    expect(json.page_purpose).toBeDefined();
    expect(json.results.length).toBeGreaterThan(0);
    expect(slice.pendingGarden()).toHaveLength(before);
  });
});

function cliContext(): AlayaCliContext {
  return {
    cwd: "/tmp",
    env: {},
    argv: [],
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    isTTY: false,
    jsonRequested: true,
    daemon: { startupSteps: [] }
  };
}
