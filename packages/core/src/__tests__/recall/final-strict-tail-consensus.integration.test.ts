import { createHash } from "node:crypto";
import { MemoryDimension } from "@do-soul/alaya-protocol";
import { describe, expect, it } from "vitest";
import {
  selectFineAssessmentCandidates,
  type FineAssessmentCandidate
} from "../../recall/delivery/fine-assessment-selection.js";
import {
  replayFineAssessmentSelectionBoundary,
  type FineAssessmentSelectionBoundaryCase
} from "../../recall/delivery/selection-boundary/selection-boundary-replay.js";
import {
  materializeFineAssessmentSelectionBoundary,
  type FineAssessmentSelectionBoundaryPendingCapture
} from "../../recall/delivery/selection-boundary/selection-boundary-capture.js";
import { selectionBoundaryJsonSha256 } from
  "../../recall/delivery/selection-boundary/selection-boundary-json.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import {
  projectVerifiedUserAssertionContext
} from "../../recall/query/recall-user-assertion-context.js";
import type { RecallSupplementaryData } from
  "../../recall/runtime/recall-service-types.js";
import {
  createCandidate,
  createConfig,
  createSupplementaryData,
  rankMap
} from "./fine-assessment-selection-fixtures.js";

describe("final strict-tail consensus integration", () => {
  it("uses reciprocal consensus as final authority while preserving the strict tail", () => {
    const candidates = consensusCandidates();
    const result = select(candidates, {
      capturePacketPlanTrace: true,
      tokenByObjectId: { "baseline-03": 3, challenger: 7 }
    });

    expect(packetIds(result)).toEqual([
      "baseline-01",
      "challenger",
      "baseline-02",
      "baseline-05",
      "baseline-04",
      "baseline-06",
      "baseline-07",
      "baseline-08",
      "baseline-09",
      "baseline-10"
    ]);
    expect(packetIds(result).slice(5)).toEqual([
      "baseline-06",
      "baseline-07",
      "baseline-08",
      "baseline-09",
      "baseline-10"
    ]);
    expect(result.candidates[5]?.budget_state).toEqual({
      token_estimate: 5,
      max_entries: 10,
      max_total_tokens: 100,
      remaining_entries: 4,
      remaining_tokens: 68,
      within_budget: true
    });
    expect(finalDiagnosticRanks(result)).toEqual([
      ["baseline-01", 1],
      ["challenger", 2],
      ["baseline-02", 3],
      ["baseline-05", 4],
      ["baseline-04", 5],
      ["baseline-06", 6],
      ["baseline-07", 7],
      ["baseline-08", 8],
      ["baseline-09", 9],
      ["baseline-10", 10]
    ]);
    expect(result.diagnostics.find(
      (row) => row.object_id === "challenger"
    )).toMatchObject({
      pre_budget_rank: 11,
      selection_order: 11,
      rank_after_coverage_selector: 11,
      final_rank: 2
    });
    expect(result.diagnostics.find(
      (row) => row.object_id === "baseline-03"
    )).toMatchObject({
      pre_budget_rank: 3,
      selection_order: 3,
      rank_after_coverage_selector: 3,
      final_rank: null,
      dropped_reason: "max_entries"
    });
    expect(result.packetPlanObservation?.decision).toEqual({
      status: "accepted",
      reason: "strict_tail_consensus"
    });
    expect(result.packetPlanObservation?.actual_candidate_keys).toEqual(
      result.packetPlanObservation?.planned_candidate_keys
    );
  });
  it("is byte-exact when no candidate has a finite raw embedding rank", () => {
    const result = select(baselineCandidates());
    expect(exactResultDigest(result)).toBe(
      "a7dad0b4e5c3b47d1c925fe94ba193368cc5764a60bbe26c9e7e1281dbd9cef5"
    );
    expect(packetIds(result)).toEqual(baselineIds());
  });

  it("fully aborts when a delivered baseline incumbent is behavior eligible", () => {
    const content = "I bought my new bookshelf from IKEA.";
    const evidenceRef = "evidence-bookshelf";
    const eligible = createCandidate("baseline-03", {
      content,
      evidence_refs: [evidenceRef]
    });
    const candidates = consensusCandidates({ "baseline-03": eligible });
    const verified = projectVerifiedUserAssertionContext({
      evidenceRef,
      entryContent: content,
      gist: `User: ${content}`
    });
    if (verified === null) throw new Error("test fixture must project");
    const result = select(candidates, {
      captureAnswerFeatures: true,
      queryText: "Where did I buy my new bookshelf from?",
      verifiedUserAssertionContextsByMemoryId: { "baseline-03": verified }
    });
    const incumbent = result.diagnostics.find((row) => row.object_id === "baseline-03");

    expect(incumbent?.answer_features?.answer_support?.authority.behavior_eligible).toBe(true);
    expect(exactResultDigest(result)).toBe(
      "15e33cfaff09840ce19d4f5344a905e6e2f6f0ea40a5d90db1c228226c9f24bd"
    );
  });

  it("retains direct-evidence protection within its rank limit", () => {
    const evidenceFixture = createCandidate(
      "baseline-03",
      {
        content: "I bought my new bookshelf from IKEA.",
        evidence_refs: ["evidence-bookshelf"]
      },
      "evidence_capsule"
    );
    const evidenceBase = {
      ...evidenceFixture,
      fusion: {
        ...evidenceFixture.fusion,
        candidate_key: "workspace_local:evidence_capsule:baseline-03",
        object_kind: "evidence_capsule" as const
      }
    };
    const protectedEvidence = withStreamRanks(evidenceBase, {
      evidence_fts: 1
    });
    const candidates = consensusCandidates({ "baseline-03": protectedEvidence });

    const result = select(candidates, {
      capturePacketPlanTrace: true,
      queryText: "Where did I buy my new bookshelf from?",
      evidenceSemanticScoresByCandidateKey: new Map([
        [protectedEvidence.fusion.candidate_key, 0.9]
      ])
    });
    const finalRank = packetIds(result).indexOf("baseline-03") + 1;

    expect(finalRank).toBeGreaterThan(0);
    expect(finalRank).toBeLessThanOrEqual(5);
    expect(packetIds(result)).toContain("challenger");
    expect(result.packetPlanObservation?.decision).toEqual({
      status: "accepted",
      reason: "strict_tail_consensus"
    });
  });

  it.each([
    {
      name: "token",
      candidates: consensusCandidates(),
      overrides: {
        maxTotalTokens: 50,
        tokenByObjectId: { challenger: 51 }
      },
      expectedDigest: "451d717f2b34a44f784e054354c55f9119191a5dfc46d3c0e965d8006e97f914"
    },
    {
      name: "dimension",
      candidates: consensusCandidates({
        "baseline-01": createCandidate("baseline-01", {
          dimension: MemoryDimension.FACT
        }),
        challenger: createCandidate("challenger", {
          dimension: MemoryDimension.FACT
        })
      }),
      overrides: {
        perDimensionLimits: { [MemoryDimension.FACT]: 1 }
      },
      expectedDigest: "b5e2c24d4ff6bb5bcf1f35183351813c454d36df0ba81dafa3ebd59f8406d2c2"
    },
    {
      name: "duplicate",
      candidates: consensusCandidates({
        challenger: {
          ...createCandidate("baseline-01"),
          originPlane: "global",
          fusion: {
            ...createCandidate("baseline-01").fusion,
            candidate_key: "global:memory_entry:baseline-01"
          }
        }
      }),
      overrides: {},
      expectedDigest: "ccb53ed4bc600e8cca6ebcb0ebe3234eed3fc66cc3cc22e62bea6aa35efadd10"
    }
  ])("fails open to the exact baseline on $name infeasibility", ({
    candidates,
    overrides,
    expectedDigest
  }) => {
    const result = select(candidates, overrides);

    expect(exactResultDigest(result)).toBe(expectedDigest);
  });

  it.each([
    {
      name: "coverage without an embedding head reaches no-op consensus",
      candidates: baselineCandidates(),
      overrides: {
        finalOrderAfterCoverage: "coverage" as const
      },
      expectedConsensusStatus: "no_op"
    },
    {
      name: "public relevance with an embedding head accepts consensus",
      candidates: consensusCandidates(),
      overrides: {
        finalOrderAfterCoverage: "public_relevance" as const
      },
      expectedConsensusStatus: "accepted"
    },
    {
      name: "public relevance preserves a rejected infeasible consensus",
      candidates: consensusCandidates(),
      overrides: {
        finalOrderAfterCoverage: "public_relevance" as const,
        maxTotalTokens: 50,
        tokenByObjectId: { challenger: 51 }
      },
      expectedConsensusStatus: "rejected"
    }
  ])("captures and exactly replays $name", ({
    candidates,
    overrides,
    expectedConsensusStatus
  }) => {
    let boundary: FineAssessmentSelectionBoundaryCase | undefined;
    const baseline = select(candidates, {
      ...overrides,
      capturePacketPlanTrace: true
    });
    const observed = select(candidates, {
      ...overrides,
      capturePacketPlanTrace: true,
      selectionBoundaryObserver: (captured) => {
        boundary = materializeFineAssessmentSelectionBoundary(captured);
      }
    });
    expect(exactResultDigest(observed)).toBe(exactResultDigest(baseline));
    expect(boundary).toBeDefined();
    expect(() => JSON.stringify(boundary)).not.toThrow();
    expect(observed.packetPlanObservation?.decision.status)
      .toBe(expectedConsensusStatus);
    if (expectedConsensusStatus === "accepted") {
      expect(boundary!.expected.pre_projection?.candidate_keys.map(
        (key) => key.split(":").at(-1)
      )).toEqual(baselineIds());
    }
    expect(boundary).toMatchObject({
      schema_version: 2,
      expected: {
        candidate_keys: observed.packetPlanObservation?.actual_candidate_keys,
        drop_tuples: observed.diagnostics.map((diagnostic) => [
          diagnostic.candidate_key,
          diagnostic.dropped_reason
        ]),
        token_totals: {
          delivered: observed.candidates.reduce(
            (total, candidate) => total + candidate.token_estimate,
            0
          )
        },
        packet_consensus: observed.packetPlanObservation
      }
    });
    expect(boundary!.expected.visible_result_sha256)
      .toBe(selectionBoundaryJsonSha256(observed));
    expect(boundary!.expected).not.toHaveProperty("visible_result");
    const serialized = JSON.parse(JSON.stringify(boundary)) as
      FineAssessmentSelectionBoundaryCase;
    const replayed = replayFineAssessmentSelectionBoundary(serialized);
    expect(exactResultDigest(replayed)).toBe(exactResultDigest(observed));
  });

  it("fails fidelity when serialized input or expected output is tampered", () => {
    let boundary: FineAssessmentSelectionBoundaryCase | undefined;
    select(consensusCandidates(), {
      capturePacketPlanTrace: true,
      finalOrderAfterCoverage: "public_relevance",
      selectionBoundaryObserver: (captured) => {
        boundary = materializeFineAssessmentSelectionBoundary(captured);
      }
    });
    if (boundary === undefined) throw new Error("selection boundary was not observed");
    const inputTamper: FineAssessmentSelectionBoundaryCase = {
      ...boundary,
      input: {
        ...boundary.input,
        config: {
          ...boundary.input.config,
          budgets: {
            ...boundary.input.config.budgets,
            max_entries: 1
          }
        }
      }
    };
    const outputTamper: FineAssessmentSelectionBoundaryCase = {
      ...boundary,
      expected: {
        ...boundary.expected,
        candidate_keys: [...boundary.expected.candidate_keys].reverse()
      }
    };

    expect(() => replayFineAssessmentSelectionBoundary(inputTamper))
      .toThrow(/selection boundary fidelity mismatch/u);
    expect(() => replayFineAssessmentSelectionBoundary(outputTamper))
      .toThrow(/selection boundary fidelity mismatch/u);
  });
});

