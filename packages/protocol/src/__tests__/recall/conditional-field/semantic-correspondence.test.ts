import { expect, it } from "vitest";
import {
  SourceSemanticCorrespondenceSchema
} from "../../../recall/conditional-field/semantic-correspondence.js";
import { SourceSemanticEvaluationContextSchema } from "../../../recall/conditional-field/interpretation-context.js";

const digest = `sha256:${"a".repeat(64)}`;
const semantic_correspondence = {
  contract: "source-semantic-correspondence-v3" as const,
  source_interpretation_id: digest, query_semantics_id: digest, producer_id: "ap", producer_version: "1",
  contract_version: "source-semantic-correspondence-v3",
  correspondences: [{
    relation: "contextual_equivalence" as const,
    query_endpoint: { kind: "predicate" as const, alternative: 0, frame: "qSend" },
    source_endpoint: { kind: "frame" as const, frame: "fSend" },
    query_support: { kind: "query_text" as const, excerpt: "sent" },
    source_semantic_support: [{ kind: "lexical" as const, mentions: ["mSent"] }]
  }]
};

it("admits contextual equivalence only and rejects answer ids, programs, and seeds", () => {
  expect(SourceSemanticCorrespondenceSchema.parse(semantic_correspondence).correspondences[0]?.relation)
    .toBe("contextual_equivalence");
  expect(SourceSemanticCorrespondenceSchema.safeParse({
    ...semantic_correspondence, correspondences: [{ ...semantic_correspondence.correspondences[0], relation: "entailment" }]
  }).success).toBe(false);
  expect(SourceSemanticCorrespondenceSchema.safeParse({ ...semantic_correspondence, answer_id: "ans" }).success).toBe(false);
  expect(SourceSemanticCorrespondenceSchema.safeParse({ ...semantic_correspondence, answer_ids: ["ans"] }).success).toBe(false);
  expect(SourceSemanticCorrespondenceSchema.safeParse({ ...semantic_correspondence, program: { kind: "epsilon" } }).success).toBe(false);
  expect(SourceSemanticCorrespondenceSchema.safeParse({ ...semantic_correspondence, seed_nodes: ["fSend"] }).success).toBe(false);
  expect(SourceSemanticCorrespondenceSchema.safeParse({ ...semantic_correspondence, seed: "fSend" }).success).toBe(false);
});

it("requires conditional computation to bind the semantic-correspondence id rather than a free branch digest", () => {
  expect(SourceSemanticEvaluationContextSchema.parse({
    contract: "source-semantic-context-v3", source_interpretation_id: digest, query_semantics_id: digest, semantic_correspondence_id: digest,
    k_version: "k1", lowering_version: "l1"
  }).semantic_correspondence_id).toBe(digest);
  expect(SourceSemanticEvaluationContextSchema.safeParse({
    contract: "source-semantic-context-v3", source_interpretation_id: digest, query_semantics_id: digest, branch_id: digest,
    k_version: "k1", lowering_version: "l1"
  }).success).toBe(false);
});
