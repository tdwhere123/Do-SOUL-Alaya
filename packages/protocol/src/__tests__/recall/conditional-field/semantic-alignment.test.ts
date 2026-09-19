import { expect, it } from "vitest";
import { SourceSemanticAlignmentSchema } from "../../../recall/conditional-field/semantic-alignment.js";
import { SourceSemanticEvaluationContextSchema } from "../../../recall/conditional-field/interpretation-context.js";

const digest = `sha256:${"a".repeat(64)}`;
const alignment = {
  contract: "source-semantic-alignment-v2" as const,
  h_id: digest, q_id: digest, producer_id: "ap", producer_version: "1",
  contract_version: "source-semantic-alignment-v2",
  correspondences: [{
    relation: "contextual_equivalence" as const,
    query_endpoint: { kind: "predicate" as const, alternative: 0, frame: "qSend" },
    source_endpoint: { kind: "frame" as const, frame: "fSend" },
    query_support: { kind: "query_text" as const, excerpt: "sent" },
    source_semantic_support: [{ kind: "lexical" as const, mentions: ["mSent"] }]
  }]
};

it("admits contextual equivalence only and rejects answer ids, programs, and seeds", () => {
  expect(SourceSemanticAlignmentSchema.parse(alignment).correspondences[0]?.relation)
    .toBe("contextual_equivalence");
  expect(SourceSemanticAlignmentSchema.safeParse({
    ...alignment, correspondences: [{ ...alignment.correspondences[0], relation: "entailment" }]
  }).success).toBe(false);
  expect(SourceSemanticAlignmentSchema.safeParse({ ...alignment, answer_id: "ans" }).success).toBe(false);
  expect(SourceSemanticAlignmentSchema.safeParse({ ...alignment, answer_ids: ["ans"] }).success).toBe(false);
  expect(SourceSemanticAlignmentSchema.safeParse({ ...alignment, program: { kind: "epsilon" } }).success).toBe(false);
  expect(SourceSemanticAlignmentSchema.safeParse({ ...alignment, seed_nodes: ["fSend"] }).success).toBe(false);
  expect(SourceSemanticAlignmentSchema.safeParse({ ...alignment, seed: "fSend" }).success).toBe(false);
});

it("requires C to bind A_id rather than a free branch digest", () => {
  expect(SourceSemanticEvaluationContextSchema.parse({
    contract: "source-semantic-context-v2", h_id: digest, q_id: digest, a_id: digest,
    k_version: "k1", lowering_version: "l1"
  }).a_id).toBe(digest);
  expect(SourceSemanticEvaluationContextSchema.safeParse({
    contract: "source-semantic-context-v2", h_id: digest, q_id: digest, branch_id: digest,
    k_version: "k1", lowering_version: "l1"
  }).success).toBe(false);
});
