import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => { isolation.restore(); });
import { SoulInterpretationRequestSchema, SourceSemanticExecutionSchema, sourceSemanticExecutionPhases } from "@do-soul/alaya-protocol";
import { closeCachedDatabase, SqliteSourceHintReader, SqliteSourceIndexRepository } from "@do-soul/alaya-storage";
import { fieldContractSha256, SourceIndexLifecycle, sourceSemanticLibraryRequestIdentity } from "@do-soul/alaya-core";
import { createSourceSemanticInterpretationHandler } from "../../../mcp-memory/tool/interpretation-handler.js";
import { createRecallRealStorage } from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { ACCESS_BUDGET, CLOCK, WS, accessCall, accessQuery, withAccessLibrary } from "./source-semantic-access.test-support.js";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { observeSourceSemanticAccess } from "../../../runtime/recall-read-worker/source-semantic-candidate-access.js";
import type { RecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { INDEX_BUDGET, SIMULATED_CONFIGURATION } from "./source-semantic-index-acquisition.test-support.js";

const original = "Why delayed?";
const query = accessQuery(original, "postpone");
const prepare = { kind: "prepare_query" as const, original_query: original, query_semantics: query, budget: ACCESS_BUDGET };

it("uses one hinted indexed navigation to reach a source outside the bounded census through public worker preparation", async () => {
  await withAccessLibrary([
    { id: "a", text: "Granite walls." },
    { id: "middle", text: "Granite ".repeat(1000), reading: "surround", count: 40 },
    { id: "private", text: "Harbor opening was put off.", reading: "postpone", scope: "global_core" },
    { id: "z", text: "Harbor opening was put off.", reading: "postpone" }
  ], async ({ execute, filename }) => {
    const budget = { ...ACCESS_BUDGET, work_units: 200_000, memory_bytes: 4_000_000 };
    const request = { ...prepare, budget };
    const { database } = await createRecallRealStorage(() => undefined, filename);
    database.connection.prepare("UPDATE source_records SET operator_id=? WHERE source_id='a'").run("x".repeat(9000));
    database.connection.prepare("UPDATE evidence_capsules SET created_at=? WHERE source_hash IN (SELECT content_digest FROM source_records WHERE source_id IN ('z','private'))")
      .run("2026-09-19T00:00:00.000Z");
    const navigation = vi.spyOn(SqliteSourceHintReader.prototype, "pageInterpretationTextHints");
    try {
      const meter = new SourceSemanticReadBudget(budget);
      const pool = database.connection.transaction(() => observeSourceSemanticAccess({ database } as RecallReadWorkerRuntime,
        { workspace_id: WS, as_of: CLOCK, authorized_scopes: { mode: "named", scopes: ["project"] }, request: { ...request, access_hint: "Harbor" } },
        ["project"], meter, original, query, "query-conditioned-v1", budget,
        undefined, undefined, undefined, undefined, "Harbor"))();
      expect(navigation).toHaveBeenCalledOnce();
      expect(navigation.mock.calls[0]?.[0].query).toBe("Harbor");
      expect(pool.sources.map(row => row.source_id)).toContain("z");
      expect(pool.sources.map(row => row.source_id)).not.toContain("private");
      expect(meter.nativeWork).toBeGreaterThan(0);
      expect(meter.spentWork).toBeLessThanOrEqual(budget.work_units);
    } finally { navigation.mockRestore(); database.close(); closeCachedDatabase(filename); }

    const handler = createSourceSemanticInterpretationHandler({ now: () => CLOCK, sourceSemanticsPort: { execute } });
    const context = { workspaceId: WS, runId: "access-test", agentTarget: "codex" as const, sessionId: "access-test" };
    const { kind: _kind, ...fields } = request;
    const authorized_scopes = { mode: "named" as const, scopes: ["project"] };
    const plain = await handler(SoulInterpretationRequestSchema.parse({ operation: "prepare_query", ...fields, authorized_scopes }), context);
    const hinted = await handler(SoulInterpretationRequestSchema.parse({ operation: "prepare_query", ...fields,
      authorized_scopes, access_hint: "Harbor" }), context);
    if (plain.operation !== "prepare_query" || hinted.operation !== "prepare_query") throw new Error("preparation expected");
    expect(plain.candidates.map(row => row.source_id)).not.toContain("z");
    expect(hinted.candidates.map(row => row.source_id)).toContain("z");
    expect(hinted.candidates.map(row => row.source_id)).not.toContain("private");
    expect(hinted.query_semantics_id).toBe(plain.query_semantics_id);
    expect(hinted.query_semantics_status).toEqual(plain.query_semantics_status);
    expect(hinted.access?.input_id).not.toBe(plain.access?.input_id);
    expect(hinted.access?.unvisited_sources).toBe(true);
    const target = hinted.access!.source_candidates.find(row => row.source_id === "z")!;
    expect(target).toMatchObject({ complete: true, signal: { source_text_score: 0 } });
    const signal = hinted.access!.interpretation_candidates.find(row => row.record_id === target.record_id)?.signal;
    expect(signal).toMatchObject({ source_text_score: 0,
      reading: { query_alternative: 0, query_frame: "qStatement", source_frame: "fStatement" } });
    expect(signal!.interpretation_reading_score).toBeGreaterThan(0);
    expect(sourceSemanticExecutionPhases(hinted.execution).query_preparation.external_api_attempts).toBe(0);
    expect(hinted).not.toHaveProperty("provider_attempts");
    const recalled = await handler({ operation: "recall", accepts_unreviewed_conditional_results: true,
      query_handle: hinted.query_handle!, semantic_correspondences: [], budget, output_byte_limit: 1_000_000,
      authorized_scopes }, context);
    if (recalled.operation !== "recall" || recalled.discovery === undefined ||
        recalled.results === undefined || recalled.index === undefined) throw new Error("completed recall expected");
    expect(recalled.discovery.access?.pool_id).toBe(hinted.access?.pool_id);
    const delivered = recalled.results.find(row => row.target?.kind === "source_evidence" && row.target.root_id === target.record_id);
    expect(delivered?.content_preview).toContain("Harbor opening was put off.");
    expect(delivered?.source_channels).toEqual(["source_record"]);
    const targetSlot = recalled.index.entries.findIndex(row => row.target.kind === "source_evidence" && row.target.root_id === target.record_id);
    expect(targetSlot).toBeGreaterThanOrEqual(0);
    expect(recalled.slot_qualifiers).toContainEqual(expect.objectContaining({ index: targetSlot, evidence_kind: "source_evidence" }));
    expect(recalled.query_semantics_status).toEqual(hinted.query_semantics_status);
    expect(recalled.request_identity).toBe(sourceSemanticLibraryRequestIdentity({ workspace_id: WS, as_of: CLOCK,
      authorized_scopes: ["project"], original_query: original, query_semantics: query,
      query_semantics_status: hinted.query_semantics_status, access_hint: "Harbor", access_policy: "query-conditioned-v1",
      semantic_correspondences: [], budget, output_byte_limit: 1_000_000 }));
    expect(recalled.proofs ?? []).toHaveLength(0);
    expect(recalled.coverage.conditional_computation).toBe("unexercised");
  });
}, 60_000);

it("admits one current source tuple shared by canonical, native index and repeated interpretation discovery", async () => {
  await withAccessLibrary([{ id: "overlap", text: "Harbor opening was put off.", reading: "postpone", count: 2 }],
    async ({ execute, filename, ids }) => {
      const { database } = await createRecallRealStorage(() => undefined, filename);
      let target;
      try {
        const repository = new SqliteSourceIndexRepository(database, fieldContractSha256);
        const lifecycle = new SourceIndexLifecycle(repository, fieldContractSha256);
        const generation = lifecycle.begin(lifecycle.select(WS, SIMULATED_CONFIGURATION));
        expect(lifecycle.capture(WS, generation.generation_id, 16, INDEX_BUDGET).generation.enumeration_complete).toBe(true);
        [target] = repository.listTargets(WS, generation.generation_id, null, 16);
        if (target === undefined) throw new Error("native source index target expected");
        const prepared = lifecycle.prepare(WS, generation.generation_id, target.root_key, INDEX_BUDGET);
        if (prepared.status !== "ready") throw new Error("native source document expected");
        // Independently authored vector control: no inference, provider or retained archive is used.
        for (const window of prepared.document.windows) expect(lifecycle.acceptVector(WS, generation.generation_id, {
          window_id: window.window_id, input_digest: window.content_digest,
          embedding: new Float32Array([1, 0, 0]), token_count: 2, truncated: false
        }, INDEX_BUDGET).status).toBe("accepted");
        expect(lifecycle.publish(WS, generation.generation_id)).toEqual({ status: "accepted" });
      } finally { database.close(); closeCachedDatabase(filename); }
      const prepared = await accessCall(execute, { ...prepare, access_hint: "Harbor" });
      expect(prepared.access?.acquisition.result?.nominations).toContainEqual(expect.objectContaining({ source: target,
        lexical: [expect.objectContaining({ lane: "unicode61", rank: 1 })] }));
      expect(prepared.access?.observed_source_count).toBe(1);
      expect(prepared.access?.observed_interpretation_count).toBe(2);
      expect(prepared.access?.source_candidates.map(row => row.record_id)).toEqual([target!.target.root_id]);
      expect(new Set(prepared.candidates.map(row => row.interpretation_id))).toEqual(new Set(ids.get("overlap")));
      const recalled = await accessCall(execute, { kind: "recall", accepts_unreviewed_conditional_results: true,
        query_handle: prepared.query_handle!, semantic_correspondences: [], budget: ACCESS_BUDGET, output_byte_limit: 1_000_000 });
      expect(recalled.index.entries.filter(row => row.target.kind === "source_evidence"
        && row.target.root_id === target!.target.root_id)).toHaveLength(1);
      expect(sourceSemanticExecutionPhases(SourceSemanticExecutionSchema.parse(recalled.execution)).acquisition.status).toBe("not_run");
      expect(recalled.discovery.access?.acquisition).toEqual(prepared.access?.acquisition);
    });
}, 60_000);

it("inherits a frozen hint across source-only continuation and rejects changes, scope drift and a stale revision", async () => {
  await withAccessLibrary(Array.from({ length: 17 }, (_, index) => ({ id: `raw-${index}`, text: "Harbor notes." })),
  async ({ execute, filename }) => {
    const first = await accessCall(execute, { ...prepare, access_hint: "Harbor" });
    expect(first.continuation_handle).toBeDefined();
    const continued = { ...prepare, continuation_handle: first.continuation_handle! };
    const omitted = await accessCall(execute, continued);
    const repeated = await accessCall(execute, { ...continued, access_hint: "Harbor" });
    expect(omitted.access).toEqual(repeated.access);
    expect(omitted.access?.pool_id).toBe(first.access?.pool_id);
    expect(omitted.access?.trace).toMatchObject({ source_offset: 16 });
    expect(omitted.work.native_work).toBe(0);
    expect(omitted.work.native_bytes).toBe(0);
    expect(sourceSemanticExecutionPhases(SourceSemanticExecutionSchema.parse(omitted.execution)).query_preparation).toMatchObject({ status: "not_requested", method: "not_run", submitted_inputs: 0 });
    expect(sourceSemanticExecutionPhases(SourceSemanticExecutionSchema.parse(omitted.execution)).acquisition).toMatchObject({ status: "not_run", result: null });
    expect(omitted.access?.acquisition).toEqual(first.access?.acquisition);
    await expect(accessCall(execute, { ...continued, access_hint: "elsewhere" })).rejects.toThrow(/policy|budget|hint/u);
    await expect(accessCall(execute, { ...continued, access_policy: "canonical-v1" })).rejects.toThrow(/hint|policy/u);
    await expect(accessCall(execute, continued, ["global_core"])).rejects.toThrow(/scope/u);
    const unhinted = await accessCall(execute, prepare);
    await expect(accessCall(execute, { ...prepare, continuation_handle: unhinted.continuation_handle!, access_hint: "Harbor" }))
      .rejects.toThrow(/policy|budget|hint/u);
    const current = await createRecallRealStorage(() => undefined, filename);
    current.database.connection.prepare("UPDATE source_records SET scope_class='global_core' WHERE source_id='raw-0'").run();
    current.database.close(); closeCachedDatabase(filename);
    await expect(accessCall(execute, continued)).rejects.toThrow(/snapshot/u);
  });
});
