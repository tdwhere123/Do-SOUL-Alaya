import { describe, expect, it } from "vitest";
import { compileRecallAnswerShapePlan } from "../../recall/query/recall-answer-shape-plan.js";
import {
  buildRecallCandidateAnswerSupport
} from "../../recall/query/recall-candidate-answer-support.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import { createCandidate } from "./fine-assessment-selection-fixtures.js";

function planFor(query: string) {
  return compileRecallAnswerShapePlan(compileRecallQueryProbes(query));
}

describe("recall candidate answer support", () => {
  it("recognizes a grounded candidate-local place answer", () => {
    const candidate = createCandidate("bookshelf", {
      content: "The new bookshelf is from IKEA.",
      evidence_refs: ["evidence-bookshelf"]
    });

    expect(buildRecallCandidateAnswerSupport(
      planFor("Where did I buy my new bookshelf from?"),
      candidate.entry,
      "memory_entry"
    )).toMatchObject({
      schema_version: 1,
      shape: "place",
      status: "compatible",
      eligible: true,
      value_supported: true,
      target_supported: true,
      relation_supported: true,
      matched_target_terms: ["bookshelf"]
    });
  });

  it("keeps a duration value diagnostic-only without target and relation support", () => {
    const candidate = createCandidate("asylum-duration", {
      content: "Over a year of uncertainty was really tough.",
      evidence_refs: ["evidence-asylum"]
    });

    expect(buildRecallCandidateAnswerSupport(
      planFor("How long did I wait for the decision on my asylum application?"),
      candidate.entry,
      "memory_entry"
    )).toEqual({
      schema_version: 1,
      shape: "duration",
      status: "value_only",
      eligible: true,
      value_supported: true,
      target_supported: false,
      relation_supported: false,
      matched_target_terms: [],
      matched_relation_terms: []
    });
  });

  it("keeps aggregate shapes observation-only", () => {
    const candidate = createCandidate("bike-expense", {
      content: "I paid $120 for the bike and $40 for a tune-up.",
      evidence_refs: ["evidence-bike"]
    });

    expect(buildRecallCandidateAnswerSupport(
      planFor("How much total money have I spent on bike expenses?"),
      candidate.entry,
      "memory_entry"
    )).toMatchObject({
      shape: "sum",
      status: "observation_only",
      eligible: true
    });
  });

  it("rejects synthesis and entries without an evidence reference", () => {
    const content = "The new bookshelf is from IKEA.";
    const synthesis = createCandidate(
      "synthesis",
      { content, evidence_refs: ["synthesis-source"] },
      "synthesis_capsule"
    );
    const ungrounded = createCandidate("ungrounded", { content, evidence_refs: [] });
    const plan = planFor("Where did I buy my new bookshelf from?");

    expect(buildRecallCandidateAnswerSupport(
      plan,
      synthesis.entry,
      "synthesis_capsule"
    )?.status).toBe("ineligible");
    expect(buildRecallCandidateAnswerSupport(
      plan,
      ungrounded.entry,
      "memory_entry"
    )?.status).toBe("ineligible");
  });
});
