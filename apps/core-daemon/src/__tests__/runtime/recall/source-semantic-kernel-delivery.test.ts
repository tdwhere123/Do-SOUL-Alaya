import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { vi.restoreAllMocks(); expect(isolation.violations).toEqual([]); });
afterAll(() => { isolation.restore(); });
import * as core from "@do-soul/alaya-core";
import { closeCachedDatabase } from "@do-soul/alaya-storage";
import { SourceSemanticReasoningResultSchema, SourceSemanticWorkerRequestSchema, SourceSemanticWorkerResultSchema,
  sourceSemanticReasonControl } from "@do-soul/alaya-protocol";
import { createRecallRealStorage } from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { runSourceSemanticWorker } from "../../../runtime/recall-read-worker/source-semantic-reasoning.js";
import { createRecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { parseWorkerOperationPayload } from "../../../runtime/recall-read-worker/operation-schemas.js";
import * as finalization from "../../../runtime/recall-read-worker/source-semantic-reason-finalization.js";
import { createSourceSemanticInterpretationHandler } from "../../../mcp-memory/tool/interpretation-handler.js";
import { CLOCK, WS, accessCall } from "./source-semantic-access.test-support.js";
import { gaps, reasonRequest, sourceId, withPublished } from "./source-semantic-authored-computation.test-support.js";

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

it("passes genuine over-megabyte computed evidence to native finalization and preserves its intact outcome through built worker and public delivery", async () => {
  await withPublished(async ({ filename, ids, execute }) => {
    const id = ids.get(sourceId)?.[0];
    if (id === undefined) throw new Error("authored interpretation publication required");
    const request = reasonRequest(id, 28);
    // Observe real production calls: neither the kernel output nor the finalizer is replaced.
    const kernel = vi.spyOn(core, "executeSourceSemanticInterpretation");
    const finalize = vi.spyOn(finalization, "finalizeSourceSemanticReason");
    const { database } = await createRecallRealStorage(() => undefined, filename);
    let local;
    try {
      local = runSourceSemanticWorker(createRecallReadWorkerRuntime(database), parseWorkerOperationPayload("conditionalField.sourceSemantics", {
        workspace_id: WS, as_of: CLOCK, authorized_scopes: { mode: "named", scopes: ["project"] }, request
      }));
    } finally { database.close(); closeCachedDatabase(filename); }
    expect(kernel).toHaveBeenCalledTimes(1);
    expect(kernel.mock.calls[0]![0]).not.toHaveProperty("request");
    expect(kernel.mock.calls[0]![0]).toHaveProperty("computation");
    expect(kernel.mock.calls[0]![0].computation).not.toHaveProperty("output_byte_limit");
    expect(finalize).toHaveBeenCalledTimes(1);
    const full = finalize.mock.calls[0]![0];
    expect(finalize.mock.calls[0]![1]).toBe(1_000_000);
    if (full.result === undefined) throw new Error("actual completed kernel result required");
    expect(bytes(full.result)).toBeGreaterThan(1_000_000);
    expect(SourceSemanticReasoningResultSchema.safeParse(full.result).success).toBe(true);
    expect(full.result.outcome).toEqual({ status: "interpreted", gaps });
    expect(full.result).toMatchObject({ semantic_status: "unreviewed",
      conclusion_scope: "conditional_on_interpretation", world_claim: "unknown" });
    expect(full.result.binding_results).toHaveLength(28);
    expect(full.result.derivations).toHaveLength(980);
    for (const binding of full.result.binding_results ?? []) {
      expect(binding.bindings.tools).toMatchObject({ packet_id: id, node_id: "rTools" });
      expect(binding.bindings.actor).toMatchObject({ packet_id: id, node_id: "rAlice" });
    }
    expect(full.result.consumed_leaves).toEqual(expect.arrayContaining([
      { leaf_kind: "source_interpretation_binding", occurrence: "fUse", slot_id: "theme", target: "rTools" }
    ]));
    expect(full.result.evidence_leaves!.length).toBeGreaterThan(0);
    expect(full.interpretation?.source.source_id).toBe(sourceId);
    expect(full.interpretation?.mentions.some(row => row.text === "Pixel")).toBe(true);
    const native = await accessCall(execute, request);
    const handler = createSourceSemanticInterpretationHandler({ now: () => CLOCK, sourceSemanticsPort: { execute } });
    const { kind: _kind, ...publicRequest } = request;
    const publicResult = await handler({ operation: "reason", ...publicRequest }, {
      workspaceId: WS, runId: "kernel-delivery", agentTarget: "test", sessionId: "kernel-delivery"
    });
    for (const value of [local, native, publicResult]) {
      expect(bytes(value)).toBeLessThanOrEqual(1_000_000);
      expect(value).not.toHaveProperty("result");
      expect(value).not.toHaveProperty("interpretation");
      expect(value).not.toHaveProperty("semantic_correspondence");
      expect(value).toHaveProperty("no_conclusion", [full.result.outcome,
        [full.result.source_interpretation_id, full.result.query_semantics_id,
          full.result.semantic_correspondence_id, full.result.conditional_computation_id], full.result.query_gaps]);
      expect(sourceSemanticReasonControl(value)).toMatchObject({ outcome: full.result.outcome,
        query_gaps: full.result.query_gaps });
      expect(sourceSemanticReasonControl(value)).not.toHaveProperty("binding_results");
      expect(sourceSemanticReasonControl(value)).not.toHaveProperty("attention");
      expect(value).toMatchObject({ coverage: { conditional_computation: "complete", payload: "truncated" },
        source_disclosure: { proof_use: { kind: "conditional_support", qualification: "not_world_claim" } },
        execution: "native_reasoning_only" });
      expect(value.work.native_work).toBeGreaterThan(0);
      expect(value.work.native_bytes).toBeGreaterThan(0);
      expect(value.work.logical_memory_bytes).toBeGreaterThan(0);
    }
    expect(SourceSemanticWorkerResultSchema.safeParse(native).success).toBe(true);
    expect(SourceSemanticWorkerRequestSchema.safeParse({ ...request, output_byte_limit: 1_000_001 }).success).toBe(false);
    await expect(handler({ operation: "reason", ...publicRequest, output_byte_limit: 1_000_001 }, {
      workspaceId: WS, runId: "kernel-delivery", agentTarget: "test", sessionId: "kernel-delivery"
    })).rejects.toThrow();
    console.info("authored computation delivery bytes", { kernel: bytes(full.result),
      native: bytes(native), public: bytes(publicResult), bindings: full.result.binding_results?.length,
      derivations: full.result.derivations?.length });
  });
}, 60_000);

it("rejects actual merged proof schema overflow across SQLite and built worker instead of returning fake exhaustion", async () => {
  await withPublished(async ({ filename, ids, execute }) => {
    const id = ids.get(sourceId)?.[0];
    if (id === undefined) throw new Error("authored interpretation publication required");
    const request = reasonRequest(id, 29);
    const finalize = vi.spyOn(finalization, "finalizeSourceSemanticReason");
    const { database } = await createRecallRealStorage(() => undefined, filename);
    try {
      let failure: unknown;
      try {
        runSourceSemanticWorker(createRecallReadWorkerRuntime(database), parseWorkerOperationPayload("conditionalField.sourceSemantics", {
          workspace_id: WS, as_of: CLOCK, authorized_scopes: { mode: "named", scopes: ["project"] }, request
        }));
      } catch (error) { failure = error; }
      expect(failure).toMatchObject({ name: "ZodError", issues: expect.arrayContaining([
        expect.objectContaining({ code: "too_big", path: ["derivations"], maximum: 1000 })
      ]) });
      expect(finalize).not.toHaveBeenCalled();
    } finally { database.close(); closeCachedDatabase(filename); }
    await expect(accessCall(execute, request)).rejects.toThrow("derivations");
    const recovered = await accessCall(execute, reasonRequest(id, 28));
    expect(sourceSemanticReasonControl(recovered).outcome.status).toBe("interpreted");
    expect(recovered.result).toBeUndefined();
    expect(recovered.no_conclusion).toBeDefined();
  });
}, 60_000);
