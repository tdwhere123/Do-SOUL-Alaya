import { describe, expect, it } from "vitest";
import {
  buildFineAssessmentSelectGammaBinding,
  deriveSelectGammaEligibility
} from "../../../recall/delivery/select-gamma/bind-fine-assessment.js";
import type { RecallCandidateAnswerSupport } from
  "../../../recall/query/recall-candidate-answer-support.js";
import { createSelectionContext } from
  "../../../recall/delivery/fine-assessment-selection/coverage-order.js";
import {
  OPEN_SEMANTIC_FACTOR_CANDIDATE_ACTIVATION_OPERATOR_ID
} from "../../../recall/field/open-semantic-factors/candidate-attribution.js";
import type { IntegratedFloodCandidateDiagnostics } from
  "../../../recall/runtime/recall-service-types.js";
import {
  createCandidate,
  createConfig,
  createRankedCandidate,
  createSupplementaryData,
  rankMap,
  selectCandidates
} from "../fine-assessment-selection-fixtures.js";

describe("live Select_Gamma binding", () => {
  it("keeps source and lineage as identity receipts outside cover", () => {
    const candidate = {
      ...createCandidate("bound"),
      evidenceSourceIdentity: "source-1",
      evidenceSourceRole: "user" as const,
      verifiedUserSupportSource: {
        evidence_ref: "evidence-1",
        projection_kind: "atomic_assertion" as const
      },
      entry: {
        ...createCandidate("bound").entry,
        evidence_refs: ["evidence-1"],
        event_time_start: "2026-08-16T00:00:00.000Z",
        event_time_end: "2026-08-16T01:00:00.000Z"
      }
    };
    const params = fixture(candidate, createSupplementaryData({
      queryTimeWindow: {
        startMs: Date.parse("2026-08-16T00:00:00.000Z"),
        endMs: Date.parse("2026-08-16T02:00:00.000Z")
      },
      sourceCohortKeys: { bound: "lineage-1" },
      pathInflowAvailability: "available",
      pathInflowByTarget: { bound: [{
        pathId: "path-1",
        relationKind: "answers_with",
        seedObjectId: "seed-1",
        targetObjectId: "bound",
        seedAnchor: { kind: "object", object_id: "seed-1" },
        targetAnchor: { kind: "object", object_id: "bound" },
        pathSourceVersion: "v1",
        weight: 0.8
      }] },
      evidenceProjectionMatchesByRef: {
        "evidence-1": [{
          evidence_ref: "evidence-1",
          projection_kind: "fact_key",
          projection_id: 1,
          normalized_rank: 1,
          fact_key_forms: [{ kind: "complete" }]
        }]
      }
    }));
    const binding = buildFineAssessmentSelectGammaBinding(
      params,
      createSelectionContext(params)
    );
    const bound = binding.candidates[0]!;

    expect(bound.authority_tie_break).toBe("verified_user_assertion");
    expect(bound.quality_channels.temporal.status).toBe("available");
    expect(bound.quality_channels).not.toHaveProperty("path");
    expect(Object.keys(bound.cover)).toEqual([]);
    expect(bound.source).toEqual({ status: "available", key: "source-1" });
    expect(bound.lineage).toEqual({ status: "available", key: "lineage-1" });
    expect(binding.source_hard_dedupe).toBe(true);
  });

  it("covers only independently evidenced query-bound axes", () => {
    const candidate = withFlood(createCandidate("attributed"), {
      slice: true,
      path: true,
      evidence: true
    });
    const params = fixture(candidate, createSupplementaryData({
      sourceCohortKeys: { attributed: "session-lineage" },
      evidenceGistsByMemoryId: { attributed: "session gist" },
      openSemanticFactorCandidateActivationsByCandidateKey: new Map([
        [candidate.fusion.candidate_key, observedOpenSemanticActivation()]
      ])
    }));
    const bound = buildFineAssessmentSelectGammaBinding(
      params,
      createSelectionContext(params)
    ).candidates[0]!;

    expect(Object.keys(bound.cover).sort()).toEqual([
      "f3",
      "slice"
    ]);
    expect(bound.lineage).toEqual({ status: "available", key: "session-lineage" });
  });

  it("does not let an active path displace higher relevance under slack", () => {
    const relevant = withFlood(createRankedCandidate("relevant", 1, 1), {});
    const routed = withFlood(createRankedCandidate("routed", 2, 0.4), {
      path: true
    });
    const result = selectCandidates({
      workspace_id: relevant.entry.workspace_id,
      orderedCandidates: [relevant, routed],
      config: tightBudget(1),
      supplementaryData: createSupplementaryData({
        pathInflowAvailability: "available",
        pathInflowByTarget: { routed: [pathInflow("routed", 0.8)] }
      }),
      tokenEstimator: { estimate: () => 6 },
      rankByCandidateKey: rankMap([relevant, routed])
    });

    expect(result.candidates.map((candidate) => candidate.object_id))
      .toEqual(["relevant"]);
  });

  it("does not let verified authority overpower higher relevance", () => {
    const relevant = createRankedCandidate("relevant", 1, 1);
    const verifiedBase = createRankedCandidate("verified", 2, 0.4);
    const verified = {
      ...verifiedBase,
      evidenceSourceRole: "user" as const,
      verifiedUserSupportSource: {
        evidence_ref: "evidence-verified",
        projection_kind: "atomic_assertion" as const
      },
      entry: {
        ...verifiedBase.entry,
        evidence_refs: ["evidence-verified"]
      }
    };
    const result = selectCandidates({
      workspace_id: relevant.entry.workspace_id,
      orderedCandidates: [relevant, verified],
      config: tightBudget(1),
      supplementaryData: createSupplementaryData(),
      tokenEstimator: { estimate: () => 6 },
      rankByCandidateKey: rankMap([relevant, verified])
    });

    expect(result.candidates.map((candidate) => candidate.object_id))
      .toEqual(["relevant"]);
  });

  it("declares no generic path role inside Select_Gamma", () => {
    const candidate = withFlood(createCandidate("path-only"), { path: true });
    const params = fixture(candidate, createSupplementaryData({
      pathInflowAvailability: "available",
      pathInflowByTarget: { "path-only": [pathInflow("path-only", 0.8)] }
    }));
    const bound = buildFineAssessmentSelectGammaBinding(
      params,
      createSelectionContext(params)
    ).candidates[0]!;

    expect(bound.quality_channels).not.toHaveProperty("path");
    expect(bound.cover).not.toHaveProperty("path");
  });

  it("does not reward ordinary evidence without a query-bound receipt", () => {
    const plain = withFlood(createRankedCandidate("a-plain", 1, 0.7), {});
    const evidenceBase = createRankedCandidate("z-evidence", 2, 0.7);
    const evidence = withFlood({
      ...evidenceBase,
      entry: {
        ...evidenceBase.entry,
        evidence_refs: ["ordinary-evidence"]
      }
    }, { evidence: true });
    const supplementaryData = createSupplementaryData();
    const params = {
      ...fixture(plain, supplementaryData),
      orderedCandidates: [plain, evidence]
    };
    const binding = buildFineAssessmentSelectGammaBinding(
      params,
      createSelectionContext(params)
    );
    const coverByObject = new Map(binding.candidates.map((candidate) => [
      candidate.object_key,
      candidate.cover
    ]));

    expect([...coverByObject.values()]).toEqual([{}, {}]);
    const result = selectCandidates({
      ...params,
      config: tightBudget(1),
      rankByCandidateKey: rankMap([plain, evidence])
    });
    expect(result.candidates.map((candidate) => candidate.object_id))
      .toEqual(["a-plain"]);
  });

  it("does not let lineage or gist displace a higher-quality candidate", () => {
    const gold = createRankedCandidate("gold", 1, 0.8);
    const distractor = createRankedCandidate("distract", 2, 0.3);
    const result = selectCandidates({
      workspace_id: gold.entry.workspace_id,
      orderedCandidates: [gold, distractor],
      config: tightBudget(1),
      supplementaryData: createSupplementaryData({
        sourceCohortKeys: { gold: "session-a", distract: "session-b" },
        evidenceGistsByMemoryId: { gold: "gist-a", distract: "gist-b" }
      }),
      tokenEstimator: { estimate: () => 6 },
      rankByCandidateKey: rankMap([gold, distractor])
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual(["gold"]);
  });

  it("lets a unique active slice cover promote a weaker candidate", () => {
    const strong = withFlood(createRankedCandidate("strong", 1, 0.8), {});
    const weakSlice = withFlood(createRankedCandidate("weak-slice", 2, 0.3), {
      slice: true
    });
    const result = selectCandidates({
      workspace_id: strong.entry.workspace_id,
      orderedCandidates: [strong, weakSlice],
      config: tightBudget(1),
      supplementaryData: createSupplementaryData(),
      tokenEstimator: { estimate: () => 6 },
      rankByCandidateKey: rankMap([strong, weakSlice])
    });

    expect(result.candidates.map((candidate) => candidate.object_id))
      .toEqual(["weak-slice"]);
  });

  it("marks missing temporal quality unavailable", () => {
    const candidate = createCandidate("unbound");
    const params = fixture(candidate, createSupplementaryData({
      pathInflowAvailability: "unavailable"
    }));
    const bound = buildFineAssessmentSelectGammaBinding(
      params,
      createSelectionContext(params)
    ).candidates[0]!;

    expect(bound.quality_channels).toMatchObject({
      temporal: { status: "unavailable" }
    });
    expect(bound.authority_tie_break).toBe("unavailable");
  });

  it("does not reward unverified authority", () => {
    const base = createCandidate("unverified");
    const candidate = {
      ...base,
      entry: { ...base.entry, evidence_refs: ["evidence-unverified"] }
    };
    const params = fixture(candidate, createSupplementaryData());
    const bound = buildFineAssessmentSelectGammaBinding(
      params,
      createSelectionContext(params)
    ).candidates[0]!;

    expect(bound.authority_tie_break).toBe("unavailable");
    expect(Object.keys(bound.cover)).not.toContain("authority:unverified");
  });

  it("treats a sparse relevance map as authoritative for every candidate", () => {
    const queryMatchBase = createCandidate("query-match");
    const queryMatch = {
      ...queryMatchBase,
      fusion: { ...queryMatchBase.fusion, fused_score: 0.04 }
    };
    const stalePriorBase = createCandidate("stale-prior");
    const stalePrior = {
      ...stalePriorBase,
      fusion: { ...stalePriorBase.fusion, fused_score: 0.08 }
    };
    const supplementaryData = createSupplementaryData();
    const params = {
      ...fixture(queryMatch, supplementaryData),
      orderedCandidates: [stalePrior, queryMatch],
      coverageRelevanceByCandidateKey: new Map([
        [queryMatch.fusion.candidate_key, 0.002]
      ])
    };
    const bound = buildFineAssessmentSelectGammaBinding(
      params,
      createSelectionContext(params)
    );
    const qualityByKey = new Map(bound.candidates.map((candidate) => [
      candidate.candidate_key,
      candidate.quality
    ]));

    expect(qualityByKey.get(queryMatch.fusion.candidate_key)).toBeGreaterThan(
      qualityByKey.get(stalePrior.fusion.candidate_key) ?? Number.POSITIVE_INFINITY
    );
  });

  it("does not reward coverage features shared by the whole field", () => {
    const first = createCandidate("shared-first");
    const second = createCandidate("shared-second");
    const supplementaryData = createSupplementaryData();
    const params = {
      ...fixture(first, supplementaryData),
      orderedCandidates: [first, second]
    };
    const binding = buildFineAssessmentSelectGammaBinding(
      params,
      createSelectionContext(params)
    );
    const weightedFeatures = Object.keys(binding.feature_weights ?? {});

    expect(weightedFeatures).not.toContain(`scope:${first.entry.scope_class}`);
    expect(weightedFeatures).not.toContain(`dimension:${first.entry.dimension}`);
  });

  it("computes feature weights only from the risk-authority eligible universe", () => {
    const first = createCandidate("eligible-first");
    const second = createCandidate("eligible-second");
    const blockedBase = createCandidate("blocked");
    const blocked = {
      ...blockedBase,
      entry: { ...blockedBase.entry, scope_class: "global" as const }
    };
    const supplementaryData = createSupplementaryData({
      governanceCeilingByMemoryId: { blocked: "hidden" }
    });
    const params = {
      ...fixture(first, supplementaryData),
      orderedCandidates: [first, second, blocked]
    };
    const binding = buildFineAssessmentSelectGammaBinding(
      params,
      createSelectionContext(params)
    );

    expect(binding.feature_weights).not.toHaveProperty(
      `scope:${first.entry.scope_class}`
    );
    expect(binding.candidates.find(({ candidate_key }) =>
      candidate_key === blocked.fusion.candidate_key)?.eligibility.authority
    ).toBe("blocked");
  });

  it("binds live temporal risk and governance authority eligibility", () => {
    const candidate = createCandidate("blocked");
    const params = fixture(candidate, createSupplementaryData({
      governanceCeilingByMemoryId: { blocked: "hidden" }
    }));
    const context = createSelectionContext(params);
    const support: RecallCandidateAnswerSupport = {
      schema_version: 1,
      shape: "place",
      status: "unsupported",
      eligible: true,
      value_supported: false,
      target_supported: false,
      relation_supported: false,
      matched_target_terms: [],
      matched_relation_terms: [],
      authority: {
        schema_version: 1,
        provenance_status: "unverified",
        subject_status: "unknown",
        target_status: "missing",
        relation_status: "missing",
        event_status: "asserted",
        time_status: "conflicted",
        binding_status: "missing_or_ambiguous",
        behavior_eligible: false,
        evidence_ref: null
      }
    };
    const eligibility = deriveSelectGammaEligibility(candidate, {
      ...context,
      answerSupportByCandidateKey: new Map([
        [candidate.fusion.candidate_key, support]
      ])
    });

    expect(eligibility).toMatchObject({
      risk: "blocked",
      authority: "blocked"
    });
  });
});

function fixture(
  candidate: ReturnType<typeof createCandidate>,
  supplementaryData: ReturnType<typeof createSupplementaryData>
) {
  return {
    workspace_id: candidate.entry.workspace_id,
    orderedCandidates: [candidate],
    generation_id: `sha256:${"c".repeat(64)}`,
    condition_digest: `sha256:${"d".repeat(64)}`,
    config: createConfig(),
    supplementaryData,
    tokenEstimator: { estimate: () => 6 },
    rankByCandidateKey: new Map([[candidate.fusion.candidate_key, 1]])
  };
}

function tightBudget(maxEntries: number) {
  return {
    ...createConfig(),
    budgets: {
      ...createConfig().budgets,
      max_entries: maxEntries
    }
  };
}

function withFlood(
  candidate: ReturnType<typeof createCandidate>,
  axes: Readonly<{
    readonly slice?: boolean;
    readonly path?: boolean;
    readonly evidence?: boolean;
  }>
) {
  return {
    ...candidate,
    fusion: {
      ...candidate.fusion,
      flood_potential: floodAxes(axes)
    }
  };
}

function floodAxes(axes: Readonly<{
  readonly slice?: boolean;
  readonly path?: boolean;
  readonly evidence?: boolean;
}>): IntegratedFloodCandidateDiagnostics {
  return {
    R_obj: 0,
    Slice: axes.slice === true ? 1 : 0,
    A_path: axes.path === true ? 1 : 0,
    B_evidence: axes.evidence === true ? 1 : 0,
    E_direct: 0,
    omega: 1,
    Flood: 0,
    lambda: 0.6,
    beta: 1,
    final_score: 0,
    slice_status: axes.slice === true ? "active" : "inactive:no_slice_match",
    path_status: axes.path === true ? "active" : "inactive:pass_through",
    evidence_status: axes.evidence === true ? "active" : "inactive:no_evidence",
    e_direct_status: "inactive:not_applicable",
    fuel_verified: axes.slice === true || axes.path === true || axes.evidence === true
  };
}

function observedOpenSemanticActivation() {
  return {
    schema_version: 1 as const,
    operator_id: OPEN_SEMANTIC_FACTOR_CANDIDATE_ACTIVATION_OPERATOR_ID,
    state: "observed" as const,
    score: 1,
    evidence_ids: Object.freeze(["evidence-1"]),
    solution_count: 1,
    proposition_match_count: 1,
    receipt_digest: `sha256:${"e".repeat(64)}` as const
  };
}

function pathInflow(targetObjectId: string, weight: number) {
  return {
    pathId: `path-${targetObjectId}`,
    relationKind: "answers_with",
    seedObjectId: "seed-1",
    targetObjectId,
    seedAnchor: { kind: "object" as const, object_id: "seed-1" },
    targetAnchor: { kind: "object" as const, object_id: targetObjectId },
    pathSourceVersion: "v1",
    weight
  };
}
