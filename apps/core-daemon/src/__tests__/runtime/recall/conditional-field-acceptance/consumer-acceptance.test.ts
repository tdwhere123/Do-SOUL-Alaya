import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MemoryDimension,
  type InformationIndex,
  type SoulMemorySearchRequest
} from "@do-soul/alaya-protocol";
import {
  RecallService,
  encodeRecallResult,
  runConditionalFieldRecall,
  type ObserverReaders
} from "@do-soul/alaya-core";
import { type StorageDatabase } from "@do-soul/alaya-storage";
import { ALAYA_SYSEXITS, type AlayaCliContext } from "../../../../cli/bridge.js";
import { createToolsCommand } from "../../../../cli/tools.js";
import { createRecallHandler } from "../../../../mcp-memory/recall/recall-usage-handlers.js";
import { createMcpMemoryToolHandler } from "../../../../mcp-memory/tool/tool-handler.js";
import { createDeps } from "../../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { createDependencies } from
  "../../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import {
  INTERPRETATION_CLOCK,
  LAST_WEEK_INSTANT,
  SNAPSHOT_ID,
  YESTERDAY_INSTANT,
  defaultBudget
} from "../../../../../../../packages/core/src/__tests__/recall/conditional-field/reference/deployment.fixture.js";
import {
  INAPPLICABLE_KIND,
  MEM,
  WS,
  openSourceSlice
} from "../../../../../../../packages/core/src/__tests__/recall/conditional-field/vertical/source-slice.js";
import {
  assertNoReselection,
  assertPageContinuity,
  assertPartialTransport,
  assertTargetConsumer,
  assertUnknownCauseAllowed,
  completenessDimensions,
  entryIdentity
} from "./consumer-contract.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("conditional-field MCP/CLI acceptance (real producers)", () => {
  it("A01/A02 expose last-week config and unknown-cause history through MCP encoding", async () => {
    const slice = await openPlantedSlice();
    const mcp = await recallThroughHandler(slice, {
      query: "yesterday failed deployment",
      max_results: 800
    });
    expect(assertTargetConsumer(toConsumer(mcp, "mcp"))).toEqual([]);
    expect(mcp.index.entries.find((entry) => entry.object_id === MEM.c)?.association_milligrades)
      .toBe(850);
    expect(mcp.index.entries.find((entry) => entry.object_id === MEM.h)?.association_milligrades)
      .toBe(550);
    expect(assertUnknownCauseAllowed(mcp.index)).toEqual([]);
    expect(mcp.results.map((result) => result.object_id)).toEqual(
      mcp.index.entries.map((entry) => entry.object_id)
    );
    const configPreview = mcp.results.find((result) => result.object_id === MEM.c)?.content_preview ?? "";
    expect(configPreview).toMatch(/config|last week|configuration/i);
    expect(configPreview).not.toMatch(/associated unknown 850/);
    expect("ranking_authority" in mcp).toBe(false);
    expect("delivery_path" in mcp).toBe(false);
  });

  it("A13 allows a complete logical index that still contains unknown cause", async () => {
    const slice = await openPlantedSlice();
    const index = runProducer(slice, { page_budget: 800 });
    expect(index.completeness.logical_index).toBe("complete");
    expect(assertUnknownCauseAllowed(index)).toEqual([]);
    expect(index.entries.some((entry) => entry.claim === "unknown")).toBe(true);
  });

  it("A14 keeps page identity through handler encoding and concatenates without a second selector", async () => {
    const slice = await openPlantedSlice();
    const first = await recallThroughHandler(slice, {
      query: "yesterday failed deployment",
      max_results: 1
    });
    expect(assertPartialTransport(first.index)).toEqual([]);
    const second = await recallThroughHandler(slice, {
      query: "yesterday failed deployment",
      max_results: 1,
      continuation: first.index.continuation
    });
    const full = await recallThroughHandler(slice, {
      query: "yesterday failed deployment",
      max_results: 800
    });
    expect(assertPageContinuity([first.index, second.index], {
      ...full.index,
      entries: full.index.entries.slice(0, first.index.entries.length + second.index.entries.length)
    })).toEqual([]);
    expect(first.index.snapshot_id).toBe(second.index.snapshot_id);
    expect(second.index.completeness.observed_coverage).not.toBe("invalidated");
    expect(assertNoReselection(toConsumer(full, "mcp"), full.index.entries.map(entryIdentity)))
      .toEqual([]);
  });

  it("A15 distinguishes logical completeness from partial transport and payload", async () => {
    const slice = await openPlantedSlice();
    const first = await recallThroughHandler(slice, {
      query: "yesterday failed deployment",
      max_results: 1
    });
    expect(assertPartialTransport(first.index)).toEqual([]);
    expect(completenessDimensions(first.index.completeness).slice(2, 4)).toEqual(["partial", "partial"]);
    expect(first.index.continuation).not.toBeNull();
    expect(first.index.entries).toHaveLength(1);
  });

  it("A12 reports empty exhausted versus unavailable versus cancelled", async () => {
    const empty = await openSourceSlice((database) => databases.add(database));
    const exhausted = runProducer(empty, { page_budget: 800 });
    expect(exhausted.entries).toEqual([]);
    const cancelled = runProducer(empty, { page_budget: 800, cancelled: true });
    expect(cancelled.completeness.observed_coverage).toBe("cancelled");
    expect(cancelled.completeness.logical_index).not.toBe("complete");
    const unavailable = runConditionalFieldRecall({
      workspace_id: WS,
      query_text: "yesterday failed deployment",
      budget: defaultBudget({ page_budget: 800 }),
      snapshot_id: snapshotFor(empty),
      interpretation_clock: INTERPRETATION_CLOCK,
      as_of: INTERPRETATION_CLOCK,
      expires_at: "2099-01-01T00:00:00.000Z",
      readers: {}
    });
    expect(unavailable.completeness.logical_index).not.toBe("complete");
    expect(unavailable.completeness.observed_coverage).not.toBe("exhausted_empty");
  });

  it("A17 keeps garden enqueue and provider counters at zero on the handler path", async () => {
    const slice = await openPlantedSlice();
    const before = slice.pendingGarden().length;
    const encoded = encodeRecallResult(runProducer(slice, { page_budget: 800 }));
    expect(encoded.provider_calls).toBe(0);
    expect(encoded.garden_enqueue).toBe(0);
    expect(slice.pendingGarden()).toHaveLength(before);
  });

  it("ordinary deployment rules and pnpm workspace commands are not unavailable empty indexes", async () => {
    const slice = await openPlantedSlice();
    const rules = await recallThroughHandler(slice, { query: "deployment rules", max_results: 1 });
    expect(rules.index.completeness.logical_index).not.toBe("unavailable");
    expect(rules.index.entries.length).toBeGreaterThan(0);
    expect(rules.index.continuation).not.toBeNull();
    const commands = await recallThroughHandler(slice, {
      query: "pnpm workspace commands",
      max_results: 800
    });
    expect(commands.index.completeness.observed_coverage).not.toBe("unavailable");
    expect(commands.index.query_id).not.toBe(rules.index.query_id);
    const mixed = await recallThroughHandler(slice, {
      query: "pnpm workspace commands",
      max_results: 2,
      continuation: rules.index.continuation
    });
    expect(mixed.index.completeness.observed_coverage).toBe("invalidated");
  });

  it("CLI tools call soul.recall on the planted slice matches handler index identity", async () => {
    const slice = await openPlantedSlice();
    const mcp = await recallThroughHandler(slice, {
      query: "yesterday failed deployment",
      max_results: 800
    });
    const { dependencies } = createDependencies([]);
    const service = new RecallService({
      testOnlyAllowInMemoryFieldQuerySession: true,
      ...dependencies,
      now: () => INTERPRETATION_CLOCK,
      observerReaders: readersFor(slice)
    });
    const command = createToolsCommand({
      handler: createMcpMemoryToolHandler({
        ...createDeps(),
        recallService: service
      }),
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
        max_results: 800
      }),
      "--workspace",
      WS
    ]);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("CLI args parse failed");
    const result = await command.handler(cliContext(), parsed.data);
    expect(result.exitCode).toBe(ALAYA_SYSEXITS.OK);
    const output = result.json as { readonly index?: InformationIndex };
    expect(output.index?.query_id).toBe(mcp.index.query_id);
    expect(output.index?.snapshot_id).toBe(mcp.index.snapshot_id);
    expect(output.index?.entries.map((entry) => entry.object_id))
      .toEqual(mcp.index.entries.map((entry) => entry.object_id));
  });
});

