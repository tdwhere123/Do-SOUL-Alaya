import { FIELD_PINS } from "../fine-assessment-selection-fixtures.js";
import { describe, expect, it } from "vitest";
import type { SelectGammaPort } from "@do-soul/alaya-protocol";
import {
  selectGammaMarginalGain
} from "../../../recall/delivery/select-gamma/objective.js";

import { gateSelectGammaEligibility } from
  "../../../recall/delivery/select-gamma/eligibility.js";
import { selectGammaQuality } from
  "../../../recall/delivery/select-gamma/quality.js";
import { createSelectGammaPort } from
  "../../../recall/delivery/select-gamma/select-gamma.js";
import {
  buildSelectGammaRequest,
  deriveSelectGammaEligibility
} from "../../../recall/delivery/select-gamma/bind-fine-assessment.js";
import { createSelectionContext } from
  "../../../recall/delivery/fine-assessment-selection/coverage-order.js";
import {
  selectFineAssessmentCandidates
} from "../../../recall/delivery/fine-assessment-selection.js";
import { resolveFinalPacketConsensusPlan } from
  "../../../recall/delivery/final-order/final-packet-consensus.js";
import {
  createCandidate,
  createConfig,
  createSupplementaryData
} from "../fine-assessment-selection-fixtures.js";
import {
  baselineCandidates,
  consensusCandidates,
  select as selectConsensusFixture
} from "../final-strict-tail-consensus-fixtures.js";