type SelectionResult = ReturnType<typeof selectFineAssessmentCandidates>;

type SelectionOverrides = Readonly<{
  readonly captureAnswerFeatures?: boolean;
  readonly capturePacketPlanTrace?: boolean;
  readonly evidenceSemanticScoresByCandidateKey?: ReadonlyMap<string, number>;
  readonly finalOrderAfterCoverage?: "coverage" | "public_relevance" | "delivery_rank";
  readonly maxTotalTokens?: number;
  readonly perDimensionLimits?: Readonly<Record<string, number>>;
  readonly queryText?: string;
  readonly selectionBoundaryObserver?: (
    boundary: FineAssessmentSelectionBoundaryPendingCapture
  ) => undefined;
  readonly tokenByObjectId?: Readonly<Record<string, number>>;
  readonly verifiedUserAssertionContextsByMemoryId?:
    RecallSupplementaryData["verifiedUserAssertionContextsByMemoryId"];
}>;

function select(
  candidates: readonly FineAssessmentCandidate[],
  overrides: SelectionOverrides = {}
): SelectionResult {
  const config = createConfig();
  return selectFineAssessmentCandidates({
    orderedCandidates: candidates,
    config: {
      ...config,
      budgets: {
        ...config.budgets,
        max_total_tokens: overrides.maxTotalTokens ?? config.budgets.max_total_tokens,
        per_dimension_limits: overrides.perDimensionLimits ?? null
      }
    },
    supplementaryData: createSupplementaryData({
      queryProbes: compileRecallQueryProbes(overrides.queryText ?? null),
      embeddingSimilarityScores: Object.fromEntries(
        candidates.map((candidate) => [
          candidate.entry.object_id,
          candidate.entry.object_id === "challenger" ? 0.1 : 0.9
        ])
      ),
      evidenceSemanticScoresByCandidateKey:
        overrides.evidenceSemanticScoresByCandidateKey ?? new Map(),
      ...(overrides.verifiedUserAssertionContextsByMemoryId === undefined
        ? {}
        : {
            verifiedUserAssertionContextsByMemoryId:
              overrides.verifiedUserAssertionContextsByMemoryId
          })
    }),
    tokenEstimator: {
      estimate: (content) => {
        const objectId = /Recall content for ([^.]+)\./u.exec(content)?.[1];
        return objectId === undefined
          ? 5
          : overrides.tokenByObjectId?.[objectId] ?? 5;
      }
    },
    rankByCandidateKey: rankMap(candidates),
    finalRelevanceByCandidateKey: relevanceMap(candidates),
    coverageRelevanceByCandidateKey: relevanceMap(candidates),
    finalOrderAfterCoverage: overrides.finalOrderAfterCoverage ?? "delivery_rank",
    captureAnswerFeatures: overrides.captureAnswerFeatures,
    capturePacketPlanTrace: overrides.capturePacketPlanTrace,
    selectionBoundaryObserver: overrides.selectionBoundaryObserver
  });
}