async function openPlantedSlice() {
  const slice = await openSourceSlice((database) => databases.add(database));
  await plantDeployment(slice);
  return slice;
}

async function recallThroughHandler(
  slice: Awaited<ReturnType<typeof openSourceSlice>>,
  request: Pick<SoulMemorySearchRequest, "query" | "max_results"> & {
    readonly continuation?: InformationIndex["continuation"];
  }
) {
  const { dependencies } = createDependencies([]);
  let ticks = 0;
  const service = new RecallService({
    testOnlyAllowInMemoryFieldQuerySession: true,
    ...dependencies,
    now: () => new Date(Date.parse(INTERPRETATION_CLOCK) + ticks++ * 1_000).toISOString(),
    observerReaders: readersFor(slice)
  });
  const handler = createRecallHandler({
    deps: {
      recallService: service,
      trustStateRecorder: {
        recordDelivery: vi.fn(async (input) => ({ ...input, audit_event_id: "event1" })),
        recordUsage: vi.fn(async (input) => ({ ...input, audit_event_id: "event2" })),
        findDeliveryById: vi.fn(async () => null)
      },
      memoryService: {
        findByIdScoped: async () => null
      }
    },
    now: () => INTERPRETATION_CLOCK,
    warn: () => undefined,
    generateId: () => "00000000-0000-4000-8000-000000000001"
  });
  const response = await handler({
    query: request.query,
    scope_class: null,
    dimension: null,
    domain_tags: null,
    max_results: request.max_results,
    ...(request.continuation === undefined || request.continuation === null
      ? {}
      : { continuation: request.continuation })
  }, {
    workspaceId: WS,
    runId: null,
    agentTarget: "codex",
    sessionId: "c06"
  });
  if (response.index === undefined) throw new Error("handler omitted index");
  return response;
}

