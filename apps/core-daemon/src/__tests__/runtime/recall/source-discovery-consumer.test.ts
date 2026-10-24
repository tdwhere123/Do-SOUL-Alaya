import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  capableRecallConsumerDeclaration,
  compileQuerySourceSketch,
  RecallService
} from "@do-soul/alaya-core";
import {
  MemoryDimension,
  ScopeClass,
  SoulMemorySearchRequestSchema,
  sourceEvidenceRootTarget,
  SoulMemorySearchResponseSchema,
  type SoulMemorySearchRequest
} from "@do-soul/alaya-protocol";
import {
  closeCachedDatabase,
  SqliteFieldSourceRecordRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { createRecallHandler } from "../../../mcp-memory/recall/recall-usage-handlers.js";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { builtWorkerUrl } from "./recall-read-worker-client-fixture.js";
import { fieldSha256, hashedRecord } from "../../../../../../packages/storage/src/__tests__/repos/field/field-contract-fixture.js";
import { createDependencies } from "../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import { MEM, NOW, RUN, WS, openSourceSlice } from "../../../../../../packages/core/src/__tests__/recall/conditional-field/vertical/source-slice.js";
import { SOURCE_DISCOVERY_CANARY } from "../../../../../../packages/core/src/__tests__/recall/conditional-field/observers/source-discovery-canary.fixture.js";
import {
  INTERPRETATION_CLOCK,
  SNAPSHOT_ID,
  defaultBudget,
  defaultView
} from "../../../../../../packages/core/src/__tests__/recall/conditional-field/reference/deployment.fixture.js";
import { prepareRetainedSourceLexicalIndex } from "../../../../../bench-runner/src/__tests__/harness/recall/source-records-worker-fixture.js";
import { createConditionalFieldObserverReaders } from "../../../runtime/recall-read-worker/observer-operations.js";
import { createToolsCommand } from "../../../cli/tools.js";
import { ALAYA_SYSEXITS } from "../../../cli/bridge.js";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";

const databases: StorageDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("source discovery consumer surfaces", () => {
  it("expands an omitted MCP payload into the exact authorized source slice through the worker", async () => {
    const canary = SOURCE_DISCOVERY_CANARY[1]!;
    const body = `${canary.intended} ${"x".repeat(8000)}`;
    const directory = await mkdtemp(join(tmpdir(), "alaya-source-discovery-"));
    const filename = join(directory, "alaya.db");
    const slice = await openSourceSlice(() => {}, filename);
    const record = new SqliteFieldSourceRecordRepo(slice.database, fieldSha256)
      .insert({ ...hashedRecord(WS, body, "intended"), scope_class: ScopeClass.PROJECT });
    const filler = `${canary.intended} filler ${"y".repeat(3000)}`;
    new SqliteFieldSourceRecordRepo(slice.database, fieldSha256).insert({ ...hashedRecord(WS, filler, "filler"), scope_class: ScopeClass.PROJECT });
    prepareRetainedSourceLexicalIndex(slice.database, WS);
    const proposal = compileQuerySourceSketch({
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      interpretation_clock: INTERPRETATION_CLOCK,
      view: { ...defaultView(), result_kind_view: "source_only" },
      sketch: { original_query: canary.original_query, relation: canary.sketch }
    }).interpretation_proposal;
    const client = createRecallReadWorkerClient({
      databaseFilename: filename, workerUrl: builtWorkerUrl, workerCount: 1
    })!;
    try {
      await client.ready();
      const service = new RecallService({
        ...createDependencies().dependencies,
        now: () => NOW,
        conditionalFieldPort: client.conditionalFieldPort,
        activeConstraintsPort: client.activeConstraintsPort,
        readSnapshot: client.readSnapshot
      });
      const handler = createRecallHandler({
        deps: { ...createDeps(), recallService: service },
        now: () => NOW,
        generateId: randomUUID,
        warn: () => undefined
      });
      const request = SoulMemorySearchRequestSchema.parse({
        ...capableRecallConsumerDeclaration(),
        query: canary.original_query,
        max_results: 8,
        result_kind_view: "source_only",
        scope_class: null,
        dimension: null,
        domain_tags: null,
        interpretation_proposal: proposal
      });
      const context = { workspaceId: WS, runId: RUN, sessionId: RUN, agentTarget: "codex" };
      const first = await handler(request, context);
      const row = first.results.find((result) => result.target?.kind === "source_evidence"
        && result.target.root_id === record.record_id);
      expect(row?.target?.kind).toBe("source_evidence");
      if (row?.target?.kind !== "source_evidence") throw new Error("source target missing");
      // Full previews and required disclosure exhaust this page; proposal reasons are optional.
      expect(row.source_lookup_reasons).toBeUndefined();
      const span = row.target.span;
      expect(row.content_preview === "[payload omitted]" || span?.content_complete === false).toBe(true);
      const start = span?.content_end ?? 0;
      const expansion = {
        ...request,
        continuation: first.index!.continuation!,
        payload_continuation: {
          schema_version: 1 as const,
          purpose: "payload_expansion" as const,
          target: sourceEvidenceRootTarget(row.target),
          start_offset: start,
          byte_budget: 4096
        }
      };
      const expanded = await handler(expansion, context);
      expect(expanded.page_purpose).toBe("payload");
      const preview = expanded.results[0]!.content_preview;
      expect(preview).not.toBe("[payload omitted]");
      expect(preview).toBe(body.slice(start, start + preview.length));
      expect(expanded.results[0]?.target).toMatchObject({
        root_id: record.record_id,
        span: { content_start: start, content_end: start + preview.length }
      });
      const repeated = await handler(expansion, context);
      expect(repeated.page_purpose).toBe("retry");
      expect(repeated.results).toEqual(expanded.results);
      expect(repeated.delivery_id).toBe(expanded.delivery_id);
      expect(expanded.results[0]?.source_lookup_reasons).toEqual(row.source_lookup_reasons);
      const nextOffset = expanded.results[0]?.target?.kind === "source_evidence"
        ? expanded.results[0].target.span?.content_end : undefined;
      if (nextOffset === undefined || expanded.index?.continuation == null) throw new Error("Missing partial-source continuation");
      const interrupted = await handler({ ...request, continuation: expanded.index.continuation,
        payload_continuation: { schema_version: 1, purpose: "payload_expansion",
          target: sourceEvidenceRootTarget(row.target), start_offset: nextOffset, byte_budget: 0 } }, context);
      expect(interrupted.results[0]?.content_preview).toBe("[payload omitted]");
      expect(interrupted.index?.completeness.payload).not.toBe("complete");
      expect(interrupted.index?.continuation).not.toBeNull();
    } finally {
      await client.close();
      slice.database.close();
      closeCachedDatabase(filename);
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("reads the intended source wording through CLI after a sqlite plant", async () => {
    const canary = SOURCE_DISCOVERY_CANARY[1]!;
    const slice = await openSourceSlice((database) => databases.push(database));
    const record = new SqliteFieldSourceRecordRepo(slice.database, fieldSha256)
      .insert({ ...hashedRecord(WS, canary.intended, "intended"), scope_class: ScopeClass.PROJECT });
    prepareRetainedSourceLexicalIndex(slice.database, WS);
    const proposal = compileQuerySourceSketch({
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      interpretation_clock: INTERPRETATION_CLOCK,
      view: { ...defaultView(), result_kind_view: "source_only" },
      sketch: { original_query: canary.original_query, relation: canary.sketch }
    }).interpretation_proposal;
    const result = await recallNativeSourcesThroughCli(slice.database, canary.original_query, proposal);
    const row = result.results.find((result) => result.target?.kind === "source_evidence"
      && result.target.root_id === record.record_id);
    expect(row?.content_preview).toBe(canary.intended);
    // Native lexical navigation does not certify the planted proposal interpretation.
    expect(row?.source_lookup_reasons).toBeUndefined();
    expect(result.index?.entries).toEqual(expect.arrayContaining([expect.objectContaining({
      target: expect.objectContaining({ kind: "source_evidence", root_id: record.record_id }),
      navigation: expect.objectContaining({ operator: "source_lexical", view: "original" })
    })]));
  });

  it.each(["source_only", "mixed", "memory_only"] as const)("resumes %s membership and invalidates old continuations after worker restart", async (view) => {
    const canary = SOURCE_DISCOVERY_CANARY[0]!;
    const directory = await mkdtemp(join(tmpdir(), "alaya-source-discovery-reopen-"));
    const filename = join(directory, "alaya.db");
    const slice = await openSourceSlice(() => {}, filename);
    const records = new SqliteFieldSourceRecordRepo(slice.database, fieldSha256);
    const intended = records.insert({ ...hashedRecord(WS, canary.intended, "intended"), scope_class: ScopeClass.PROJECT });
    records.insert({ ...hashedRecord(WS, canary.distractor, "distractor"), scope_class: ScopeClass.PROJECT });
    await slice.writeMemory(MEM.r, canary.original_query, MemoryDimension.FACT);
    await slice.writeMemory(MEM.c, `${canary.original_query} second memory`, MemoryDimension.FACT);
    prepareRetainedSourceLexicalIndex(slice.database, WS);
    slice.database.close();
    closeCachedDatabase(filename);
    const first = createRecallReadWorkerClient({
      databaseFilename: filename, workerUrl: builtWorkerUrl, workerCount: 1
    })!;
    const proposal = compileQuerySourceSketch({
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      interpretation_clock: INTERPRETATION_CLOCK,
      view: { ...defaultView(), result_kind_view: "source_only" },
      sketch: { original_query: canary.original_query, relation: canary.sketch }
    }).interpretation_proposal;
    const request = {
      workspace_id: WS,
      query_text: canary.original_query,
      budget: defaultBudget({ page_budget: 1 }),
      snapshot_id: SNAPSHOT_ID,
      interpretation_clock: INTERPRETATION_CLOCK,
      as_of: NOW,
      expires_at: "2099-01-01T00:00:00Z",
      result_kind_view: view,
      authorized_scopes: null,
      interpretation_proposal: proposal,
      protocol_version: 1 as const,
      supports_source_evidence: true as const,
      supported_result_kinds: ["memory_entry", "source_evidence"] as const
    };
    try {
      await first.ready();
      const before = await first.conditionalFieldPort.recall(request);
      expect(before.execution_receipt?.actual?.native_visits).toBeGreaterThan(0);
      expect(before.execution_receipt?.actual?.retained_bytes_current).toBeGreaterThan(0);
      expect(before.execution_receipt?.actual?.retained_bytes_current).toBeLessThanOrEqual(request.budget.memory_bytes);
      expect(before.index.continuation).not.toBeNull();
      if (before.preparation_id === undefined) throw new Error("Missing delivery preparation");
      await first.conditionalFieldPort.acknowledge!(before.preparation_id, before.index, new Map(Object.entries(before.previews)));
      const beforeIds = before.index.entries.map((entry) =>
        entry.target.kind === "source_evidence" ? entry.target.root_id : entry.target.object_id).sort();
      console.info(JSON.stringify({ sourceConsumer: view,
        firstLegalExposureIncludesIntended: beforeIds.includes(intended.record_id),
        actual: before.execution_receipt?.actual }));
      await first.close();
      const second = createRecallReadWorkerClient({
        databaseFilename: filename, workerUrl: builtWorkerUrl, workerCount: 1
      })!;
      try {
        await second.ready();
        const invalidated = await second.conditionalFieldPort.recall({ ...request, continuation: before.index.continuation });
        expect(invalidated.index.completeness.logical_index).toBe("invalidated");
        expect(invalidated.index.continuation).toBeNull();
        expect(invalidated.index.entries).toEqual([]);
        expect(JSON.stringify(invalidated)).not.toContain(canary.intended);
        const after = await second.conditionalFieldPort.recall(request);
        const afterIds = after.index.entries.map((entry) =>
          entry.target.kind === "source_evidence" ? entry.target.root_id : entry.target.object_id).sort();
        expect(afterIds).toEqual(beforeIds);
        const allIds = [...afterIds];
        let page = after;
        for (let step = 0; step < 16 && page.index.continuation !== null; step++) {
          if (page.preparation_id === undefined) throw new Error("Missing delivery preparation");
          await second.conditionalFieldPort.acknowledge!(page.preparation_id, page.index, new Map(Object.entries(page.previews)));
          page = await second.conditionalFieldPort.recall({ ...request, continuation: page.index.continuation });
          allIds.push(...page.index.entries.map((entry) => entry.target.kind === "source_evidence" ? entry.target.root_id : entry.target.object_id));
        }
        if (view !== "memory_only") expect(allIds).toContain(intended.record_id);
        if (view !== "source_only") expect(allIds).toEqual(expect.arrayContaining([MEM.r, MEM.c]));
        expect(new Set(allIds).size).toBe(allIds.length);
      } finally {
        await second.close();
      }
    } finally {
      closeCachedDatabase(filename);
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});

async function recallNativeSourcesThroughCli(
  database: StorageDatabase,
  query: string,
  interpretationProposal: SoulMemorySearchRequest["interpretation_proposal"]
) {
  const service = new RecallService({
    ...createDependencies().dependencies,
    now: () => INTERPRETATION_CLOCK,
    observerReaders: createConditionalFieldObserverReaders(database)
  });
  const command = createToolsCommand({
    handler: createMcpMemoryToolHandler({ ...createDeps(), recallService: service }),
    defaultWorkspaceId: WS,
    defaultAgentTarget: "codex"
  });
  const parsed = command.argsSchema.safeParse(["call", "soul.recall", JSON.stringify({
    ...capableRecallConsumerDeclaration(), query, max_results: 8,
    result_kind_view: "source_only", scope_class: null, dimension: null, domain_tags: null,
    interpretation_proposal: interpretationProposal
  }), "--workspace", WS]);
  if (!parsed.success) throw new Error("CLI args parse failed");
  const result = await command.handler({
    cwd: "/tmp", env: {}, argv: [], stdin: new PassThrough(), stdout: new PassThrough(),
    stderr: new PassThrough(), isTTY: false, jsonRequested: true, daemon: { startupSteps: [] }
  }, parsed.data);
  expect(result.exitCode).toBe(ALAYA_SYSEXITS.OK);
  return SoulMemorySearchResponseSchema.parse(result.json);
}