function baselineCandidates(): readonly FineAssessmentCandidate[] {
  return baselineIds().map((objectId, index) =>
    ranked(createCandidate(objectId), index + 1, 1 - index * 0.01)
  );
}

function consensusCandidates(
  replacements: Readonly<Record<string, FineAssessmentCandidate>> = {}
): readonly FineAssessmentCandidate[] {
  const candidates = baselineCandidates().map((candidate) =>
    replacements[candidate.entry.object_id] ?? candidate
  );
  const challenger = replacements.challenger ?? createCandidate("challenger");
  return [
    withEmbeddingRank(candidates[0]!, 4),
    withEmbeddingRank(candidates[1]!, 3),
    candidates[2]!,
    withEmbeddingRank(candidates[3]!, 5),
    withEmbeddingRank(candidates[4]!, 2),
    ...candidates.slice(5),
    withEmbeddingRank(ranked(challenger, 11, 0.4), 1)
  ];
}

function ranked(
  candidate: FineAssessmentCandidate,
  fusedRank: number,
  fusedScore: number
): FineAssessmentCandidate {
  return {
    ...candidate,
    fusion: { ...candidate.fusion, fused_rank: fusedRank, fused_score: fusedScore }
  };
}

function withEmbeddingRank(
  candidate: FineAssessmentCandidate,
  rank: number
): FineAssessmentCandidate {
  return withStreamRanks(candidate, { embedding_similarity: rank });
}

