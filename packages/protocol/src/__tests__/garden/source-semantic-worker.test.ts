import { expect, it } from "vitest";
import { MemorySearchResultSchema } from "../../surfaces/mcp-memory-search-types.js";
import { SourceInterpretationReasoningResultSchema } from "../../garden/source-interpretation-packet.js";
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
      result_version: "source-semantic-library-v2", expires_at: "2099-01-01T00:00:00.000Z",
      cursor: "offset-10"
    }
  }).kind).toBe("recall");
  const result = SourceSemanticWorkerResultSchema.parse({
    kind: "reason",
    result: {
      contract: "source-interpretation-reasoning-v4",
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
