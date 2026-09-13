import { describe, expect, it } from "vitest";
import { RecallTokenEconomySampleSchema } from
  "../../../../../../packages/eval/src/contracts/kpi-auxiliary-schema.js";
import { RecallTokenEconomySchema } from
  "../../../harness/recall/recall-diagnostics-schema.js";

const SAMPLE = {
  delivered_context_tokens_estimate: 12,
  coarse_pool_size: 8,
  fine_evaluated: 8,
  fine_pruned_count: 1,
  fine_priority_overflow_count: 0,
  fusion_families_with_hits: 3,
  embedding_inference_calls: 1
};

describe("bench recall token economy sample", () => {
  it("parses a shared sample payload equally on eval and bench", () => {
    expect(RecallTokenEconomySampleSchema.parse(SAMPLE)).toEqual(
      RecallTokenEconomySchema.parse(SAMPLE)
    );
  });
});
