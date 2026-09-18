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
  discovery: "complete" as const, h: "unexercised" as const, q: "unexercised" as const,
  a: "unexercised" as const, computation: "unexercised" as const, payload: "complete" as const
};
const work = { native_work: 1, native_bytes: 2, logical_memory_bytes: 3, rss_bytes: 4 };

it("admits prepare and one-shot reason without a continuation token", () => {
  expect(SourceSemanticWorkerRequestSchema.parse({
    kind: "prepare_source", source_id: "artifact-1", budget
  }).kind).toBe("prepare_source");
  expect(SourceSemanticWorkerRequestSchema.safeParse({
    kind: "reason", accepts_unreviewed_conditional_results: true, budget, output_byte_limit: 1024
  }).success).toBe(false);
  const result = SourceSemanticWorkerResultSchema.parse({
    kind: "reason",
    result: {
      contract: "source-interpretation-reasoning-v2",
      outcome: { status: "truncated" }, consumed_leaves: [],
      semantic_status: "unreviewed", conclusion_scope: "conditional_on_interpretation",
      world_claim: "unknown"
    },
    coverage: { ...coverage, payload: "truncated", computation: "open" }, work
  });
  expect("continuation" in result).toBe(false);
  expect(result.result.semantic_status).toBe("unreviewed");
  expect(result.result.world_claim).toBe("unknown");
  expect(MemorySearchResultSchema.safeParse(result).success).toBe(false);
  expect(SourceInterpretationReasoningResultSchema.safeParse(result).success).toBe(false);
  expect(digest.startsWith("sha256:")).toBe(true);
});
