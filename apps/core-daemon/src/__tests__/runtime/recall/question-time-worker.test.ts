import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => isolation.restore());
import { MemoryService, RecallService, capableRecallConsumerDeclaration } from "@do-soul/alaya-core";
import { SqliteMemoryEntryRepo, SqliteEventLogRepo, SqliteEvidenceCapsuleRepo } from "@do-soul/alaya-storage";
import { QUESTION_TIME_PROPOSAL_PRODUCER_ID, SoulMemorySearchResponseSchema, sourceSemanticAccessPhases } from "@do-soul/alaya-protocol";
import { createDependencies } from "../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { CLOCK, WS, digest, withIndexedSources, publicMcp, QUERY_BUDGET, SCOPES, type IndexFixture } from "./source-semantic-index-acquisition.test-support.js";

const request = { ...capableRecallConsumerDeclaration(), query: "needle", max_results: 10,
  scope_class: "project", dimension: null, domain_tags: null, result_kind_view: "mixed" };
const proposal = { schema_version: 1, producer_id: QUESTION_TIME_PROPOSAL_PRODUCER_ID,
  original_query_digest: digest("needle"), question_time: { interpretation_clock: CLOCK,
    intervals: [{ start: "2020-01-02", end: "2020-01-02" }] } };

async function mixedRecall(fixture: IndexFixture) {
  const evidence = new SqliteEvidenceCapsuleRepo(fixture.database);
  const memory = new MemoryService({ now: () => CLOCK,
    generateObjectId: () => "aaaaaaaa-aaaa-4aaa-8aaa-000000000123",
    memoryEntryRepo: new SqliteMemoryEntryRepo(fixture.database), eventLogRepo: new SqliteEventLogRepo(fixture.database),
    evidenceService: { findById: id => evidence.findById(id), findByIds: (workspace, ids) => evidence.findByIds(workspace, ids) },
    runtimeNotifier: { notifyEntry: async () => undefined } });
  await memory.create({ created_by: "user_action", dimension: "fact", source_kind: "user", formation_kind: "explicit",
    scope_class: "project", content: "needle remembered", domain_tags: [], evidence_refs: [],
    workspace_id: WS, run_id: "run-1", surface_id: null });
  const client = await fixture.openClient();
  const service = new RecallService({ ...createDependencies().dependencies, now: () => CLOCK,
    readSnapshot: client.readSnapshot, conditionalFieldPort: client.conditionalFieldPort,
    activeConstraintsPort: client.activeConstraintsPort });
  const executions = vi.spyOn(service, "recall");
  const handler = createMcpMemoryToolHandler({ ...createDeps(), now: () => CLOCK, recallService: service });
  const call = async (args: object) => {
    const response = await handler.call({ toolName: "soul.recall", arguments: args,
      context: { workspaceId: WS, runId: "run-1", sessionId: "question-time-session", agentTarget: "codex" } });
    if (!response.ok) throw new Error(JSON.stringify(response.error));
    return SoulMemorySearchResponseSchema.parse(response.output);
  };
  return { call, executions, client };
}

