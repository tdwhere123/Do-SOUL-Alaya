import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => isolation.restore());
import { SoulInterpretationResponseSchema } from "@do-soul/alaya-protocol";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { parseWorkerOperationResult, parseWorkerOperationPayload } from "../../../runtime/recall-read-worker/operation-schemas.js";
import { CLOCK, QUERY_BUDGET, SCOPES, WS, withIndexedSources } from "./source-semantic-index-acquisition.test-support.js";

const budget = { ...QUERY_BUDGET, work_units: 2_000_000, memory_bytes: 20_000_000 };
const request = { operation: "recall" as const, accepts_unreviewed_conditional_results: true as const,
  original_query: "needle", semantic_correspondences: [], authorized_scopes: SCOPES, budget, output_byte_limit: 176340 };
const sources = Array.from({ length: 6 }, (_, index) => ({ id: `source-${index}`, text: `needle ${index}`, vector: [1, 0, 0] }));
const context = () => ({ workspaceId: WS, runId: "run", sessionId: "session", agentTarget: "bench-runner" });

it("captures public request and principal before asynchronous admission and excludes private fields before preparation", async () => {
  await withIndexedSources(sources.slice(0, 2), async fixture => {
    const client = await fixture.openClient();
    const admission = vi.fn(async () => { await Promise.resolve(); });
    const handler = createMcpMemoryToolHandler({ ...createDeps(), now: () => CLOCK,
      zeroDayToolAccess: { enforceToolAccess: admission }, sourceSemanticsPort: client.sourceSemanticsPort });
    const { operation, authorized_scopes, ...workerRequest } = request;
    const native = { workspace_id: WS, as_of: CLOCK, authorized_scopes,
      request: { ...workerRequest, kind: operation }, comparison: { profile: {} } };
    await expect(client.sourceSemanticsPort!.execute(native as never)).rejects.toThrow();
    expect(() => parseWorkerOperationPayload("conditionalField.sourceSemantics", native)).toThrow();
    expect((await handler.call({ toolName: "soul.interpretation", arguments: { ...request, candidate_profile: {} }, context: context() })).ok).toBe(false);
    expect(fixture.prepareQuery).not.toHaveBeenCalled();
    const arguments_ = structuredClone(request), principal = context();
    const pending = handler.call({ toolName: "soul.interpretation", arguments: arguments_, context: principal });
    arguments_.original_query = "changed after entry"; principal.workspaceId = "foreign"; principal.runId = "changed";
    const result = await pending;
    expect(admission).toHaveBeenLastCalledWith(WS, "soul.interpretation");
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const delivered = SoulInterpretationResponseSchema.parse(result.output);
    expect(delivered).toMatchObject({ operation: "recall", protocol_version: 12,
      index: { result_version: "ordinary-native-field.v7" } });
    if (delivered.operation !== "recall" || delivered.protocol_version !== 12) throw new Error("field recall expected");
    expect(delivered.index.entries).toHaveLength(2);
    expect(delivered.index.entries.every(row => row.target.kind === "source_evidence" && row.target.workspace_id === WS)).toBe(true);
    expect(fixture.prepareQuery).toHaveBeenLastCalledWith(expect.objectContaining({ workspace_id: WS, navigation: "needle" }));
  });
});

it("reuses public query and continuation leases and refuses retargeting, principal, expiry and snapshot mismatch without preparation", async () => {
  await withIndexedSources(sources, async fixture => {
    const client = await fixture.openClient();
    let now = CLOCK;
    const call = async (arguments_: Readonly<Record<string, unknown>>, principal = context()) => {
      const { operation, authorized_scopes, ...input } = arguments_;
      const payload = parseWorkerOperationPayload("conditionalField.sourceSemantics", { workspace_id: principal.workspaceId,
        principal: `${principal.sessionId}:${principal.runId}`, as_of: CLOCK, lifetime_now: now, authorized_scopes,
        request: { ...input, kind: operation } });
      return await client.sourceSemanticsPort!.execute(payload);
    };
    const prepare = async () => {
      const result = await call({ operation: "prepare_query", original_query: "needle", authorized_scopes: SCOPES, budget });
      if (result.kind !== "prepare_query" || result.query_handle === undefined) throw new Error("query preparation required");
      return result.query_handle;
    };
    const query_handle = await prepare(), before = fixture.prepareQuery.mock.calls.length;
    const bound = { ...request, query_handle };
    await expect(call({ ...bound, original_query: "different" })).rejects.toThrow(/retargeted/);
    await expect(call(bound, { ...context(), sessionId: "foreign" })).rejects.toThrow(/principal/);
    await expect(call({ ...bound, budget: { ...budget, work_units: budget.work_units - 1 } })).rejects.toThrow(/budget changed/);
    const initial = await call(bound), equal = await call(bound);
    if (initial.kind !== "recall" || initial.protocol_version !== 12 || equal.kind !== "recall") throw new Error("field recall required");
    expect(initial.protocol_version).toBe(12); expect(equal.request_identity).toBe(initial.request_identity);
    expect(initial.index.continuation).not.toBeNull();
    const continued = await call({ ...bound, continuation: initial.index.continuation });
    expect(continued).toMatchObject({ kind: "recall", protocol_version: 12, request_identity: initial.request_identity });
    expect(fixture.prepareQuery.mock.calls).toHaveLength(before);
    now = "2026-09-18T00:20:00.000Z";
    await expect(call(bound)).rejects.toThrow(/expired/);
    expect(fixture.prepareQuery.mock.calls).toHaveLength(before);
    now = CLOCK;
    const stale = await prepare(), preparedCount = fixture.prepareQuery.mock.calls.length;
    await fixture.admit({ id: "new-source", text: "snapshot changes" });
    await expect(call({ ...request, query_handle: stale })).rejects.toThrow(/snapshot is no longer current/);
    expect(fixture.prepareQuery.mock.calls).toHaveLength(preparedCount);
  });
});

it("admits an actual current field worker result with one coverage getter read", async () => {
  await withIndexedSources(sources.slice(0, 2), async fixture => {
    const client = await fixture.openClient(), { operation, authorized_scopes, ...input } = request;
    const result = await client.sourceSemanticsPort!.execute({ workspace_id: WS, as_of: CLOCK, authorized_scopes,
      request: { kind: operation, ...input } });
    let coverageReads = 0;
    const observed = { ...result, get coverage() { coverageReads++; return result.coverage; } };
    expect(parseWorkerOperationResult("conditionalField.sourceSemantics", observed)).toMatchObject({ kind: "recall", protocol_version: 12 });
    expect(coverageReads).toBe(1);
  });
});
