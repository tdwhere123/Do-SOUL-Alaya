import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { vi.restoreAllMocks(); expect(isolation.violations).toEqual([]); });
afterAll(() => { isolation.restore(); });
import * as core from "@do-soul/alaya-core";
import { closeCachedDatabase } from "@do-soul/alaya-storage";
import { SourceSemanticReasoningResultSchema, SourceSemanticWorkerResultSchema,
  verifySourceSemanticLibraryDelivery, type SourceSemanticWorkerRequest } from "@do-soul/alaya-protocol";
import { createRecallRealStorage } from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { runSourceSemanticWorker } from "../../../runtime/recall-read-worker/source-semantic-reasoning.js";
import { createRecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { parseWorkerOperationPayload } from "../../../runtime/recall-read-worker/operation-schemas.js";
import * as packages from "../../../runtime/recall-read-worker/source-semantic-library-packages.js";
import { createSourceSemanticInterpretationHandler } from "../../../mcp-memory/tool/interpretation-handler.js";
import { CLOCK, WS, accessCall } from "./source-semantic-access.test-support.js";
import { gaps, reasonRequest, sourceId, withPublished } from "./source-semantic-authored-computation.test-support.js";

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

it("keeps an authored SQLite branch beyond the unchanged caller cap available to library packages while public raw fallback stays honest", async () => {
  await withPublished(async ({ filename, ids, execute }) => {
    const id = ids.get(sourceId)?.[0];
    if (id === undefined) throw new Error("authored interpretation publication required");
    const reason = reasonRequest(id, 28);
    const request: Extract<SourceSemanticWorkerRequest, { kind: "recall" }> = {
      kind: "recall", accepts_unreviewed_conditional_results: true,
      original_query: reason.original_query, query_semantics: reason.query_semantics,
      semantic_correspondences: [reason.semantic_correspondence!],
      budget: reason.budget, output_byte_limit: reason.output_byte_limit
    };
    // Observe actual calls and returns only; no fabricated computation or selection output.
    const kernel = vi.spyOn(core, "executeSourceSemanticInterpretation");
    const prepare = vi.spyOn(packages, "prepareLibraryPackages");
    const select = vi.spyOn(core, "selectSourceSemanticLibraryPage");
    const { database } = await createRecallRealStorage(() => undefined, filename);
    let local;
    try {
      local = runSourceSemanticWorker(createRecallReadWorkerRuntime(database), parseWorkerOperationPayload("conditionalField.sourceSemantics", {
        workspace_id: WS, as_of: CLOCK, authorized_scopes: { mode: "named", scopes: ["project"] }, request
      }));
    } finally { database.close(); closeCachedDatabase(filename); }
    expect(kernel).toHaveBeenCalledOnce();
    expect(kernel.mock.calls[0]![0]).not.toHaveProperty("request");
    expect(kernel.mock.calls[0]![0].computation).not.toHaveProperty("output_byte_limit");
    const computed = kernel.mock.results[0]!;
    if (computed.type !== "return") throw new Error("real completed branch required");
    const full = computed.value;
    expect(bytes(full.result)).toBeGreaterThan(request.output_byte_limit);
    expect(SourceSemanticReasoningResultSchema.safeParse(full.result).success).toBe(true);
    expect(full.result.outcome).toEqual({ status: "interpreted", gaps });
    expect(full.result.completeness?.logical_index).toBe("complete");
    expect(full.result.binding_results).toHaveLength(28);
    expect(full.index?.entries).toHaveLength(28);
    expect(prepare).toHaveBeenCalledOnce();
    const supports = prepare.mock.calls[0]![5];
    expect(supports).toHaveLength(1);
    expect(supports[0]!.proof).toMatchObject({ source_interpretation_id: id,
      outcome: full.result.outcome, query_gaps: reason.query_semantics!.gaps, semantic_status: "unreviewed",
      conclusion_scope: "conditional_on_interpretation", world_claim: "unknown" });
    expect(supports[0]!.group.entries).toHaveLength(28);
    expect(supports[0]!.dependencies.length).toBeGreaterThan(0);
    expect(select).toHaveBeenCalled();
    const proofCandidate = select.mock.calls[0]![0].candidates.find(row => row.proofs.length > 0
      && row.proofs[0]!.source_interpretation_id === id);
    expect(proofCandidate).toBeDefined();
    expect(bytes(proofCandidate!.proofs)).toBeGreaterThan(request.output_byte_limit);

    const native = await accessCall(execute, request);
    const handler = createSourceSemanticInterpretationHandler({ now: () => CLOCK, sourceSemanticsPort: { execute } });
    const { kind: _kind, ...publicRequest } = request;
    const publicResult = await handler({ operation: "recall", ...publicRequest }, {
      workspaceId: WS, runId: "library-computation", agentTarget: "test", sessionId: "library-computation"
    });
    for (const value of [local, native, publicResult]) {
      expect(bytes(value)).toBeLessThanOrEqual(request.output_byte_limit);
      expect(value).toHaveProperty("coverage.conditional_computation", "complete");
      expect(value).toHaveProperty("discovery.examined_source_interpretation_ids", [id]);
      expect(value).toHaveProperty("discovery.open_residuals", false);
      expect(value).toHaveProperty("index.entries", expect.arrayContaining([
        expect.objectContaining({ claim: "unknown", target: expect.objectContaining({ kind: "source_evidence" }) })
      ]));
      // The indivisible proof itself cannot fit: raw access must not become a semantic answer.
      expect(value).not.toHaveProperty("proofs");
      expect(value).toHaveProperty("slot_qualifiers", [expect.objectContaining({ evidence_kind: "source_evidence",
        payload_support: "envelope_budget" })]);
    }
    expect(SourceSemanticWorkerResultSchema.safeParse(native).success).toBe(true);
    expect(() => verifySourceSemanticLibraryDelivery(native, core.fieldContractSha256)).not.toThrow();
    expect(publicResult).toHaveProperty("results", [expect.objectContaining({
      content_preview: "Alice uses Pixel.", source_disclosure: expect.objectContaining({
        proof_use: expect.objectContaining({ kind: "source_only" }) })
    })]);
    console.info("authored library computation bytes", { computed: bytes(full.result), cap: request.output_byte_limit,
      local: bytes(local), native: bytes(native), public: bytes(publicResult) });
  });
}, 60_000);