it("delivers a time-preferred mixed SQLite pool through the built worker and MCP, continuing without reacquisition", async () => {
  await withIndexedSources([
    { id: "old", text: "needle old", eventTime: "2020-01-01T00:00:00.000Z", vector: [1, 0, 0] },
    { id: "preferred", text: "needle preferred", eventTime: "2020-01-02T23:59:59.999Z", vector: [0, 1, 0] },
    { id: "unknown", text: "needle unknown", vector: [0, 0, 1] }
  ], async fixture => {
    const { call } = await mixedRecall(fixture);
    const baseline = await call(request);
    const preferred = await call({ ...request, interpretation_proposal: proposal });
    const root = (id: string) => fixture.targets.find(target => target.source_id === id)!.target.root_id;
    const sourceIds = (result: typeof preferred) => result.index!.entries.flatMap(entry =>
      entry.target.kind === "source_evidence" ? [entry.target.root_id] : []);
    expect(sourceIds(preferred)).toEqual([root("preferred"), ...sourceIds(baseline).filter(id => id !== root("preferred"))]);
    expect(preferred.index!.entries.map(entry => entry.target.kind)).toEqual(baseline.index!.entries.map(entry => entry.target.kind));
    expect(preferred.index!.entries.some(entry => entry.target.kind === "memory_entry")).toBe(true);
    for (const intervals of [[], [{ start: "1900-01-01", end: "1900-01-01" }]]) {
      const unchanged = await call({ ...request, interpretation_proposal: { ...proposal,
        question_time: { ...proposal.question_time, intervals } } });
      expect(unchanged.index!.entries.map(entry => [entry.target, entry.navigation]))
        .toEqual(baseline.index!.entries.map(entry => [entry.target, entry.navigation]));
      expect(unchanged.results.map(row => row.content_preview)).toEqual(baseline.results.map(row => row.content_preview));
    }
    const first = await call({ ...request, max_results: 1, interpretation_proposal: proposal });
    const entries = [...first.index!.entries];
    const calls = fixture.queryBinding.embedInputs.mock.calls.length;
    let continuation = first.index!.continuation;
    for (let page = 0; continuation !== null && page < 8; page++) {
      const args = { ...request, max_results: 1, interpretation_proposal: proposal, continuation };
      const next = await call(args), replay = await call(args);
      expect(replay.results).toEqual(next.results);
      entries.push(...next.index!.entries); continuation = next.index!.continuation;
    }
    expect(continuation).toBeNull();
    expect(entries.map(entry => [entry.target, entry.navigation]))
      .toEqual(preferred.index!.entries.map(entry => [entry.target, entry.navigation]));
    expect(fixture.queryBinding.embedInputs.mock.calls).toHaveLength(calls);
    const filtered = await call({ ...request, result_kind_view: "source_only", interpretation_proposal: proposal,
      since: "2020-01-01T00:00:00.000Z", until: "2020-01-01T23:59:59.999Z" });
    expect(sourceIds(filtered)).toEqual([root("old")]);
  });
});

