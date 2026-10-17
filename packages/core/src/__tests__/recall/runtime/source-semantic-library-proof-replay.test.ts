import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../apps/bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { vi.restoreAllMocks(); expect(isolation.violations).toEqual([]); });
afterAll(() => { isolation.restore(); });
import * as reasoning from "../../../recall/runtime/source-semantic-reasoning.js";
import { deliveredSourceSemanticLibraryProof } from "../../../recall/runtime/source-semantic-library-proof.js";
import { deliveredProofFixture } from "./source-semantic-proof-fixture.js";

// This small actual witness isolates replay admission; over-megabyte public proof delivery is not exercised here.
it("replays a small honestly derived delivered library witness with computation rather than any artificial delivery cap", () => {
  const { record, proof, index, entry, qualifier } = deliveredProofFixture({ library: true });
  const execute = vi.spyOn(reasoning, "executeSourceSemanticInterpretation");
  const verified = deliveredSourceSemanticLibraryProof(index, entry, qualifier, [proof], record);
  expect(verified.proof).toBe(proof);
  expect(verified.verified_proofs).toEqual([proof]);
  expect(verified.resource_usage.work_units).toBeGreaterThan(0);
  expect(verified.resource_usage.memory_bytes).toBeGreaterThan(0);
  expect(execute).toHaveBeenCalledOnce();
  const argument = execute.mock.calls[0]![0];
  expect(argument).not.toHaveProperty("request");
  expect(argument.computation).toEqual({
    contract: "source-interpretation-reasoning-v5", accepts_unreviewed_conditional_results: true,
    source_interpretation_id: proof.source_interpretation_id, query_semantics_id: proof.query_semantics_id,
    semantic_correspondence_id: proof.semantic_correspondence_id, original_query: proof.original_query,
    budget: { ...reasoning.SOURCE_SEMANTIC_REASONING_BUDGET,
      work_units: expect.any(Number), memory_bytes: expect.any(Number) }
  });
  expect(argument.computation).not.toHaveProperty("output_byte_limit");
  expect(argument).toMatchObject({ source_interpretation: proof.interpretation, query_semantics: proof.query,
    semantic_correspondence: proof.semantic_correspondence, workspaceId: record.workspace_id,
    scope: record.scope_class, asOf: index.as_of, sourceValidity: record, source_target: proof.source_target });
  const replayed = execute.mock.results[0]!;
  if (replayed.type !== "return") throw new Error("actual replay must finish");
  expect(replayed.value.index).not.toBeNull();
  expect(replayed.value.result.outcome.status).toBe("interpreted");
  expect(replayed.value.result.conditional_computation_id).toBe(proof.conditional_computation_id);
  expect(deliveredSourceSemanticLibraryProof(index, entry, qualifier, [proof]).proof).toBeUndefined();
  const forged = { ...proof, binding_results: proof.binding_results!.map(binding => ({ ...binding, alternative: 999 })) };
  expect(deliveredSourceSemanticLibraryProof(index, entry, qualifier, [forged], record).proof).toBeUndefined();
});
