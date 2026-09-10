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
  toSourceObserverRow,
  type ObserverReaders
} from "@do-soul/alaya-core";
import { type StorageDatabase } from "@do-soul/alaya-storage";
import { createBoundedActiveConstraintsReader } from "../../../../runtime/recall-read-worker/active-constraints.js";
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
  defaultBudget,
  identityAssociationCap
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
const COMPLETE_FINALIZATION_RESERVE = 512;

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("conditional-field MCP/CLI acceptance (real producers)", () => {
  it("retains mediated config for an older log and direct config after mediated evidence is withdrawn", async () => {
    const slice = await openPlantedSlice();
    stamp(slice, MEM.l, LAST_WEEK_INSTANT);
    const mediated = await recallThroughHandler(slice, { query: "yesterday failed deployment", max_results: 800 });
    expect(mediated.index.entries.find((entry) => entry.object_id === MEM.c)?.association_milligrades).toBe(1000);
    expect(mediated.index.entries.find((entry) => entry.object_id === MEM.c)?.explanation_ids.length).toBeGreaterThan(0);
    slice.database.connection.prepare("DELETE FROM relation_assertion_evidence WHERE assertion_id = ?").run("assert-l-c");
    const direct = await recallThroughHandler(slice, { query: "yesterday failed deployment", max_results: 800 });
    expect(direct.index.entries.find((entry) => entry.object_id === MEM.c)?.association_milligrades).toBe(1000);
    expect(direct.index.explanations?.some((node) => node.leaf_ids.includes("assert-r-c"))).toBe(true);
  });

  it("keeps unhandled service, exclusion and shared-provider meanings distinct and open", async () => {
    const slice = await openPlantedSlice();
    const results = [];
    for (const query of ["yesterday failed deployment of checkout", "yesterday failed deployment of payments",
      "yesterday failed deployment but exclude previous failures", "yesterday failed deployment with shared-provider history"]) {
      results.push(await recallThroughHandler(slice, { query, max_results: 800 }));
    }
    expect(new Set(results.map((result) => result.index.query_id)).size).toBe(4);
    for (const result of results) expect(result.index.completeness.interpretation_coverage).toBe("open");
  });

  it("keeps same-service history and rejects provider-bridged other-service history", async () => {
    const slice = await openPlantedSlice();
    await plantSharedProviderBridge(slice);
    const checkout = `s=${MEM.s}`;
    const mcp = await recallAllThroughHandler(slice, "yesterday failed deployment");
    expect(mcp.entries.some((entry) =>
      entry.object_id === MEM.h && entry.output_binding.includes(checkout)
    )).toBe(false);
    expect(mcp.entries.some((entry) =>
      entry.object_id === MEM.hb && entry.output_binding.includes(checkout)
    )).toBe(false);
    const assembled = collectAssembled(slice);
    expect(assembled.some((entry) =>
      entry.object_id === MEM.h && entry.output_binding.includes(checkout)
    )).toBe(false);
    expect(assembled.some((entry) =>
      entry.object_id === MEM.hb && entry.output_binding.includes(checkout)
    )).toBe(false);
  });

  it("expose last-week config and unknown-cause history through MCP encoding", async () => {
    const slice = await openPlantedSlice();
    const mcp = await recallThroughHandler(slice, {
      query: "yesterday failed deployment",
      max_results: 800
    });
    expectMemoryBaselineWithUnknownSources(mcp.index);
    expect(assertTargetConsumer(toConsumer(mcp, "mcp"))).toEqual([]);
    expect(mcp.index.entries.find((entry) => entry.object_id === MEM.c)?.association_milligrades)
      .toBe(1000);
    expect(mcp.index.entries.find((entry) => entry.object_id === MEM.h)).toBeUndefined();
    expect(mcp.results.map((result) => result.object_id)).toEqual(
      mcp.index.entries.map((entry) => entry.object_id)
    );
    const configPreview = mcp.results.find((result) => result.object_id === MEM.c)?.content_preview ?? "";
    expect(configPreview).toMatch(/config|last week|configuration/i);
    expect(configPreview).not.toMatch(/associated unknown 850/);
    expect("ranking_authority" in mcp).toBe(false);
    expect("delivery_path" in mcp).toBe(false);
  });

  it("keeps enumeration_policy and result_kind_view through handler mapping", async () => {
    const slice = await openPlantedSlice();
    const canonical = await recallThroughHandler(slice, {
      query: "yesterday failed deployment",
      max_results: 800,
      enumeration_policy: "canonical",
      result_kind_view: "mixed"
    });
    const associative = await recallThroughHandler(slice, {
      query: "yesterday failed deployment",
      max_results: 800,
      enumeration_policy: "associative",
      result_kind_view: "mixed",
      cap_contracts: [identityAssociationCap()]
    });
    expect(associative.index.query_id).not.toBe(canonical.index.query_id);
    expect(new Set(associative.index.entries.map((entry) => entry.object_id)))
      .toEqual(new Set(canonical.index.entries.map((entry) => entry.object_id)));
    expect(associative.results.every((result) => result.target !== undefined)).toBe(true);
    expect(canonical.results.every((result) => result.object_kind === "memory_entry")).toBe(true);
  });

  it("allows a complete logical index that still contains unknown cause", async () => {
    const slice = await openPlantedSlice();
    const mcp = await recallThroughHandler(slice, {
      query: "yesterday failed deployment",
      max_results: 800,
      result_kind_view: "memory_only"
    });
    expect(mcp.index.completeness.logical_index).toBe("complete");
    expect(mcp.index.entries.some((entry) => entry.object_id === MEM.h)).toBe(false);
    expect(assertUnknownCauseAllowed(mcp.index)).toEqual([]);
  });

  it("keeps page identity through handler encoding and concatenates without a second selector", async () => {
    const slice = await openPlantedSlice();
    const session = createTickingHandlerSession(slice);
    const pages: InformationIndex[] = [];
    let continuation = null as InformationIndex["continuation"];
    for (let step = 0; step < 16; step += 1) {
      const page = await session.recall({
        query: "yesterday failed deployment",
        max_results: 1,
        continuation
      });
      pages.push(page.index);
      continuation = page.index.continuation;
      if (continuation === null) break;
    }
    const full = await recallThroughHandler(slice, {
      query: "yesterday failed deployment",
      max_results: 800
    });
    expect(assertPartialTransport(pages[0]!)).toEqual([]);
    expectMemoryBaselineWithUnknownSources(full.index);
    expect(assertPageContinuity(pages, full.index)).toEqual([]);
    expect(pages[0]?.snapshot_id).toBe(pages[1]?.snapshot_id);
    expect(pages[1]?.completeness.observed_coverage).not.toBe("invalidated");
    const stampedClock = pages[0]?.continuation?.interpretation_clock;
    expect(stampedClock).toEqual(expect.any(String));
    expect(pages[1]?.query_id).toBe(pages[0]?.query_id);
    if (pages[1]?.continuation !== null && pages[1]?.continuation !== undefined) {
      expect(pages[1].continuation.interpretation_clock).toBe(stampedClock);
    }
    const stripped = pages[0]?.continuation;
    expect(stripped).not.toBeNull();
    const { interpretation_clock: _dropped, ...withoutClock } = stripped!;
    const drifted = await session.recall({
      query: "yesterday failed deployment",
      max_results: 1,
      continuation: withoutClock
    });
    expect(drifted.index.completeness.observed_coverage).toBe("invalidated");
    expect(assertNoReselection(toConsumer(full, "mcp"), full.index.entries.map(entryIdentity)))
      .toEqual([]);
  });

  it("distinguishes logical completeness from partial transport and payload", async () => {
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

  it("reports empty exhausted versus unavailable versus cancelled", async () => {
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

  it("keeps garden enqueue and provider counters at zero on the handler path", async () => {
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
    expect(commands.index.completeness.logical_index).toBe("open");
    expect(commands.index.completeness.observed_coverage).toBe("unknown");
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
    const { dependencies } = createDependencies();
    const readBounded = createBoundedActiveConstraintsReader(slice.database);
    const service = new RecallService({
      ...dependencies,
      now: () => INTERPRETATION_CLOCK,
      observerReaders: readersFor(slice),
      activeConstraintsPort: { ...dependencies.activeConstraintsPort!, readBounded: async (request) => readBounded(request) }
    });
    const command = createToolsCommand({
      handler: createMcpMemoryToolHandler({
        ...createDeps(),
        recallService: completeBudgetService(service)
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

function createTickingHandlerSession(
  slice: Awaited<ReturnType<typeof openSourceSlice>>
) {
  const { dependencies } = createDependencies();
  const readBounded = createBoundedActiveConstraintsReader(slice.database);
  let ticks = 0;
  const service = new RecallService({
    ...dependencies,
    now: () => new Date(Date.parse(INTERPRETATION_CLOCK) + ticks++ * 1_000).toISOString(),
    observerReaders: readersFor(slice),
    activeConstraintsPort: { ...dependencies.activeConstraintsPort!, readBounded: async (request) => readBounded(request) }
  });
  const handler = createRecallHandler({
    deps: {
      recallService: completeBudgetService(service),
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
  return {
    recall(
      request: Pick<SoulMemorySearchRequest, "query" | "max_results"> & Partial<Pick<SoulMemorySearchRequest, "enumeration_policy" | "result_kind_view" | "interpretation_proposal" | "cap_contracts">> & {
        readonly continuation?: InformationIndex["continuation"];
      }
    ) {
      return invokeRecallHandler(handler, request);
    }
  };
}

async function recallThroughHandler(
  slice: Awaited<ReturnType<typeof openSourceSlice>>,
  request: Pick<SoulMemorySearchRequest, "query" | "max_results"> & Partial<Pick<SoulMemorySearchRequest, "enumeration_policy" | "result_kind_view" | "interpretation_proposal" | "cap_contracts">> & {
    readonly continuation?: InformationIndex["continuation"];
  }
) {
  return createTickingHandlerSession(slice).recall(request);
}

async function invokeRecallHandler(
  handler: ReturnType<typeof createRecallHandler>,
  request: Pick<SoulMemorySearchRequest, "query" | "max_results"> & Partial<Pick<SoulMemorySearchRequest, "enumeration_policy" | "result_kind_view" | "interpretation_proposal" | "cap_contracts">> & {
    readonly continuation?: InformationIndex["continuation"];
  }
) {
  const response = await handler({
    query: request.query,
    scope_class: null,
    dimension: null,
    domain_tags: null,
    max_results: request.max_results,
    ...(request.continuation === undefined || request.continuation === null
      ? {}
      : { continuation: request.continuation }),
    ...(request.enumeration_policy === undefined ? {} : { enumeration_policy: request.enumeration_policy }),
    ...(request.result_kind_view === undefined ? {} : { result_kind_view: request.result_kind_view }),
    ...(request.interpretation_proposal === undefined
      ? {}
      : { interpretation_proposal: request.interpretation_proposal }),
    ...(request.cap_contracts === undefined ? {} : { cap_contracts: request.cap_contracts })
  }, {
    workspaceId: WS,
    runId: null,
    agentTarget: "codex",
    sessionId: "c06"
  });
  if (response.index === undefined) throw new Error("handler omitted index");
  return { ...response, index: response.index };
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
    budget: defaultBudget({ page_budget: input.page_budget, finalization_reserve: COMPLETE_FINALIZATION_RESERVE }),
    snapshot_id: snapshotFor(slice),
    interpretation_clock: INTERPRETATION_CLOCK,
    as_of: INTERPRETATION_CLOCK,
    expires_at: "2099-01-01T00:00:00.000Z",
    readers: readersFor(slice),
    continuation: input.continuation ?? null,
    cancelled: input.cancelled === true
  });
}

function completeBudgetService(service: RecallService) {
  return {
    recall: (params: Parameters<RecallService["recall"]>[0]) => service.recall({
      ...params, budget: defaultBudget({
        page_budget: params.policyOverride?.fine_assessment.budgets.max_entries ?? 30,
        finalization_reserve: COMPLETE_FINALIZATION_RESERVE
      })
    } as Parameters<RecallService["recall"]>[0])
  };
}

function expectMemoryBaselineWithUnknownSources(index: InformationIndex): void {
  expect(index.completeness).toMatchObject({ logical_index: "open", observed_coverage: "unknown",
    transport: "open", representation: "complete" });
  expect(index.completeness.certificate_id).toBeUndefined();
  expect(index.continuation).toBeNull();
}

function toConsumer(
  response: Awaited<ReturnType<typeof recallThroughHandler>>,
  surface: "mcp" | "cli"
) {
  return {
    schema_version: 1 as const,
    surface,
    bound: true as const,
    note: "real producer",
    query_id: response.index.query_id,
    snapshot_id: response.index.snapshot_id,
    result_version: response.index.result_version,
    provider_calls: 0 as const,
    garden_enqueue: 0 as const,
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
        row: page.row === null ? null : toSourceObserverRow(page.row),
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
    snapshotPin: (workspaceId) => slice.indexProjection.observablePin(workspaceId)
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

async function plantSharedProviderBridge(slice: Awaited<ReturnType<typeof openSourceSlice>>) {
  await slice.writeMemory(MEM.p, "shared infrastructure provider used by checkout and payments", MemoryDimension.FACT);
  await slice.writeMemory(MEM.sb, "payments routing service", MemoryDimension.FACT);
  await slice.writeMemory(MEM.hb, "prior payments-service failure last month", MemoryDimension.EPISODE);
  stamp(slice, MEM.p, LAST_WEEK_INSTANT);
  stamp(slice, MEM.sb, LAST_WEEK_INSTANT);
  stamp(slice, MEM.hb, LAST_WEEK_INSTANT);
  const open = { kind: "open" as const, valid_from: "2026-01-01T00:00:00.000Z" };
  const edges = [
    ["assert-r-p", MEM.r, MEM.p, "uses_service"],
    ["assert-p-hb", MEM.p, MEM.hb, "service_history"],
    ["assert-sb-hb", MEM.sb, MEM.hb, "service_history"]
  ] as const;
  for (const [index, [assertionId, sourceId, targetId, relationKind]] of edges.entries()) {
    await slice.admitRelation({
      evidenceId: `bbbbbbbb-bbbb-4bbb-8bbb-${String(index + 207).padStart(12, "0")}`,
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

async function recallAllThroughHandler(
  slice: Awaited<ReturnType<typeof openSourceSlice>>,
  query: string
) {
  const session = createTickingHandlerSession(slice);
  const entries: InformationIndex["entries"][number][] = [];
  let continuation = null as InformationIndex["continuation"];
  for (let step = 0; step < 32; step += 1) {
    const page = await session.recall({ query, max_results: 800, continuation });
    entries.push(...page.index.entries);
    continuation = page.index.continuation;
    if (continuation === null) break;
  }
  return { entries };
}

function collectAssembled(slice: Awaited<ReturnType<typeof openSourceSlice>>) {
  const entries: InformationIndex["entries"][number][] = [];
  let continuation = null as InformationIndex["continuation"];
  for (let step = 0; step < 32; step += 1) {
    const page = runProducer(slice, { page_budget: 800, continuation });
    entries.push(...page.entries);
    continuation = page.continuation;
    if (continuation === null) break;
  }
  return entries;
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
    "UPDATE memory_entries SET event_time_start = ?, updated_at = ? WHERE object_id = ?"
  ).run(instant, instant, objectId);
}