it("displaces a generation-scoped native prefix with a time root and retains mixed continuation through retired cleanup", async () => {
  await withIndexedSources([
    ...Array.from({ length: 18 }, (_, i) => ({ id: `native-${i}`, text: i === 0 ? "needle needle" : "needle a",
      eventTime: i === 0 ? "2020-01-02T23:59:59.999Z" : "2020-01-01T00:00:00.000Z", vector: [1, 0, 0] })),
    { id: "time-only", text: `needle ${"noise ".repeat(100)}`, eventTime: "2020-01-02T00:00:00.000Z", vector: [-1, 0, 0] }
  ], async fixture => {
    const limits = { work: 1_000_000, native_bytes: 16 * 1024 * 1024,
      capture_page: 64, max_capture_pages: 4, max_roots: 32, max_body_bytes: 65536 };
    const retired = await fixture.lifecycle.prepareLexical(WS, "raw-unicode61.v1", limits);
    expect(retired.status).toBe("ready");
    const store = fixture.repository.lexical;
    const selected = store.beginLexical(store.selectLexical(WS, "segmented-unicode61.v1"));
    store.captureLexicalPage(WS, selected.generation_id, 64, limits);
    const active = await fixture.lifecycle.prepareLexical(WS, "segmented-unicode61.v1", { ...limits, max_capture_pages: 0 });
    expect(active.status).toBe("ready");
    const { call, executions, client } = await mixedRecall(fixture);
    const semantic = await publicMcp(client)({ operation: "prepare_query", original_query: "needle",
      budget: QUERY_BUDGET, authorized_scopes: SCOPES });
    if (semantic.operation !== "prepare_query" || semantic.access === undefined) throw new Error("worker acquisition required");
    const lexical = sourceSemanticAccessPhases(semantic.access).acquisition.result?.lexical;
    expect(lexical?.tokenization?.lexical_binding).toMatchObject({
      generation_id: active.generation!.generation_id, representation: "segmented-unicode61.v1" });
    expect(lexical?.limitations).toContain("generation_scoped_bm25_statistics");
    const root = (id: string) => fixture.targets.find(target => target.source_id === id)!.target.root_id;
    const collect = async (preferred: boolean) => {
      const args = { ...request, max_results: 2, ...(preferred ? { interpretation_proposal: proposal } : {}) };
      const first = await call(args), entries = [...first.index!.entries];
      expect(first.index!.result_version).toBe("ordinary-native-field.v6");
      if (preferred) {
        const cleanup = await fixture.lifecycle.prepareLexical(WS, "segmented-unicode61.v1", limits);
        expect(cleanup).toMatchObject({ status: "ready", reclamation: { projections: 19, targets: 19, generations: 1 } });
        expect(store.lexicalGeneration(WS, retired.generation!.generation_id)).toBeNull();
        expect(store.lexicalState(WS)?.active_generation_id).toBe(active.generation!.generation_id);
      }
      const receipt = (await executions.mock.results.at(-1)!.value).execution_receipt!;
      expect(receipt.actual!.phases.acquire!.native_bytes).toBeGreaterThan(0);
      const preparations = fixture.prepareQuery.mock.calls.length;
      let continuation = first.index!.continuation;
      expect(continuation).not.toBeNull();
      for (let page = 0; continuation !== null && page < 20; page++) {
        const nextArgs = { ...args, continuation }, next = await call(nextArgs);
        const continued = (await executions.mock.results.at(-1)!.value).execution_receipt!;
        expect(continued.actual!.phases.acquire!.native_bytes).toBe(0);
        const work = Object.entries(continued.actual!.phases).filter(([phase]) => phase !== "acquire")
          .reduce((sum, [, cost]) => {
            if (cost === null || typeof cost !== "object" || !("budget_work" in cost)
              || typeof cost.budget_work !== "number") throw new Error("live phase must retain measured work");
            return sum + cost.budget_work;
          }, 0);
        expect(work).toBeLessThanOrEqual(continued.requested_budget.work_units);
        expect(next.index!.entries.length).toBeLessThanOrEqual(2);
        const replay = await call(nextArgs);
        expect(replay.results).toEqual(next.results);
        entries.push(...next.index!.entries); continuation = next.index!.continuation;
      }
      expect(continuation).toBeNull();
      expect(fixture.prepareQuery.mock.calls).toHaveLength(preparations);
      return entries;
    };
    const baseline = await collect(false), preferred = await collect(true);
    const sourceIds = (entries: typeof baseline) => entries.flatMap(entry =>
      entry.target.kind === "source_evidence" ? [entry.target.root_id] : []);
    const original = sourceIds(baseline);
    expect(original).toHaveLength(16);
    expect(original).toContain(root("native-0"));
    expect(original).not.toContain(root("time-only"));
    const expected = [root("native-0"), root("time-only"), ...original.filter(id => id !== root("native-0"))].slice(0, 16);
    expect(sourceIds(preferred)).toEqual(expected);
    expect(preferred).toHaveLength(17);
    expect(preferred.map(entry => entry.target.kind)).toEqual(baseline.map(entry => entry.target.kind));
    expect(preferred.map(entry => entry.navigation?.access_ordinal)).toEqual(Array.from({ length: 17 }, (_, i) => i));
    const acquired = preferred.find(entry => entry.target.kind === "source_evidence" && entry.target.root_id === root("time-only"))!;
    expect(acquired.navigation).toMatchObject({ domain: "question_time", operator: "source_lexical", native_rank: 2 });
    expect(preferred.filter(entry => entry.target.kind === "source_evidence" && entry.target.root_id !== root("time-only"))
      .every(entry => entry.navigation?.domain === undefined)).toBe(true);
    expect(original.filter(id => !sourceIds(preferred).includes(id))).toHaveLength(1);
  });
});
