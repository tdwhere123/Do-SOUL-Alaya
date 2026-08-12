import { describe, expect, it } from "vitest";
import { retainVerifiedTemporalAnswerHead } from
  "../../../recall/delivery/admission/answer-head/verified-temporal-answer-head.js";
import { compileRecallQueryProbes } from
  "../../../recall/query/recall-query-probes.js";
import { createCandidate } from "../fine-assessment-selection-fixtures.js";

describe("verified temporal answer-head", () => {
  it("protects one source-exact current assertion at the fifth slot", () => {
    const candidates = Array.from({ length: 6 }, (_, index) =>
      createCandidate(`candidate-${index + 1}`));
    const current = candidates[5]!;
    const result = retainVerifiedTemporalAnswerHead({
      selection: selection(candidates),
      queryProbes: compileRecallQueryProbes("What book am I currently reading?"),
      contextsByMemoryId: {
        [current.entry.object_id]: {
          schema_version: 1,
          source_role: "user",
          evidence_ref: "evidence-current",
          assertion_text: current.entry.content,
          user_context: `I am currently reading it. ${current.entry.content}`
        }
      },
      maxEntries: 5,
      selectDelivered: (ordered) => ordered.slice(0, 6),
      keyOf: (candidate) => candidate.fusion.candidate_key
    });

    expect(result.candidates[4]?.entry.object_id).toBe(current.entry.object_id);
    expect(result.protections).toEqual([{
      candidateKey: current.fusion.candidate_key,
      rankLimit: 5
    }]);
  });

  it("does not infer current state from unverified candidate text", () => {
    const candidates = Array.from({ length: 6 }, (_, index) =>
      createCandidate(`candidate-${index + 1}`));
    expect(retainVerifiedTemporalAnswerHead({
      selection: selection(candidates),
      queryProbes: compileRecallQueryProbes("What book am I currently reading?"),
      contextsByMemoryId: {},
      maxEntries: 5,
      selectDelivered: (ordered) => ordered.slice(0, 6),
      keyOf: (candidate) => candidate.fusion.candidate_key
    })).toEqual(selection(candidates));
  });

  it("protects a verified current assertion already inside the answer head", () => {
    const candidates = Array.from({ length: 5 }, (_, index) =>
      createCandidate(`candidate-${index + 1}`));
    const current = candidates[2]!;
    const result = retainVerifiedTemporalAnswerHead({
      selection: selection(candidates),
      queryProbes: compileRecallQueryProbes("What book am I currently reading?"),
      contextsByMemoryId: {
        [current.entry.object_id]: {
          schema_version: 1,
          source_role: "user",
          evidence_ref: "evidence-current",
          assertion_text: current.entry.content,
          user_context: `I am currently reading it. ${current.entry.content}`
        }
      },
      maxEntries: 5,
      selectDelivered: (ordered) => ordered,
      keyOf: (candidate) => candidate.fusion.candidate_key
    });

    expect(result.candidates).toBe(candidates);
    expect(result.protections).toEqual([{
      candidateKey: current.fusion.candidate_key,
      rankLimit: 5
    }]);
  });
});

function selection(candidates: readonly ReturnType<typeof createCandidate>[]) {
  return Object.freeze({
    candidates,
    protections: Object.freeze([]),
    rejectedCandidateKeys: Object.freeze([])
  });
}
