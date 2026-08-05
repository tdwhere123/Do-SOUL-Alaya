import { describe, expect, it } from "vitest";
import { retainBehaviorAuthorityAnswerHead } from
  "../../../recall/delivery/admission/answer-head/behavior-authority-answer-head.js";
import { selectBoundedDirectEvidenceHead } from
  "../../../recall/delivery/admission/direct-evidence-answer-head.js";
import { compileRecallQueryProbes } from
  "../../../recall/query/recall-query-probes.js";
import { createCandidate } from
  "../fine-assessment-selection-fixtures.js";

describe("behavior authority answer head", () => {
  it("keeps an eligible candidate already in the protected head in place", () => {
    const selection = simpleSelection(["a", "b", "c", "d", "e", "f"]);
    const retained = retainBehaviorAuthorityAnswerHead({
      selection,
      rankLimit: 5,
      selectDelivered: (candidates) => candidates,
      keyOf: (candidate) => candidate,
      isBehaviorEligible: (candidate) => candidate === "b"
    });

    expect(retained.candidates).toEqual(selection.candidates);
    expect(retained.protections).toEqual([{ candidateKey: "b", rankLimit: 5 }]);
  });

  it("leaves zero, ambiguous, and short-head opportunities unchanged", () => {
    const selection = simpleSelection(["a", "b", "c", "d", "e", "f", "g"]);
    const unchanged = (eligible: (candidate: string) => boolean, candidates = selection) =>
      retainBehaviorAuthorityAnswerHead({
        selection: candidates,
        rankLimit: 5,
        selectDelivered: (ordered) => ordered,
        keyOf: (candidate) => candidate,
        isBehaviorEligible: eligible
      });

    expect(unchanged(() => false)).toEqual(selection);
    expect(unchanged((candidate) => candidate === "f" || candidate === "g"))
      .toEqual(selection);
    const short = simpleSelection(["a", "b"]);
    expect(unchanged(() => true, short)).toEqual(short);
  });

  it("protects one verified opportunity at the answer boundary", () => {
    const candidates = Array.from({ length: 6 }, (_, index) =>
      createCandidate(`candidate-${index + 1}`));
    const opportunity = candidates[5]!;

    const selection = selectBoundedDirectEvidenceHead(
      candidates,
      compileRecallQueryProbes("Where did I buy my bookshelf?"),
      new Map(),
      new Map(),
      10,
      new Set(),
      (ordered) => ordered,
      (candidate) => candidate === opportunity
    );

    expect(selection.protections).toContainEqual({
      candidateKey: opportunity.fusion.candidate_key,
      rankLimit: 5
    });
    expect(selection.candidates[4]).toBe(opportunity);
  });

  it("does not choose between ambiguous verified opportunities", () => {
    const candidates = Array.from({ length: 7 }, (_, index) =>
      createCandidate(`candidate-${index + 1}`));

    const selection = selectBoundedDirectEvidenceHead(
      candidates,
      compileRecallQueryProbes("Where did I buy my bookshelf?"),
      new Map(),
      new Map(),
      10,
      new Set(),
      (ordered) => ordered,
      (candidate) => candidate === candidates[5] || candidate === candidates[6]
    );

    expect(selection.protections).toEqual([]);
  });
});

function simpleSelection(candidates: readonly string[]) {
  return Object.freeze({
    candidates: Object.freeze([...candidates]),
    protections: Object.freeze([]),
    rejectedCandidateKeys: Object.freeze([])
  });
}
