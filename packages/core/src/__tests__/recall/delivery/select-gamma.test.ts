import { FIELD_PINS } from "../fine-assessment-selection-fixtures.js";
import { SELECT_GAMMA_OPERATOR_ID } from "@do-soul/alaya-protocol";
import { describe, expect, it } from "vitest";
import {
  selectGammaMarginalGain
} from "../../../recall/delivery/select-gamma/objective.js";

import { selectGammaQuality } from
  "../../../recall/delivery/select-gamma/quality.js";
import { selectGammaWalk } from
  "../../../recall/delivery/select-gamma/select-gamma.js";
import type { SelectGammaBinding } from
  "../../../recall/delivery/select-gamma/types.js";
import {
  buildSelectGammaRequest,
  deriveSelectGammaEligibility
} from "../../../recall/delivery/select-gamma/bind-fine-assessment.js";
import { createSelectionContext } from
  "../../../recall/delivery/fine-assessment-selection/coverage-order.js";
import {
  selectFineAssessmentCandidates
} from "../../../recall/delivery/fine-assessment-selection.js";
import {
  createCandidate,
  createConfig,
  createSupplementaryData
} from "../fine-assessment-selection-fixtures.js";

describe("Select_Gamma", () => {
  it("gates risk and authority before the coverage walk", () => {
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
      temporal_fit: 0.2
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
      workspace_id: candidate.entry.workspace_id,
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
      workspace_id: candidate.entry.workspace_id,
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

  it("uses deterministic ties and no 5-cap under a slack budget", () => {
    const binding = {
      candidates: [
        formulaCandidate("tie-b", { quality: 1, token_cost: 2 }),
        formulaCandidate("tie-a", { quality: 1, token_cost: 2 }),
        formulaCandidate("cheap", { quality: 1.2, token_cost: 1 }),
        formulaCandidate("k3", { quality: 0.2, token_cost: 1 }),
        formulaCandidate("k4", { quality: 0.2, token_cost: 1 }),
        formulaCandidate("k5", { quality: 0.2, token_cost: 1 }),
        formulaCandidate("k6", { quality: 0.2, token_cost: 1 })
      ]
    } satisfies SelectGammaBinding;
    const selected = selectKeys(binding, [
      "tie-b", "tie-a", "cheap", "k3", "k4", "k5", "k6"
    ], 20);
    expect(selected[0]).toBe("cheap");
    expect(selected.slice(1, 3)).toEqual(["tie-a", "tie-b"]);
    expect(selected).toHaveLength(7);
  });

  it("uses authority only after the primary objective is exactly tied", () => {
    const binding = {
      candidates: [
        formulaCandidate("unverified-a", { quality: 1 }),
        formulaCandidate("verified-z", {
          quality: 1,
          authority_tie_break: "verified_user_projection"
        })
      ],
      max_selected: 1
    } satisfies SelectGammaBinding;

    expect(selectKeys(binding, ["unverified-a", "verified-z"], 2))
      .toEqual(["verified-z"]);
  });

  it("keeps admission monotone when relevance increases", () => {
    const selectedAt = (quality: number) => selectKeys({
      candidates: [
        formulaCandidate("target", { quality }),
        formulaCandidate("peer", { quality: 0.7 })
      ],
      max_selected: 1
    }, ["target", "peer"], 2);

    expect(selectedAt(0.8)).toContain("target");
    expect(selectedAt(1)).toContain("target");
  });

  it("uses raw marginal gain when cardinality proves the token budget slack", () => {
    const binding = {
      candidates: [
        formulaCandidate("long-high-gain", { quality: 10, token_cost: 8 }),
        formulaCandidate("short-high-density", { quality: 2, token_cost: 1 })
      ],
      max_selected: 1
    } satisfies SelectGammaBinding;
    const result = selectResult(binding, [
      "long-high-gain", "short-high-density"
    ], 8);

    expect(result.selected_candidate_keys).toEqual(["long-high-gain"]);
    expect(result.selection_receipt).toEqual({
      schema_version: 3,
      objective_semantic_id: SELECT_GAMMA_OPERATOR_ID,
      ordering_basis: "raw_marginal_gain",
      witness: {
        kind: "static_top_k_token_bound",
        eligible_candidate_count: 2,
        k: 1,
        top_k_token_cost_upper_bound: 8,
        token_budget: 8
      }
    });
  });

  it("keeps density ordering when the static token-slack witness fails", () => {
    const binding = {
      candidates: [
        formulaCandidate("long-high-gain", { quality: 10, token_cost: 6 }),
        formulaCandidate("short-high-density", { quality: 4, token_cost: 2 }),
        formulaCandidate("medium", { quality: 5, token_cost: 4 })
      ],
      max_selected: 2
    } satisfies SelectGammaBinding;
    const result = selectResult(binding, [
      "long-high-gain", "short-high-density", "medium"
    ], 7);

    expect(result.selected_candidate_keys).toEqual([
      "short-high-density", "medium"
    ]);
    expect(result.selection_receipt.ordering_basis)
      .toBe("marginal_gain_per_token");
    expect(result.selection_receipt.witness).toMatchObject({
      k: 2,
      top_k_token_cost_upper_bound: 10,
      token_budget: 7
    });
  });

  it("fails before selection when the top-K token upper bound overflows", () => {
    const binding = {
      candidates: [
        formulaCandidate("huge-a", {
          quality: 2,
          token_cost: Number.MAX_VALUE
        }),
        formulaCandidate("huge-b", {
          quality: 1,
          token_cost: Number.MAX_VALUE
        })
      ],
      max_selected: 2
    } satisfies SelectGammaBinding;

    expect(() => selectResult(
      binding,
      ["huge-a", "huge-b"],
      Number.MAX_VALUE
    )).toThrow(/top-K token cost upper bound must be finite/u);
  });

  it("stops at the hard token boundary", () => {
    const binding = {
      candidates: [
        formulaCandidate("head", { quality: 1, token_cost: 4 }),
        formulaCandidate("overflow", { quality: 0.9, token_cost: 3 }),
        formulaCandidate("tail", { quality: 0.5, token_cost: 2 })
      ]
    } satisfies SelectGammaBinding;
    expect(selectKeys(binding, ["head", "overflow", "tail"], 6)).toEqual([
      "overflow",
      "tail"
    ]);
    expect(selectKeys(binding, ["head", "overflow", "tail"], 6)
      .reduce((sum, key) => sum + ({ head: 4, overflow: 3, tail: 2 }[key] ?? 99), 0))
      .toBeLessThanOrEqual(6);
  });

  it("gives overlapping lineage and saturated lexical little new coverage", () => {
    const binding = {
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
    } satisfies SelectGammaBinding;
    expect(selectKeys(binding, ["lex-1", "lex-2", "novel"], 3)).toEqual([
      "lex-1",
      "novel",
      "lex-2"
    ]);
  });

  it("prefers the better temporal fit when facts compete", () => {
    const binding = {
      candidates: [
        formulaCandidate("stale", {
          quality: selectGammaQuality({
            relevance: 0.4,
            temporal_fit: 0.1
          })
        }),
        formulaCandidate("current", {
          quality: selectGammaQuality({
            relevance: 0.4,
            temporal_fit: 0.8
          })
        })
      ]
    } satisfies SelectGammaBinding;
    expect(selectKeys(binding, ["stale", "current"], 1)).toEqual(["current"]);
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

});

function selectKeys(
  binding: SelectGammaBinding,
  eligible: readonly string[],
  tokenBudget: number
): readonly string[] {
  return selectResult(binding, eligible, tokenBudget).selected_candidate_keys;
}

function selectResult(
  binding: SelectGammaBinding,
  eligible: readonly string[],
  tokenBudget: number
) {
  const bound: SelectGammaBinding = {
    workspace_id: "workspace-1",
    generation_id: `sha256:${"a".repeat(64)}`,
    condition_digest: `sha256:${"b".repeat(64)}`,
    feature_weights: binding.feature_weights ?? {},
    max_selected: binding.max_selected ?? Number.MAX_SAFE_INTEGER,
    per_dimension_limits: binding.per_dimension_limits ?? null,
    candidates: binding.candidates
  };
  return selectGammaWalk({
    workspace_id: "workspace-1",
    generation_id: `sha256:${"a".repeat(64)}`,
    condition_digest: `sha256:${"b".repeat(64)}`,
    eligible_candidate_keys: eligible,
    token_budget: tokenBudget
  }, bound);
}

function formulaCandidate(
  key: string,
  params: Readonly<{
    readonly quality: number;
    readonly cover?: Readonly<Record<string, number>>;
    readonly token_cost?: number;
    readonly authority_tie_break?:
      "verified_user_assertion" | "verified_user_projection" | "unavailable";
  }>
) {
  return Object.freeze({
    workspace_id: "workspace-1",
    candidate_key: key,
    eligibility: { risk: "clear" as const, authority: "clear" as const },
    object_key: key,
    dimension: "procedure",
    source: { status: "unavailable" as const },
    lineage: { status: "unavailable" as const },
    token_cost: params.token_cost ?? 1,
    quality: params.quality,
    authority_tie_break: params.authority_tie_break ?? "unavailable",
    quality_channels: {
      temporal: { status: "unavailable" as const }
    },
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