function withStreamRanks(
  candidate: FineAssessmentCandidate,
  ranks: Partial<FineAssessmentCandidate["fusion"]["per_stream_rank"]>
): FineAssessmentCandidate {
  return {
    ...candidate,
    fusion: {
      ...candidate.fusion,
      per_stream_rank: { ...candidate.fusion.per_stream_rank, ...ranks }
    }
  };
}

function relevanceMap(
  candidates: readonly FineAssessmentCandidate[]
): ReadonlyMap<string, number> {
  return new Map(candidates.map((candidate) => [
    candidate.fusion.candidate_key,
    candidate.fusion.fused_score
  ]));
}

function baselineIds(): readonly string[] {
  return Array.from({ length: 10 }, (_, index) =>
    `baseline-${String(index + 1).padStart(2, "0")}`
  );
}

function packetIds(result: SelectionResult): readonly string[] {
  return result.candidates.map((candidate) => candidate.object_id);
}

function finalDiagnosticRanks(result: SelectionResult): readonly (readonly [string, number])[] {
  return result.diagnostics
    .filter((row): row is typeof row & { readonly final_rank: number } =>
      row.final_rank !== null
    )
    .sort((left, right) => left.final_rank - right.final_rank)
    .map((row) => [row.object_id, row.final_rank]);
}

function exactResultDigest(result: SelectionResult): string {
  return createHash("sha256").update(JSON.stringify(result)).digest("hex");
}