function runProducer(
  slice: Awaited<ReturnType<typeof openSourceSlice>>,
  input: Readonly<{
    readonly page_budget: number;
    readonly cancelled?: boolean;
    readonly continuation?: InformationIndex["continuation"];
  }>
): InformationIndex {
  return runConditionalFieldRecall({
    workspace_id: WS,
    query_text: "yesterday failed deployment",
    budget: defaultBudget({ page_budget: input.page_budget }),
    snapshot_id: snapshotFor(slice),
    interpretation_clock: INTERPRETATION_CLOCK,
    as_of: INTERPRETATION_CLOCK,
    expires_at: "2099-01-01T00:00:00.000Z",
    readers: readersFor(slice),
    continuation: input.continuation ?? null,
    cancelled: input.cancelled === true
  });
}

function toConsumer(
  response: Awaited<ReturnType<typeof recallThroughHandler>>,
  surface: "mcp" | "cli"
) {
  return {
    schema_version: 1 as const,
    surface,
    bound: true,
    note: "real producer",
    query_id: response.index.query_id,
    snapshot_id: response.index.snapshot_id,
    result_version: response.index.result_version,
    provider_calls: 0,
    garden_enqueue: 0,
    index: response.index
  };
}

function readersFor(slice: Awaited<ReturnType<typeof openSourceSlice>>): ObserverReaders {
  const kindsSql = slice.database.connection.prepare(
    `SELECT DISTINCT relation_kind AS kind FROM relation_assertions
     WHERE workspace_id = ?
       AND (? IS NULL OR lower(json_extract(anchors_json, '$.source_anchor.object_id')) = ?)`
  );
  return {
    lexical: (input) => slice.memoryReader.lexical(
      input.workspaceId,
      input.query,
      input.limit,
      input.nativeLimit,
      input.afterObjectId
    ),
    source: (input) => {
      const page = slice.memoryReader.source(input.workspaceId, input.objectId);
      return {
        row: page.row === null
          ? null
          : {
            object_id: page.row.object_id,
            sourceRevision: page.row.sourceRevision,
            observed_at: page.row.event_time_start ?? undefined,
            content: page.row.content,
            lifecycle_state: page.row.lifecycle_state,
            retention_state: page.row.retention_state,
            scope_class: page.row.scope_class,
            evidence_refs: page.row.evidence_refs,
            valid_from: page.row.valid_from,
            valid_to: page.row.valid_to
          },
        rowsRead: page.rowsRead,
        bytesRead: page.bytesRead,
        unavailable: page.unavailable
      };
    },
    relation: (input) => slice.relationReader.read(
      input.workspaceId,
      input.subject,
      input.predicate,
      input.limit,
      input.nativeLimit,
      input.afterAssertionId
    ),
    relationKinds: (input) => {
      const subject = input.subject === null ? null : input.subject.toLowerCase();
      return (kindsSql.all(input.workspaceId, subject, subject) as { readonly kind: string }[])
        .map((row) => row.kind);
    },
    snapshotPin: () => {
      const cursor = slice.indexProjection.cursor(WS);
      return {
        source_revision: String(cursor?.appliedEventRevision ?? 1),
        ...(cursor?.appliedAt === undefined ? {} : { applied_at: cursor.appliedAt })
      };
    }
  };
}

