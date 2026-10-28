import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => isolation.restore());
import { hashContentDigest, hashSourceRecordId, SourceSemanticCorrespondenceSchema,
  sourceSemanticExecutionPhases, sourceSemanticQueryIdentity, verifySourceSemanticLibraryDelivery, type SourceRepresentation }
  from "@do-soul/alaya-protocol";
import { fieldContractSha256, SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID } from "@do-soul/alaya-core";
import { ACCESS_BUDGET, accessCall, accessQuery, prepareAccessNativeIndex, withAccessLibrary, WS } from "./source-semantic-access.test-support.js";

const ORIGINAL = "Was the parcel delivered?";
const ORIGIN = { id: "parcel-origin", text: "Parcel delivery was requested.",
  source_representation: { kind: "retained_excerpt" as const } };
const originIdentity = hashSourceRecordId({ source_id: ORIGIN.id, source_version: "1",
  content_digest: hashContentDigest(`User: ${ORIGIN.text}`, fieldContractSha256),
  source_representation: ORIGIN.source_representation }, fieldContractSha256);

it.each<{ label: string; representation?: SourceRepresentation }>([
  { label: "historical unknown" },
  { label: "retained excerpt", representation: { kind: "retained_excerpt" } },
  { label: "canonical projection", representation: { kind: "canonical_projection", source_record_ids: [originIdentity] } }
])("delivers zero-binding control for a $label source after SQLite close and worker reopen", async ({ representation }) => {
  const source = { id: "parcel-request", text: ORIGIN.text, reading: "requested",
    ...(representation === undefined ? {} : { source_representation: representation }) };
  await withAccessLibrary([ORIGIN, source], async ({ execute, ids }) => {
    const query = accessQuery(ORIGINAL, "delivered"), interpretationId = ids.get(source.id)![0]!;
    const correspondence = SourceSemanticCorrespondenceSchema.parse({
      contract: "source-semantic-correspondence-v3", contract_version: "source-semantic-correspondence-v3",
      producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1",
      source_interpretation_id: interpretationId, query_semantics_id: sourceSemanticQueryIdentity(query, fieldContractSha256),
      correspondences: []
    });
    const delivered = await accessCall(execute, { kind: "recall", original_query: ORIGINAL,
      accepts_unreviewed_conditional_results: true, query_semantics: query,
      semantic_correspondences: [correspondence], budget: ACCESS_BUDGET, output_byte_limit: 1_000_000 });
    expect(delivered.unproved_computations).toHaveLength(1);
    const control = delivered.unproved_computations![0]!;
    expect(control).toMatchObject({ kind: "complete_zero_binding", world_claim: "unknown",
      conclusion_scope: "conditional_on_interpretation", source_interpretation_id: interpretationId,
      completeness: { logical_index: "complete", observed_coverage: "exhausted_empty", interpretation_coverage: "open" } });
    expect(control.source_record).toEqual({ workspace_id: WS, source_id: source.id, source_version: "1",
      identity: hashSourceRecordId({ source_id: source.id, source_version: "1",
        content_digest: hashContentDigest(`User: ${source.text}`, fieldContractSha256),
        ...(representation === undefined ? {} : { source_representation: representation }) }, fieldContractSha256),
      content_digest: hashContentDigest(`User: ${source.text}`, fieldContractSha256),
      ...(representation === undefined ? {} : { source_representation: representation }) });
    expect(delivered.order.enumeration_policy).toBe("native_query");
    expect(delivered.index.result_version).toBe("ordinary-native-field.v7");
    const target = delivered.index.entries.find(entry => entry.target.kind === "source_evidence" && entry.target.root_id === control.source_record.identity)?.target;
    expect(target).toMatchObject({ kind: "source_evidence", root_kind: "source_record", workspace_id: WS,
      root_id: control.source_record.identity, source_version: "1", content_digest: control.source_record.content_digest, evidence_object_id: null });
    expect(delivered.discovery.examined_source_interpretation_ids).toEqual([interpretationId]);
    expect(delivered.coverage.conditional_computation).toBe("complete");
    expect(verifySourceSemanticLibraryDelivery(delivered, fieldContractSha256)).toBe(delivered);
    expect(delivered.proofs ?? []).toEqual([]);
    expect(delivered.slot_qualifiers.some(slot => slot.evidence_kind === "semantic_proof")).toBe(false);
  }, { prepareDatabase: prepareAccessNativeIndex });
}, 30_000);

it("keeps an unbound native index unknown rather than certifying an empty source population", async () => {
  await withAccessLibrary([ORIGIN], async ({ execute }) => {
    const delivered = await accessCall(execute, { kind: "recall", original_query: ORIGINAL,
      accepts_unreviewed_conditional_results: true, query_semantics: accessQuery(ORIGINAL),
      semantic_correspondences: [], budget: ACCESS_BUDGET, output_byte_limit: 1_000_000 });
    expect(delivered.index.entries).toEqual([]);
    expect(delivered.discovery).toMatchObject({ open_residuals: true, truncated: true });
    expect(delivered.coverage).toMatchObject({ discovery: "truncated", conditional_computation: "unexercised" });
    expect(delivered.unproved_computations).toBeUndefined();
    expect(delivered.proofs ?? []).toEqual([]);
    const execution = sourceSemanticExecutionPhases(delivered.execution!);
    expect(execution.acquisition.result).toMatchObject({ completion: "partial", nominations: [],
      lexical: { completion: "complete", index_coverage: "partial" },
      vector: { completion: "unavailable", state: null, reason: "embedding_preparation_unwired" } });
    expect(execution.query_preparation.external_api_attempts).toBe(0);
    expect(delivered.work.native_work).toBeGreaterThan(0);
    expect(delivered.work.logical_work).toBeGreaterThan(0);
    expect(delivered.work.logical_work).toBeLessThanOrEqual(ACCESS_BUDGET.work_units);
    expect(delivered.work.logical_memory_bytes).toBeLessThanOrEqual(ACCESS_BUDGET.memory_bytes);
  });
}, 30_000);
