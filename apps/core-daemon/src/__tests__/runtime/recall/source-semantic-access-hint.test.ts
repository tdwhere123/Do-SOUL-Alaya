import { expect, it, vi } from "vitest";
import { SoulInterpretationRequestSchema } from "@do-soul/alaya-protocol";
import { closeCachedDatabase, SqliteSourceHintReader } from "@do-soul/alaya-storage";
import { sourceSemanticLibraryRequestIdentity } from "@do-soul/alaya-core";
import { createSourceSemanticInterpretationHandler } from "../../../mcp-memory/tool/interpretation-handler.js";
import { createRecallRealStorage } from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { ACCESS_BUDGET, CLOCK, WS, accessCall, accessQuery, withAccessLibrary } from "./source-semantic-access.test-support.js";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { observeSourceSemanticAccess } from "../../../runtime/recall-read-worker/source-semantic-candidate-access.js";
import type { RecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";

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
    expect(hinted.provider_attempts).toBe(0);
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
