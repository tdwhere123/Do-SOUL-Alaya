import { describe, expect, it, vi } from "vitest";
import { selectFineAssessmentCandidates } from
  "../../recall/delivery/fine-assessment-selection.js";
import {
  FIELD_PINS,
  createCandidate,
  createConfig,
  createRankedCandidate,
  createRanks,
  createSupplementaryData,
  rankMap,
  stageRanks
} from "./fine-assessment-selection-fixtures.js";

describe("selectFineAssessmentCandidates delivery", () => {
  it("omits answer features unless deep diagnostic capture is explicit", () => {
    const result = selectFineAssessmentCandidates({
      ...FIELD_PINS,
      orderedCandidates: [createCandidate("memory-1")],
      config: createConfig(),
      supplementaryData: createSupplementaryData(),
      tokenEstimator: { estimate: vi.fn(() => 6) },
      rankByCandidateKey: createRanks()
    });

    expect(result.diagnostics[0]).not.toHaveProperty("answer_features");
    expect(result.diagnostics[0]).not.toHaveProperty("selector_observation");
  });

  it("deduplicates object representations while retaining provenance diagnostics", () => {
    const local = createCandidate("shared");
    const globalBase = createCandidate("shared");
    const global = {
      ...globalBase,
      originPlane: "global" as const,
      fusion: {
        ...globalBase.fusion,
        candidate_key: "global:memory_entry:shared",
        fused_rank: 2,
        fused_score: 0.6
      }
    };
    const next = createCandidate("next");
    const result = selectFineAssessmentCandidates({
      ...FIELD_PINS,
      orderedCandidates: [local, global, next],
      config: {
        ...createConfig(),
        budgets: { ...createConfig().budgets, max_entries: 2 }
      },
      supplementaryData: createSupplementaryData(),
      tokenEstimator: { estimate: vi.fn(() => 6) },
      rankByCandidateKey: new Map([
        [local.fusion.candidate_key, 1],
        [global.fusion.candidate_key, 2],
        [next.fusion.candidate_key, 3]
      ])
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "next",
      "shared"
    ]);
    expect(result.diagnostics.map((candidate) => ({
      candidateKey: candidate.candidate_key,
      droppedReason: candidate.dropped_reason
    }))).toEqual([
      { candidateKey: next.fusion.candidate_key, droppedReason: null },
      { candidateKey: local.fusion.candidate_key, droppedReason: null },
      { candidateKey: global.fusion.candidate_key, droppedReason: "duplicate" }
    ]);
  });

  it("does not let gist cover move quality order", () => {
    const primary = createRankedCandidate("primary", 1, 1);
    const redundant = createRankedCandidate("redundant", 2, 0.9);
    const diverse = createRankedCandidate("diverse", 3, 0.8);
    const result = selectFineAssessmentCandidates({
      ...FIELD_PINS,
      orderedCandidates: [primary, redundant, diverse],
      config: createConfig(),
      supplementaryData: createSupplementaryData({
        evidenceGistsByMemoryId: {
          primary: "shared gist",
          redundant: "shared gist",
          diverse: "different gist"
        }
      }),
      tokenEstimator: { estimate: vi.fn(() => 6) },
      rankByCandidateKey: rankMap([primary, redundant, diverse]),
      coverageRelevanceByCandidateKey: new Map([
        [primary.fusion.candidate_key, 1],
        [redundant.fusion.candidate_key, 0.9],
        [diverse.fusion.candidate_key, 0.8]
      ])
    });

    expect(stageRanks(result, "primary")).toEqual([1, 1, "kept"]);
    expect(stageRanks(result, "redundant")).toEqual([2, 2, "kept"]);
    expect(stageRanks(result, "diverse")).toEqual([3, 3, "kept"]);
  });

  it("captures traces without changing the delivered packet", () => {
    const primary = createRankedCandidate("primary", 1, 1);
    const redundant = createRankedCandidate("redundant", 2, 0.9);
    const diverse = createRankedCandidate("diverse", 3, 0.8);
    const candidates = [primary, redundant, diverse];
    const coverageRelevanceByCandidateKey = new Map([
      [primary.fusion.candidate_key, 1],
      [redundant.fusion.candidate_key, 0.9],
      [diverse.fusion.candidate_key, 0.8]
    ]);
    const trace = Object.freeze({
      lexical_agreement: 0.9,
      evidence_agreement: 0.5,
      resolved_evidence: 0.9,
      embedding_signal: 0.4,
      fusion_baseline_used: false,
      resolved_score: 0.94,
      score_source: "embedding_evidence" as const
    });
    const deepHeadTraceByCandidateKey = new Map(
      candidates.map((candidate) => [candidate.fusion.candidate_key, trace])
    );
    const select = (captureAnswerFeatures: boolean) => selectFineAssessmentCandidates({
      ...FIELD_PINS,
      orderedCandidates: candidates,
      config: createConfig(),
      supplementaryData: createSupplementaryData({
        evidenceGistsByMemoryId: {
          primary: "shared gist",
          redundant: "shared gist",
          diverse: "different gist"
        }
      }),
      tokenEstimator: { estimate: vi.fn(() => 6) },
      rankByCandidateKey: rankMap(candidates),
      coverageRelevanceByCandidateKey,
      deepHeadTraceByCandidateKey,
      captureAnswerFeatures
    });

    const withoutTrace = select(false);
    const withTrace = select(true);
    expect(withTrace.candidates).toEqual(withoutTrace.candidates);
    expect(withoutTrace.diagnostics[0]).not.toHaveProperty("deep_head_trace");
    expect(withoutTrace.diagnostics[0]).not.toHaveProperty("coverage_marginal_gain");
    expect(withoutTrace.diagnostics[0]).not.toHaveProperty("selector_observation");
    expect(withTrace.diagnostics[0]).toMatchObject({
      deep_head_trace: trace,
      coverage_marginal_gain: 1,
      selector_observation: { coverage: { marginal_gain: 1 } }
    });
    expect(withTrace.diagnostics.find((row) => row.object_id === "redundant"))
      .toMatchObject({ coverage_marginal_gain: 0.9 });
  });
});
