import { afterEach, describe, expect, it, vi } from "vitest";
import { InformationIndexSchema, MemoryDimension, type InformationIndex, type QueryProgram } from "@do-soul/alaya-protocol";
import { RecallService, type ObserverReaders } from "@do-soul/alaya-core";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { createRecallHandler } from "../../../../mcp-memory/recall/recall-usage-handlers.js";
import { createDependencies } from "../../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import { openBoundSlice, plantDeployment, readersFor, runRecall, observeProgram, indexFromObserved, stamp } from "../../../../../../../packages/core/src/__tests__/recall/conditional-field-oracle/bound-producer.js";
import { MEM, WS } from "../../../../../../../packages/core/src/__tests__/recall/conditional-field/vertical/source-slice.js";
import { defaultBudget, INTERPRETATION_CLOCK, YESTERDAY_INSTANT, SNAPSHOT_ID } from "../../../../../../../packages/core/src/__tests__/recall/conditional-field/reference/deployment.fixture.js";
import { compileConditionalFieldQuery } from "../../../../../../../packages/core/src/recall/conditional-field/query/compile-query.js";

const databases = new Set<StorageDatabase>();
afterEach(() => { for (const database of databases) database.close(); databases.clear(); });
async function planted() {
  const slice = await openBoundSlice((database) => databases.add(database));
  await plantDeployment(slice);
  return slice;
}
function session(slice: Awaited<ReturnType<typeof planted>>, readers: ObserverReaders = readersFor(slice)) {
  const { dependencies } = createDependencies([]);
  const service = new RecallService({ ...dependencies, testOnlyAllowInMemoryFieldQuerySession: true,
    now: () => INTERPRETATION_CLOCK, observerReaders: readers });
  const handler = createRecallHandler({ deps: { recallService: service,
    trustStateRecorder: { recordDelivery: vi.fn(async (input) => ({ ...input, audit_event_id: "event1" })),
      recordUsage: vi.fn(async (input) => ({ ...input, audit_event_id: "event2" })), findDeliveryById: vi.fn(async () => null) },
    memoryService: { findByIdScoped: async () => null } }, now: () => INTERPRETATION_CLOCK,
    warn: () => undefined, generateId: () => "00000000-0000-4000-8000-000000000001" });
  return async (width = 800, continuation?: InformationIndex["continuation"]) => {
    const result = await handler({ query: "yesterday failed deployment", scope_class: null, dimension: null,
      domain_tags: null, max_results: width, ...(continuation == null ? {} : { continuation }) },
    { workspaceId: WS, runId: null, agentTarget: "codex", sessionId: "semantic-residual" });
    return InformationIndexSchema.parse(result.index);
  };
}
const key = (entry: InformationIndex["entries"][number]) => JSON.stringify([entry.object_id, entry.hypothesis_id,
  entry.output_binding, entry.program_state, entry.time_state]);

async function complete(read: ReturnType<typeof session>): Promise<InformationIndex> {
  let page = await read();
  const entries = [...page.entries];
  for (let attempt = 0; page.continuation !== null && attempt < 20; attempt += 1) {
    page = await read(800, page.continuation);
    entries.push(...page.entries);
  }
  expect(page.continuation).toBeNull();
  return { ...page, entries };
}