function snapshotFor(_slice: Awaited<ReturnType<typeof openSourceSlice>>): string {
  return SNAPSHOT_ID;
}

function cliContext(overrides: Partial<AlayaCliContext> = {}): AlayaCliContext {
  return {
    cwd: "/tmp",
    env: {},
    argv: [],
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    isTTY: false,
    jsonRequested: true,
    daemon: { startupSteps: [] },
    ...overrides
  };
}

async function plantDeployment(slice: Awaited<ReturnType<typeof openSourceSlice>>) {
  await slice.writeMemory(MEM.r, "yesterday failed deployment of checkout", MemoryDimension.EPISODE);
  await slice.writeMemory(MEM.l, "deployment log for yesterday checkout failure", MemoryDimension.EPISODE);
  await slice.writeMemory(MEM.c, "last-week configuration change for checkout", MemoryDimension.FACT);
  await slice.writeMemory(MEM.s, "shared routing service for checkout", MemoryDimension.FACT);
  await slice.writeMemory(MEM.h, "prior same-service failure last month", MemoryDimension.EPISODE);
  await slice.writeMemory(MEM.u, "unrelated picnic menu", MemoryDimension.FACT);
  stamp(slice, MEM.r, YESTERDAY_INSTANT);
  stamp(slice, MEM.l, YESTERDAY_INSTANT);
  stamp(slice, MEM.c, LAST_WEEK_INSTANT);
  stamp(slice, MEM.s, LAST_WEEK_INSTANT);
  stamp(slice, MEM.h, LAST_WEEK_INSTANT);
  stamp(slice, MEM.u, LAST_WEEK_INSTANT);
  const open = { kind: "open" as const, valid_from: "2026-01-01T00:00:00.000Z" };
  const edges = [
    ["assert-r-l", MEM.r, MEM.l, "observed_log"],
    ["assert-l-c", MEM.l, MEM.c, "config_via_log"],
    ["assert-r-c", MEM.r, MEM.c, "config_direct"],
    ["assert-r-s", MEM.r, MEM.s, "uses_service"],
    ["assert-s-h", MEM.s, MEM.h, "service_history"],
    ["assert-r-u", MEM.r, MEM.u, INAPPLICABLE_KIND]
  ] as const;
  for (const [index, [assertionId, sourceId, targetId, relationKind]] of edges.entries()) {
    await slice.admitRelation({
      evidenceId: `bbbbbbbb-bbbb-4bbb-8bbb-${String(index + 201).padStart(12, "0")}`,
      assertionId,
      sourceId,
      targetId,
      resultObjectId: targetId,
      relationKind,
      validity: open,
      gist: relationKind
    });
  }
}

function stamp(
  slice: Awaited<ReturnType<typeof openSourceSlice>>,
  objectId: string,
  instant: string
): void {
  slice.database.connection.prepare(
    "UPDATE memory_entries SET created_at = ?, updated_at = ? WHERE object_id = ?"
  ).run(instant, instant, objectId);
}
