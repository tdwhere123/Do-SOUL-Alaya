import { describe, expect, it } from "vitest";

import { selectBoundedDirectEvidenceHead } from
  "../../recall/delivery/admission/direct-evidence-answer-head.js";
import { compileRecallQueryProbes } from
  "../../recall/query/recall-query-probes.js";
import type { FineAssessmentCandidate } from
  "../../recall/delivery/fine-assessment-selection.js";
import { createCandidate } from "./fine-assessment-selection-fixtures.js";
import {
  evidenceSemanticActivation,
  evidenceSemanticActivationsFromScores
} from
  "./fixtures/evidence-semantic-activation.js";

describe("linked Evidence semantic selection", () => {
  it("inherits a linked Evidence observation when choosing the Memory leader", () => {
    const primary = withSemanticActivation(createCandidate("primary"), 0.2);
    const linked = withSemanticActivation(createCandidate("linked"), 0.05);
    const candidates = [primary, linked];
    const selection = selectBoundedDirectEvidenceHead(
      candidates,
      compileRecallQueryProbes(null),
      evidenceSemanticActivationsFromScores(new Map([
        [linked.fusion.candidate_key, 1]
      ])),
      new Map([
        [primary.fusion.candidate_key, 0.8],
        [linked.fusion.candidate_key, 0.1]
      ]),
      2,
      new Set(),
      (ordered) => ordered.slice(0, 2),
      () => false
    );

    expect(selection.protections).toEqual([{
      candidateKey: linked.fusion.candidate_key,
      rankLimit: 1
    }]);
  });

  it("does not weaken a Memory observation when linked Evidence is weaker", () => {
    const primary = withSemanticActivation(createCandidate("primary"), 0.8);
    const linked = withSemanticActivation(createCandidate("linked"), 0.2);
    const selection = selectBoundedDirectEvidenceHead(
      [primary, linked],
      compileRecallQueryProbes(null),
      evidenceSemanticActivationsFromScores(new Map([
        [primary.fusion.candidate_key, 0.1],
        [linked.fusion.candidate_key, 0.4]
      ])),
      new Map(),
      2,
      new Set(),
      (ordered) => ordered.slice(0, 2),
      () => false
    );

    expect(selection.protections).toEqual([{
      candidateKey: primary.fusion.candidate_key,
      rankLimit: 1
    }]);
  });

  it("keeps owner-gist evidence from choosing one leader for an aggregate answer", () => {
    const entryLeader = withSemanticActivation(createCandidate("entry-leader"), 0.8);
    const gistLeader = withSemanticActivation(createCandidate("gist-leader"), 0.2);
    const selection = selectBoundedDirectEvidenceHead(
      [entryLeader, gistLeader],
      compileRecallQueryProbes("How many projects did I lead?"),
      new Map([[
        gistLeader.fusion.candidate_key,
        evidenceSemanticActivation(1, { documentIdentity: "owner_gist_600" })
      ]]),
      new Map(),
      2,
      new Set(),
      (ordered) => ordered.slice(0, 2),
      () => false,
      false
    );

    expect(selection.protections).toEqual([{
      candidateKey: entryLeader.fusion.candidate_key,
      rankLimit: 1
    }]);
  });

  it("keeps an absent linked observation from poisoning Memory activation", () => {
    const primary = withSemanticActivation(createCandidate("primary"), 0.8);
    const linked = withSemanticActivation(createCandidate("linked"), 0.2);
    const selection = selectBoundedDirectEvidenceHead(
      [primary, linked],
      compileRecallQueryProbes(null),
      evidenceSemanticActivationsFromScores(new Map([
        [linked.fusion.candidate_key, 0.4]
      ])),
      new Map(),
      2,
      new Set(),
      (ordered) => ordered.slice(0, 2),
      () => false
    );

    expect(selection.protections).toEqual([{
      candidateKey: primary.fusion.candidate_key,
      rankLimit: 1
    }]);
  });
});

function withSemanticActivation(
  candidate: FineAssessmentCandidate,
  embeddingSimilarity: number
): FineAssessmentCandidate {
  return {
    ...candidate,
    effectiveFactors: {
      ...candidate.effectiveFactors,
      embedding_similarity: embeddingSimilarity
    }
  };
}