describe("bounded semantic residual producer-consumer regressions", () => {
  it("separates ambiguous ordinary identities and rejects a cross-query continuation", async () => {
    const slice = await planted();
    const queries = ["yesterday failure of checkout", "yesterday failure of payments"];
    const compiled = queries.map((text) => compileConditionalFieldQuery({ source: "ordinary", text,
      interpretation_clock: INTERPRETATION_CLOCK, snapshot_id: SNAPSHOT_ID, budget: defaultBudget() }));
    expect(compiled.map((item) => item.status)).toEqual(["hypotheses", "hypotheses"]);
    expect(compiled[0]!.query_id).not.toBe(compiled[1]!.query_id);
    for (let index = 0; index < 3; index += 1) {
      const id = `aaaaaaaa-aaaa-4aaa-8aaa-00000000081${index}`;
      await slice.writeMemory(id, "yesterday failure of checkout; yesterday failure of payments; failed deployment", MemoryDimension.EPISODE);
      stamp(slice, id, YESTERDAY_INSTANT);
    }
    const first = runRecall(slice, { query_text: queries[0], budget: defaultBudget({ page_budget: 1, finalization_reserve: 1000 }) });
    expect(first.continuation).not.toBeNull();
    const wrong = runRecall(slice, { query_text: queries[1], continuation: first.continuation,
      budget: defaultBudget({ page_budget: 1, finalization_reserve: 1000 }) });
    expect(wrong.completeness.logical_index).toBe("invalidated");
    expect(wrong.entries).toEqual([]);
  });

  it("delivers the independently admitted requested deployment alongside its associated outputs", async () => {
    const slice = await planted();
    const index = await session(slice)();
    expect(index.entries.find((entry) => entry.object_id === MEM.r)).toMatchObject({ role: "requested", association_milligrades: 1000 });
    expect(index.entries.some((entry) => entry.object_id === MEM.c && entry.association_milligrades === 850)).toBe(true);
    expect(index.entries.find((entry) => entry.object_id === MEM.h)).toMatchObject({ role: "associated", association_milligrades: 550 });
  });

  it("preserves unknown guard coverage through actual SQLite observation and index projection", async () => {
    const slice = await planted();
    const program = (verdict: "true" | "false" | "unresolved"): QueryProgram => ({ schema_version: 1, kind: "relation",
      relation_kind: "observed_log", source_variable: "q", target_variable: "x", facet_mode: "same_path", threshold_milligrades: 0,
      guard: { schema_version: 1, kind: "query_predicate", verdict, variable: "x", time_scope: "none", predicate_name: "log_has_proven_root_cause" } });
    const absent = observeProgram(slice, program("unresolved"), { query_text: "yesterday failed deployment" });
    expect(absent.field.residuals.some((region) => region.kind === "guard" && region.status === "unknown")).toBe(true);
    expect(absent.field.closure).toMatchObject({ observation: "unknown", requested_index: "open" });
    const index = InformationIndexSchema.parse(indexFromObserved(absent));
    expect(index.completeness).toMatchObject({ logical_index: "open", observed_coverage: "unknown" });
    expect(index.continuation).toBeNull();
    expect(index.entries).toEqual([]);
    expect(indexFromObserved(observeProgram(slice, program("true"), { query_text: "yesterday failed deployment" })).entries.some((entry) => entry.object_id === MEM.l)).toBe(true);
    expect(indexFromObserved(observeProgram(slice, program("false"), { query_text: "yesterday failed deployment" })).entries).toEqual([]);
  });

  it("one-entry MCP pages recover exactly the wide page's grounded forests", async () => {
    const slice = await planted();
    const wide = await session(slice)();
    const read = session(slice);
    const entries: InformationIndex["entries"][number][] = [];
    const forest = new Map<string, NonNullable<InformationIndex["explanations"]>[number]>();
    let continuation: InformationIndex["continuation"] = null;
    for (let count = 0; count < 30; count += 1) {
      const page = await read(1, continuation);
      expect(page.entries.length).toBeLessThanOrEqual(1);
      for (const entry of page.entries) expect(entry.explanation_ids.length).toBeGreaterThan(0);
      entries.push(...page.entries);
      for (const node of page.explanations ?? []) forest.set(node.derivation_id, node);
      continuation = page.continuation;
      if (continuation === null) { expect(page.completeness.payload).toBe("complete"); break; }
    }
    expect(continuation).toBeNull();
    expect(entries.map(key).sort()).toEqual(wide.entries.map(key).sort());
    for (const entry of entries) expect(entry.explanation_ids).toEqual(wide.entries.find((item) => key(item) === key(entry))!.explanation_ids);
    expect([...forest.values()].sort((a, b) => a.derivation_id.localeCompare(b.derivation_id)))
      .toEqual([...(wide.explanations ?? [])].sort((a, b) => a.derivation_id.localeCompare(b.derivation_id)));
  });

  it("observes actual demanded causal receipts and respects retraction and unavailable capability", async () => {
    const slice = await planted();
    const absent = await session(slice)();
    expect(absent.entries.find((entry) => entry.object_id === MEM.h)?.claim).toBe("unknown");
    await slice.admitRelation({ evidenceId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000887", assertionId: "assert-cause-live",
      sourceId: MEM.r, targetId: MEM.h, resultObjectId: MEM.h, relationKind: "common_cause",
      validity: { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" }, gist: "Accepted common cause" });
    const supported = await complete(session(slice));
    expect(supported.entries.find((entry) => entry.object_id === MEM.h)).toMatchObject({ claim: "supported", association_milligrades: 550,
      claim_proposition: { kind: "common_cause", arguments: [MEM.r, MEM.h] } });
    const native = readersFor(slice);
    const unavailable = await session(slice, { ...native, relation: (input) => input.predicate === "common_cause"
      ? { observations: [], nativeVisits: 0, nativeBytes: 0, rowsRead: 0, bytesRead: 0, truncated: false, unavailable: true }
      : native.relation!(input) })();
    expect(unavailable.completeness.observed_coverage).toBe("unavailable");
    expect(unavailable.completeness.logical_index).not.toBe("complete");
    await slice.relations.resolve({ assertionId: "assert-cause-live", workspaceId: WS, runId: null, causedBy: "test",
      resolutionKind: "retracted", reason: "source correction", resolvedAt: INTERPRETATION_CLOCK });
    const readRetracted = session(slice);
    let retracted = await readRetracted();
    const retractedEntries = [...retracted.entries];
    for (let attempt = 0; retracted.continuation !== null && attempt < 10; attempt += 1) {
      retracted = await readRetracted(800, retracted.continuation);
      retractedEntries.push(...retracted.entries);
    }
    expect(retracted.continuation).toBeNull();
    expect(retracted.completeness.logical_index).toBe("complete");
    expect(retractedEntries.find((entry) => entry.object_id === MEM.h)?.claim).toBe("unknown");
  });
});
