import { expect, it } from "vitest";
import { MemorySearchResultSchema } from "../../surfaces/mcp-memory-search-types.js";
import { SourceInterpretationReasoningResultSchema } from "../../garden/source-interpretation-packet.js";
import { InformationIndexSchema } from "../../recall/conditional-field/index-view.js";
import { SoulInterpretationResponseSchema } from "../../surfaces/mcp-interpretation-types.js";
import {
  SourceSemanticWorkerRequestSchema, SourceSemanticWorkerResultSchema
} from "../../garden/source-semantic-worker.js";

const digest = `sha256:${"a".repeat(64)}`;
const budget = {
  schema_version: 1 as const, work_units: 10, memory_bytes: 1000,
  page_budget: 1, finalization_reserve: 0, min_envelope: 0
};
const coverage = {
  discovery: "complete" as const, source_interpretation: "unexercised" as const,
  query_semantics: "unexercised" as const, semantic_correspondence: "unexercised" as const,
  conditional_computation: "unexercised" as const, payload: "complete" as const
};
const work = { native_work: 1, native_bytes: 2, logical_memory_bytes: 3, rss_bytes: 4 };

it("admits prepare and one-shot reason without a continuation token", () => {
  expect(SourceSemanticWorkerRequestSchema.parse({
    kind: "prepare_source", source_id: "artifact-1", budget
  }).kind).toBe("prepare_source");
  expect(SourceSemanticWorkerRequestSchema.safeParse({
    kind: "reason", accepts_unreviewed_conditional_results: true, budget, output_byte_limit: 1024
  }).success).toBe(false);
  expect(SourceSemanticWorkerRequestSchema.safeParse({
    kind: "recall", accepts_unreviewed_conditional_results: true, budget, output_byte_limit: 1024
  }).success).toBe(false);
  expect(SourceSemanticWorkerRequestSchema.parse({
    kind: "recall", accepts_unreviewed_conditional_results: true, query_handle: "query-handle",
    budget, output_byte_limit: 1024
  }).kind).toBe("recall");
  expect(SourceSemanticWorkerRequestSchema.parse({
    kind: "recall", accepts_unreviewed_conditional_results: true, query_handle: "query-handle",
    budget, output_byte_limit: 1024,
    continuation: {
      schema_version: 1, continuation_id: "page-10", query_id: "q1", snapshot_id: digest,
      result_version: "source-semantic-library-v3", expires_at: "2099-01-01T00:00:00.000Z",
      cursor: "offset-10"
    }
  }).kind).toBe("recall");
  const result = SourceSemanticWorkerResultSchema.parse({
    kind: "reason",
    result: {
      contract: "source-interpretation-reasoning-v5",
      outcome: { status: "truncated" }, consumed_leaves: [],
      semantic_status: "unreviewed", conclusion_scope: "conditional_on_interpretation",
      world_claim: "unknown"
    },
    coverage: { ...coverage, payload: "truncated", conditional_computation: "open" }, work
  });
  expect("continuation" in result).toBe(false);
  if (result.kind !== "reason") throw new Error("expected a reasoning result");
  expect(result.result.semantic_status).toBe("unreviewed");
  expect(result.result.world_claim).toBe("unknown");
  expect(MemorySearchResultSchema.safeParse(result).success).toBe(false);
  expect(SourceInterpretationReasoningResultSchema.safeParse(result).success).toBe(false);
  expect(digest.startsWith("sha256:")).toBe(true);
});

function libraryDelivery() {
  return { delivery_id: "delivery", protocol_version: 3, total_count: 0,
    index: { schema_version: 1, query_id: "library-query", snapshot_id: digest, result_version: "source-semantic-library-v3",
      entries: [], completeness: { schema_version: 1, logical_index: "complete", observed_coverage: "complete",
        transport: "complete", payload: "complete", representation: "complete" }, continuation: null,
      representation: { schema_version: 1, policy: "construct_index_then_page_then_payload", page_budget: 10, identity_tie_break: "serialization" },
      page_purpose: "membership" },
    page_purpose: "membership", discovery: { eligible_source_count: 0, visited_source_pages: 1, visited_source_interpretation_pages: 1,
      visited_source_interpretation_descriptors: 0, candidate_prefix: [], examined_source_interpretation_ids: [],
      unexamined_source_interpretation_count: 0, omitted_duplicate_bindings: 0, examination_cap: 32, open_residuals: false, truncated: false },
    order: { enumeration_policy: "canonical", tie_policy: "canonical_identity", occupancy: "source_gold_root_identity", occupancy_prefix: 5, page_budget: 10 },
    slot_qualifiers: [], coverage, work };
}

it("shares current delivery version, membership and page budget admission between worker and public surfaces", () => {
  const delivery = libraryDelivery();
  const accepts = (value: ReturnType<typeof libraryDelivery>) => [
    SourceSemanticWorkerResultSchema.safeParse({ kind: "recall", ...value }).success,
    SoulInterpretationResponseSchema.safeParse({ operation: "recall", results: [], provider_attempts: 0, ...value }).success
  ];
  expect(accepts(delivery)).toEqual([true, true]);
  for (const version of ["source-semantic-library-v1", "not-a-native-library-result"]) {
    const index = { ...delivery.index, result_version: version };
    expect(InformationIndexSchema.safeParse(index).success).toBe(true);
    expect(accepts({ ...delivery, index })).toEqual([false, false]);
  }
  for (const changed of [ { ...delivery, protocol_version: 1 }, { ...delivery, page_purpose: "update" },
    { ...delivery, order: { ...delivery.order, page_budget: 9 } },
    { ...delivery, index: { ...delivery.index, representation: { ...delivery.index.representation, page_budget: 9 } } },
    { ...delivery, index: { ...delivery.index, page_purpose: "update" } } ]) expect(accepts(changed)).toEqual([false, false]);
});

it("rejects every missing mandatory delivery field and partial deliveries disguised as outcomes", () => {
  const delivery = libraryDelivery();
  for (const key of ["delivery_id", "protocol_version", "total_count", "index", "page_purpose", "discovery", "order", "slot_qualifiers"]) {
    const partial = { ...delivery };
    Reflect.deleteProperty(partial, key);
    expect(SourceSemanticWorkerResultSchema.safeParse({ kind: "recall", ...partial }).success, key).toBe(false);
    expect(SoulInterpretationResponseSchema.safeParse({ operation: "recall", results: [], provider_attempts: 0,
      outcome: { status: "preparation_required", missing: "query_semantics" }, ...partial }).success, key).toBe(false);
  }
  expect(SoulInterpretationResponseSchema.safeParse({ operation: "recall", ...delivery, provider_attempts: 0 }).success).toBe(false);
  const outcome = { operation: "recall", outcome: { status: "preparation_required", missing: "query_semantics" }, coverage, work, provider_attempts: 0 };
  expect(SoulInterpretationResponseSchema.safeParse(outcome).success).toBe(true);
  for (const partial of [{ protocol_version: 3 }, { results: [] }, { request_budget: budget }, { proofs: [] }]) {
    expect(SoulInterpretationResponseSchema.safeParse({ ...outcome, ...partial }).success).toBe(false);
  }
});
