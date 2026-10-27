import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => isolation.restore());
import { RecallService, capableRecallConsumerDeclaration } from "@do-soul/alaya-core";
import { prepareIndexedRecallProjection } from "@do-soul/alaya-storage";
import { createDependencies, createTaskSurface } from "../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import { SoulMemorySearchResponseSchema, sourceSemanticAccessPhases } from "@do-soul/alaya-protocol";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { CLOCK, WS, withIndexedSources, QUERY_BUDGET, publicMcp, SCOPES } from "./source-semantic-index-acquisition.test-support.js";

it("preserves segmented binding through built-worker acquisition codec and ordinary MCP continuation without delivering search text", async () => {
  const text = "自动部署流水线：Alpha-BETA, release!";
  await withIndexedSources([{ id: "first", text }, { id: "second", text }], async fixture => {
    const prepared = await fixture.lifecycle.prepareLexical(WS, "segmented-unicode61.v1", {
      work: 100_000, native_bytes: 16 * 1024 * 1024, capture_page: 8, max_capture_pages: 4, max_roots: 8, max_body_bytes: 65536
    });
    expect(prepared.status).toBe("ready");
    prepareIndexedRecallProjection(fixture.database);
    const client = await fixture.openClient();
    const semantic = await publicMcp(client)({ operation: "prepare_query", original_query: "部署",
      budget: QUERY_BUDGET, authorized_scopes: SCOPES });
    if (semantic.operation !== "prepare_query" || semantic.access === undefined) throw new Error("prepared access expected");
    const captured = sourceSemanticAccessPhases(semantic.access).acquisition.result?.lexical.tokenization;
    expect(captured).toMatchObject({ cjk_state: "ready", terms: ["部署"], lexical_binding: {
      generation_id: prepared.generation!.generation_id, representation: "segmented-unicode61.v1" } });
    const service = new RecallService({ ...createDependencies().dependencies, now: () => CLOCK,
      readSnapshot: client.readSnapshot, conditionalFieldPort: client.conditionalFieldPort,
      activeConstraintsPort: client.activeConstraintsPort });
    const handler = createMcpMemoryToolHandler({ ...createDeps(), now: () => CLOCK, recallService: service });
    const request = { ...capableRecallConsumerDeclaration(), query: "部署", max_results: 1,
      scope_class: "project", dimension: null, domain_tags: null, result_kind_view: "source_only" };
    const call = async (args: object) => {
      const response = await handler.call({ toolName: "soul.recall", arguments: args,
        context: { workspaceId: WS, runId: "run", sessionId: "lexical-session", agentTarget: "codex" } });
      if (!response.ok) throw new Error(JSON.stringify(response.error));
      return SoulMemorySearchResponseSchema.parse(response.output);
    };
    const first = await call(request);
    expect(first.results[0]?.content_preview).toBe(text);
    expect(first.index?.entries[0]?.navigation?.operator).toBe("source_lexical");
    expect(first.index?.continuation).not.toBeNull();
    const calls = fixture.queryBinding.embedInputs.mock.calls.length;
    const continuation = { ...request, continuation: first.index?.continuation };
    const next = await call(continuation), replay = await call(continuation);
    expect(next.results[0]?.content_preview).toBe(text);
    expect(next.results[0]?.target).not.toEqual(first.results[0]?.target);
    expect(replay.results).toEqual(next.results);
    expect(fixture.queryBinding.embedInputs.mock.calls).toHaveLength(calls);
    fixture.repository.lexical.selectLexical(WS, "raw-unicode61.v1");
    const invalidated = await call(continuation);
    expect(invalidated.index?.completeness.logical_index).toBe("invalidated");
    expect(invalidated.results).toEqual([]);
    expect(captured?.lexical_binding?.generation_id).toBe(prepared.generation!.generation_id);
  });
});

it("ordinary Core entry prepares the original query before its compiled worker snapshot and delivers native source text", async () => {
  await withIndexedSources([
    { id: "unrelated", text: "Cobalt paints dry overnight.", vector: [0, 1, 0] },
    { id: "harbor", text: "Harbor opening was delayed by the storm.", vector: [1, 0, 0] }
  ], async fixture => {
    prepareIndexedRecallProjection(fixture.database);
    const client = await fixture.openClient();
    const service = new RecallService({ ...createDependencies(), now: () => CLOCK,
      readSnapshot: client.readSnapshot, conditionalFieldPort: client.conditionalFieldPort,
      activeConstraintsPort: client.activeConstraintsPort });
    const result = await service.recall({ workspaceId: WS, taskSurface: createTaskSurface(), strategy: "chat",
      queryText: "Harbor", budget: { ...QUERY_BUDGET, page_budget: 2 },
      ...capableRecallConsumerDeclaration(), result_kind_view: "mixed" });
    expect(fixture.queryBinding.embedInputs).toHaveBeenCalledTimes(1);
    expect(fixture.queryBinding.embedInputs.mock.calls[0]?.[0]?.[0]?.text).toBe("Harbor");
    expect(result.index.result_version).toBe("ordinary-native-field.v5");
    expect(result.index.entries[0]).toMatchObject({ target: { kind: "source_evidence" },
      navigation: { operator: "source_lexical" }, claim: "unknown" });
    expect(result.candidates[0]?.content_preview).toContain("Harbor opening");
    expect(result.index.entries.every(entry => entry.target.kind !== "source_evidence" || entry.object_id === undefined)).toBe(true);
  });
});