describe("Select_Gamma", () => {
  it("gates risk and authority before the coverage walk", () => {
    expect(gateSelectGammaEligibility([
      { candidate_key: "safe", risk: "clear", authority: "clear" },
      { candidate_key: "risky", risk: "blocked", authority: "clear" },
      { candidate_key: "untrusted", risk: "clear", authority: "blocked" }
    ])).toEqual(["safe"]);
    const hidden = {
      ...createCandidate("hidden"),
      entry: { ...createCandidate("hidden").entry, object_id: "hidden-1" }
    };
    expect(deriveSelectGammaEligibility(hidden, {
      config: { conflict_awareness: true, budgets: createConfig().budgets },
      supplementaryData: { governanceCeilingByMemoryId: { "hidden-1": "hidden" } }
    } as never).authority).toBe("blocked");
  });

  it("keeps quality nonnegative and coverage gains diminishing", () => {
    expect(selectGammaQuality({
      relevance: -1,
      authority: 0.2,
      temporal_fit: 0.2,
      path_support: 0.2
    })).toBe(0);
    const weights = { lexical: 1, lineage: 1 };
    const first = { quality: 0.4, cover: { lexical: 1, lineage: 1 } };
    const repeat = { quality: 0.4, cover: { lexical: 1, lineage: 1 } };
    const empty = new Map<string, number>();
    const firstGain = selectGammaMarginalGain(first, empty, weights);
    const afterFirst = new Map([["lexical", 1], ["lineage", 1]]);
    const repeatGain = selectGammaMarginalGain(repeat, afterFirst, weights);
    expect(firstGain).toBeGreaterThan(0);
    expect(repeatGain).toBeGreaterThanOrEqual(0);
    expect(repeatGain).toBeLessThan(firstGain);
  });

  it("fails closed when generation or condition pins are missing", () => {
    const candidate = createCandidate("unpinned");
    const params = {
      orderedCandidates: [candidate],
      config: createConfig(),
      supplementaryData: createSupplementaryData(),
      tokenEstimator: { estimate: () => 6 },
      rankByCandidateKey: new Map()
    };
    expect(() => buildSelectGammaRequest(
      params,
      createSelectionContext(params),
      [candidate]
    )).toThrow(/generation_id/u);
  });

  it("binds pinned generation and condition receipts on the live request", () => {
    const candidate = createCandidate("pinned");
    const params = {
      orderedCandidates: [candidate],
      generation_id: `sha256:${"c".repeat(64)}`,
      condition_digest: `sha256:${"d".repeat(64)}`,
      config: createConfig(),
      supplementaryData: createSupplementaryData(),
      tokenEstimator: { estimate: () => 6 },
      rankByCandidateKey: new Map()
    };
    const request = buildSelectGammaRequest(
      params,
      createSelectionContext(params),
      [candidate]
    );
    expect(request.generation_id).toBe(`sha256:${"c".repeat(64)}`);
    expect(request.condition_digest).toBe(`sha256:${"d".repeat(64)}`);
    expect(request.generation_id).not.toBe("unspecified");
    expect(request.condition_digest).not.toBe("unspecified");
  });

  it("selects by gain per token with deterministic ties and no 5-cap", () => {
    const port = createSelectGammaPort({
      candidates: [
        formulaCandidate("tie-b", { quality: 1, token_cost: 2 }),
        formulaCandidate("tie-a", { quality: 1, token_cost: 2 }),
        formulaCandidate("cheap", { quality: 0.6, token_cost: 1 }),
        formulaCandidate("k3", { quality: 0.2, token_cost: 1 }),
        formulaCandidate("k4", { quality: 0.2, token_cost: 1 }),
        formulaCandidate("k5", { quality: 0.2, token_cost: 1 }),
        formulaCandidate("k6", { quality: 0.2, token_cost: 1 })
      ]
    });
    const selected = selectKeys(port, [
      "tie-b", "tie-a", "cheap", "k3", "k4", "k5", "k6"
    ], 20);
    expect(selected[0]).toBe("cheap");
    expect(selected.slice(1, 3)).toEqual(["tie-a", "tie-b"]);
    expect(selected).toHaveLength(7);
  });

  it("stops at the hard token boundary", () => {
    const port = createSelectGammaPort({
      candidates: [
        formulaCandidate("head", { quality: 1, token_cost: 4 }),
        formulaCandidate("overflow", { quality: 0.9, token_cost: 3 }),
        formulaCandidate("tail", { quality: 0.5, token_cost: 2 })
      ]
    });
    expect(selectKeys(port, ["head", "overflow", "tail"], 6)).toEqual([
      "overflow",
      "tail"
    ]);
    expect(selectKeys(port, ["head", "overflow", "tail"], 6)
      .reduce((sum, key) => sum + ({ head: 4, overflow: 3, tail: 2 }[key] ?? 99), 0))
      .toBeLessThanOrEqual(6);
  });

  it("gives overlapping lineage and saturated lexical little new coverage", () => {
    const port = createSelectGammaPort({
      candidates: [
        formulaCandidate("lex-1", {
          quality: 0.1,
          cover: { lexical: 1, lineage: 1 }
        }),
        formulaCandidate("lex-2", {
          quality: 0.1,
          cover: { lexical: 1, lineage: 1 }
        }),
        formulaCandidate("novel", {
          quality: 0.1,
          cover: { fresh: 1 }
        })
      ],
      feature_weights: { lexical: 2, lineage: 2, fresh: 2 }
    });
    expect(selectKeys(port, ["lex-1", "lex-2", "novel"], 3)).toEqual([
      "lex-1",
      "novel",
      "lex-2"
    ]);
  });

  it("prefers the better temporal fit when facts compete", () => {
    const port = createSelectGammaPort({
      candidates: [
        formulaCandidate("stale", {
          quality: selectGammaQuality({
            relevance: 0.4,
            authority: 0,
            temporal_fit: 0.1,
            path_support: 0
          })
        }),
        formulaCandidate("current", {
          quality: selectGammaQuality({
            relevance: 0.4,
            authority: 0,
            temporal_fit: 0.8,
            path_support: 0
          })
        })
      ]
    });
    expect(selectKeys(port, ["stale", "current"], 1)).toEqual(["current"]);
  });

  it("keeps Select_Gamma admission order as the delivered packet", () => {
    const first = withScore(createCandidate("dup-a"), 0.99);
    const second = withScore(createCandidate("dup-b"), 0.98);
    const novel = withScore(createCandidate("novel"), 0.4);
    const candidates = [first, second, novel];
    const result = selectFineAssessmentCandidates({
    ...FIELD_PINS,
      orderedCandidates: candidates,
      config: {
        ...createConfig(),
        budgets: { ...createConfig().budgets, max_entries: 2 }
      },
      supplementaryData: createSupplementaryData({
        evidenceGistsByMemoryId: {
          "dup-a": "same-gist",
          "dup-b": "same-gist",
          novel: "fresh-gist"
        }
      }),
      tokenEstimator: { estimate: () => 6 },
      rankByCandidateKey: new Map(candidates.map((candidate, index) => [
        candidate.fusion.candidate_key,
        index + 1
      ])),
      coverageRelevanceByCandidateKey: new Map([
        [first.fusion.candidate_key, 0.2],
        [second.fusion.candidate_key, 0.15],
        [novel.fusion.candidate_key, 0.95]
      ])
    });
    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "novel",
      "dup-a"
    ]);
  });

  it("does not let later consensus reorder or insert after admission", () => {
    const source = consensusCandidates();
    const result = selectConsensusFixture(source);
    const consensus = resolveFinalPacketConsensusPlan({
      baseline: baselineCandidates(),
      sourceCandidates: source,
      protectedCandidates: []
    });
    expect(result.candidates.map((candidate) => candidate.object_id))
      .not.toContain("challenger");
    expect(consensus.decision.status).toBe("accepted");
    expect(consensus.proposedCandidates.some(
      (candidate) => candidate.sourceCandidate.entry.object_id === "challenger"
    )).toBe(true);
  });
});

function selectKeys(
  port: SelectGammaPort,
  eligible: readonly string[],
  tokenBudget: number
): readonly string[] {
  return port.select({
    workspace_id: "workspace-1",
    generation_id: `sha256:${"a".repeat(64)}`,
    condition_digest: `sha256:${"b".repeat(64)}`,
    eligible_candidate_keys: eligible,
    token_budget: tokenBudget
  }).selected_candidate_keys;
}

function formulaCandidate(
  key: string,
  params: Readonly<{
    readonly quality: number;
    readonly cover?: Readonly<Record<string, number>>;
    readonly token_cost?: number;
  }>
) {
  return Object.freeze({
    candidate_key: key,
    token_cost: params.token_cost ?? 1,
    quality: params.quality,
    cover: params.cover ?? {}
  });
}

function withScore(
  candidate: ReturnType<typeof createCandidate>,
  fusedScore: number
) {
  return {
    ...candidate,
    fusion: { ...candidate.fusion, fused_score: fusedScore }
  };
}
