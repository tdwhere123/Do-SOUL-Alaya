import { describe, expect, it } from "vitest";
import { buildQuestionDiagnostic } from "../../../longmemeval/diagnostics.js";
import { readRecallDiagnostics } from "../../../longmemeval/diagnostics/schema/diagnostics-private.js";
import { LongMemEvalQuestionDiagnosticSchema } from "../../../longmemeval/diagnostics/schema/diagnostics-schema.js";
import { compareCandidateManifestations } from "../../../longmemeval/diagnostics/candidate-manifestation-order.js";
import { verifyPromotionCandidatePoolClosure } from "../../../longmemeval/promotion/verifiers/candidate-pool-verifier.js";
import { verifyPromotionGoldEvidence } from "../../../longmemeval/promotion/verifiers/gold-verifier.js";

describe("fine-assessment pruned evidence", () => {
  it("defines a deterministic total manifestation order", () => {
    const manifestations = [
      manifestation(null, 1, "global", "z"),
      manifestation(2, 1, "workspace_local", "z"),
      manifestation(1, 9, "global", "z"),
      manifestation(1, 2, "global", "b"),
      manifestation(1, 2, "global", "a"),
      manifestation(1, 2, "workspace_local", "z")
    ];
    const expected = [
      "1:2:workspace_local:z", "1:2:global:a", "1:2:global:b",
      "1:9:global:z", "2:1:workspace_local:z", "null:1:global:z"
    ];
    const order = (input: typeof manifestations) => [...input]
      .sort(compareCandidateManifestations)
      .map((item) => [
        item.finalRank ?? "null",
        item.fusedRank ?? "null",
        item.originPlane,
        item.candidateKey
      ].join(":"));

    expect(order(manifestations)).toEqual(expected);
    expect(order([...manifestations].reverse())).toEqual(expected);
  });

  it("fails closure when pruned evidence is absent and closes it when present", () => {
    const missing = recallResult({ candidates: [scoredCandidate("survivor")] });
    const complete = recallResult({
      candidates: [scoredCandidate("survivor")],
      fine_assessment_pruned_candidates: []
    });

    expect(readRecallDiagnostics(missing, "disabled")?.candidatePoolComplete).toBe(false);
    expect(readRecallDiagnostics(complete, "disabled")?.candidatePoolComplete).toBe(true);
  });

  it("rejects false counts, duplicate keys, and survivor/pruned overlap", () => {
    const base = prunedCandidate("pruned", 1);
    const cases = [
      recallResult({
        candidate_pool_count: 99,
        candidates: [scoredCandidate("survivor")],
        fine_assessment_pruned_candidates: [base]
      }),
      recallResult({
        candidates: [scoredCandidate("survivor")],
        fine_pruned_count: 2,
        fine_assessment_pruned_candidates: [base]
      }),
      recallResult({
        candidate_pool_count: 3,
        fine_pruned_count: 2,
        candidates: [scoredCandidate("survivor")],
        fine_assessment_pruned_candidates: [base, base]
      }),
      recallResult({
        candidate_pool_count: 2,
        candidates: [scoredCandidate("survivor")],
        fine_assessment_pruned_candidates: [prunedCandidate("survivor", 1)]
      }),
      recallResult({
        candidates: [{
          ...scoredCandidate("survivor"),
          candidate_key: "workspace_local:memory_entry:other"
        }],
        fine_assessment_pruned_candidates: []
      })
    ];

    expect(cases.map((value) =>
      readRecallDiagnostics(value, "disabled")?.candidatePoolComplete
    )).toEqual([false, false, false, false, false]);
  });

  it("preserves same-id different-kind rows without identity collision", () => {
    const result = recallResult({
      candidate_pool_count: 2,
      candidates: [scoredCandidate("shared")],
      fine_assessment_pruned_candidates: [
        prunedCandidate("shared", 1, "synthesis_capsule")
      ]
    });
    const diagnostics = readRecallDiagnostics(result, "disabled");

    expect(diagnostics?.candidatePoolComplete).toBe(true);
    expect(diagnostics?.fineAssessmentPrunedCandidates).toEqual([
      expect.objectContaining({
        candidate_key: "workspace_local:synthesis_capsule:shared",
        object_kind: "synthesis_capsule",
        object_id: "shared"
      })
    ]);
  });

  it("rejects forged, swapped, and non-product origin-plane prefixes", () => {
    const forgedScored = {
      ...scoredCandidate("scored"),
      candidate_key: "global:memory_entry:scored"
    };
    const forgedPruned = {
      ...prunedCandidate("pruned", 1),
      candidate_key: "global:memory_entry:pruned"
    };
    const unknownPlane = {
      ...scoredCandidate("unknown"),
      origin_plane: "remote",
      candidate_key: "remote:memory_entry:unknown"
    };
    const { object_kind: _objectKind, ...missingKind } = scoredCandidate("missing-kind");
    const { object_id: _memoryObjectId, ...memoryIdOnlyBase } = scoredCandidate("memory-alias");
    const memoryIdOnly = {
      ...memoryIdOnlyBase,
      memory_id: "memory-alias"
    };
    const { object_id: _idObjectId, ...idOnlyBase } = scoredCandidate("id-alias");
    const idOnly = {
      ...idOnlyBase,
      id: "id-alias"
    };
    const cases = [
      recallResult({ candidates: [forgedScored], fine_assessment_pruned_candidates: [] }),
      recallResult({
        candidate_pool_count: 2,
        candidates: [scoredCandidate("survivor")],
        fine_assessment_pruned_candidates: [forgedPruned]
      }),
      recallResult({ candidates: [unknownPlane], fine_assessment_pruned_candidates: [] }),
      recallResult({ candidates: [missingKind], fine_assessment_pruned_candidates: [] }),
      recallResult({ candidates: [memoryIdOnly], fine_assessment_pruned_candidates: [] }),
      recallResult({ candidates: [idOnly], fine_assessment_pruned_candidates: [] })
    ];

    expect(cases.map((value) =>
      readRecallDiagnostics(value, "disabled")?.candidatePoolComplete
    )).toEqual([false, false, false, false, false, false]);
  });

  it("rejects same-plane duplicates while preserving cross-plane logical aliases", () => {
    const local = scoredCandidate("shared");
    const global = scoredCandidate("shared", null, "global");
    const duplicate = recallResult({
      candidate_pool_count: 2,
      candidates: [local, local],
      fine_assessment_pruned_candidates: []
    });
    const aliases = recallResult({
      candidate_pool_count: 2,
      candidates: [local, global],
      fine_assessment_pruned_candidates: []
    });

    expect(readRecallDiagnostics(duplicate, "disabled")?.candidatePoolComplete).toBe(false);
    expect(readRecallDiagnostics(aliases, "disabled")?.candidatePoolComplete).toBe(true);
  });

  it("closes all-pruned and scored-plus-pruned cross-plane alias groups", () => {
    const allPruned = recallResult({
      candidate_pool_count: 2,
      fine_pruned_count: 2,
      candidates: [],
      fine_assessment_pruned_candidates: [
        prunedCandidate("shared", 0),
        prunedCandidate("shared", 1, "memory_entry", "global")
      ]
    });
    const mixed = recallResult({
      candidate_pool_count: 2,
      fine_pruned_count: 1,
      candidates: [scoredCandidate("shared")],
      fine_assessment_pruned_candidates: [
        prunedCandidate("shared", 1, "memory_entry", "global")
      ]
    });

    expect(readRecallDiagnostics(allPruned, "disabled")?.candidatePoolComplete).toBe(true);
    expect(readRecallDiagnostics(mixed, "disabled")?.candidatePoolComplete).toBe(true);
  });

  it("gives a scored manifestation priority over a pruned logical alias", () => {
    const row = buildQuestionDiagnostic(questionInput(recallResult({
      candidate_pool_count: 2,
      fine_pruned_count: 1,
      candidates: [scoredCandidate("gold-a")],
      fine_assessment_pruned_candidates: [
        prunedCandidate("gold-a", 1, "memory_entry", "global")
      ]
    })));

    expect(row).toMatchObject({
      candidate_pool_complete: true,
      miss_taxonomy: "delivery_order_drop",
      gold: [{
        candidate_status: "candidate_not_delivered",
        miss_taxonomy: "delivery_order_drop"
      }]
    });
    expect(row.gold[0]?.miss_taxonomy).not.toBe("fine_assessment_drop");
    expect(() => verifyPromotionGoldEvidence({
      question: row,
      expectedGold: ["gold-a"],
      scorable: true
    })).not.toThrow();
  });

  it("promotes all-scored and all-pruned cross-plane alias groups independently", () => {
    const allScored = buildQuestionDiagnostic(questionInput(recallResult({
      candidate_pool_count: 2,
      candidates: [
        scoredCandidate("gold-a"),
        scoredCandidate("gold-a", null, "global")
      ],
      fine_assessment_pruned_candidates: []
    })));
    const allPruned = buildQuestionDiagnostic(questionInput(recallResult({
      candidate_pool_count: 2,
      fine_pruned_count: 2,
      candidates: [],
      fine_assessment_pruned_candidates: [
        prunedCandidate("gold-a", 0),
        prunedCandidate("gold-a", 1, "memory_entry", "global")
      ]
    })));

    for (const question of [allScored, allPruned]) {
      expect(() => verifyPromotionGoldEvidence({
        question,
        expectedGold: ["gold-a"],
        scorable: true
      })).not.toThrow();
    }
  });

  it.each([false, true])(
    "selects a delivered global manifestation independently of input order (reverse=%s)",
    (reverse) => {
      const local = scoredCandidate("gold-a");
      const global = scoredCandidate("gold-a", 1, "global");
      const candidates = reverse ? [global, local] : [local, global];
      const recall = recallResult({
        candidate_pool_count: 2,
        candidates,
        fine_assessment_pruned_candidates: []
      });
      const live = readRecallDiagnostics(recall, "disabled");
      const row = buildQuestionDiagnostic({
        ...questionInput(recall),
        deliveredResults: [{ object_id: "gold-a", rank: 1, relevance_score: 1 }],
        hitAt1: true,
        hitAt5: true,
        hitAt10: true
      });

      expect(live?.candidatesByObjectIdentity.get("memory_entry:gold-a")?.candidateKey)
        .toBe("global:memory_entry:gold-a");
      expect(() => verifyPromotionGoldEvidence({
        question: row,
        expectedGold: ["gold-a"],
        scorable: true
      })).not.toThrow();
    }
  );

  it.each([false, true])(
    "uses the fixed local-plane tie-break independently of input order (reverse=%s)",
    (reverse) => {
      const local = scoredCandidate("gold-a");
      const global = scoredCandidate("gold-a", null, "global");
      const candidates = reverse ? [global, local] : [local, global];
      const recall = recallResult({
        candidate_pool_count: 2,
        candidates,
        fine_assessment_pruned_candidates: []
      });
      const live = readRecallDiagnostics(recall, "disabled");
      const row = buildQuestionDiagnostic(questionInput(recall));
      const promoted = verifyPromotionCandidatePoolClosure(row);

      expect(live?.candidatesByObjectIdentity.get("memory_entry:gold-a")?.candidateKey)
        .toBe("workspace_local:memory_entry:gold-a");
      expect(promoted.scoredByIdentity.get("memory_entry:gold-a")?.candidate_key)
        .toBe("workspace_local:memory_entry:gold-a");
    }
  );

  it("independently rejects a forged promotion candidate prefix", () => {
    const valid = buildQuestionDiagnostic(questionInput(recallResult({
      candidates: [scoredCandidate("gold-a")],
      fine_assessment_pruned_candidates: []
    })));
    const forged = structuredClone(valid);
    Object.assign(forged.candidates[0]!, {
      candidate_key: "global:memory_entry:gold-a"
    });

    expect(() => verifyPromotionGoldEvidence({
      question: forged,
      expectedGold: ["gold-a"],
      scorable: true
    })).toThrow(/candidate pool closure/u);
  });

  it("classifies exact gold identity pruned at the fine waist", () => {
    const row = buildQuestionDiagnostic(questionInput(recallResult({
      candidate_pool_count: 1,
      fine_pruned_count: 1,
      candidates: [],
      fine_assessment_pruned_candidates: [prunedCandidate("gold-a", 0)]
    })));

    expect(row).toMatchObject({
      candidate_pool_complete: true,
      candidate_pool_count: 1,
      fine_pruned_count: 1,
      fine_assessment_pruned_candidates: [
        { object_kind: "memory_entry", object_id: "gold-a" }
      ],
      miss_taxonomy: "fine_assessment_drop",
      gold: [{
        candidate_status: "candidate_not_delivered",
        miss_taxonomy: "fine_assessment_drop"
      }]
    });
    expect(LongMemEvalQuestionDiagnosticSchema.parse(row)).toEqual(row);
  });

  it("independently rejects a forged complete closure during promotion", () => {
    const valid = buildQuestionDiagnostic({
      ...questionInput(recallResult({
        candidates: [scoredCandidate("gold-a", 1)],
        fine_assessment_pruned_candidates: []
      })),
      deliveredResults: [{ object_id: "gold-a", rank: 1, relevance_score: 1 }],
      hitAt1: true,
      hitAt5: true,
      hitAt10: true
    });
    expect(verifyPromotionGoldEvidence({
      question: valid,
      expectedGold: ["gold-a"],
      scorable: true
    })).toEqual({ hitAt1: true, hitAt5: true, hitAt10: true });

    const forged = LongMemEvalQuestionDiagnosticSchema.parse({
      ...valid,
      candidate_pool_count: 2,
      candidate_pool_complete: true,
      cohort_ledger: { ...valid.cohort_ledger!, candidate_pool_complete: true }
    });
    expect(() => verifyPromotionGoldEvidence({
      question: forged,
      expectedGold: ["gold-a"],
      scorable: true
    })).toThrow(/candidate pool closure/u);
  });
});

function questionInput(recall: unknown) {
  return {
    questionId: "q-fine-pruned",
    goldMemoryIds: ["gold-a"],
    answerSessionIds: ["session-a"],
    deliveredResults: [],
    hitAt1: false,
    hitAt5: false,
    hitAt10: false,
    degradationReason: null,
    embeddingMode: "disabled" as const,
    recallResult: recall
  };
}

function recallResult(overrides: Readonly<Record<string, unknown>>) {
  const candidatePoolCount = typeof overrides.candidate_pool_count === "number"
    ? overrides.candidate_pool_count
    : Array.isArray(overrides.candidates) ? overrides.candidates.length : 1;
  const finePrunedCount = typeof overrides.fine_pruned_count === "number"
    ? overrides.fine_pruned_count
    : Array.isArray(overrides.fine_assessment_pruned_candidates)
      ? overrides.fine_assessment_pruned_candidates.length
      : 0;
  return {
    diagnostics: {
      candidate_pool_count: candidatePoolCount,
      token_economy: {
        coarse_pool_size: candidatePoolCount,
        fine_evaluated: candidatePoolCount - finePrunedCount,
        fine_pruned_count: finePrunedCount
      },
      ...overrides
    }
  };
}

function scoredCandidate(
  objectId: string,
  finalRank: number | null = null,
  originPlane: "workspace_local" | "global" = "workspace_local"
) {
  return {
    candidate_key: `${originPlane}:memory_entry:${objectId}`,
    object_kind: "memory_entry",
    object_id: objectId,
    origin_plane: originPlane,
    created_at: "2026-07-17T00:00:00.000Z",
    facet_overlap: 0,
    pre_budget_rank: 1,
    selection_order: 1,
    fused_rank: 1,
    fused_score: 1,
    final_rank: finalRank,
    per_stream_rank: { lexical_fts: 1 },
    fused_rank_contribution_per_stream: { lexical_fts: 1 },
    score_factors: { activation: 1 }
  };
}

function manifestation(
  finalRank: number | null,
  fusedRank: number | null,
  originPlane: "workspace_local" | "global",
  candidateKey: string
) {
  return { finalRank, fusedRank, originPlane, candidateKey };
}

function prunedCandidate(
  objectId: string,
  coarseIndex: number,
  objectKind: "memory_entry" | "synthesis_capsule" = "memory_entry",
  originPlane: "workspace_local" | "global" = "workspace_local"
) {
  return {
    candidate_key: `${originPlane}:${objectKind}:${objectId}`,
    origin_plane: originPlane,
    object_kind: objectKind,
    object_id: objectId,
    coarse_index: coarseIndex,
    drop_reason: "fine_assessment_cap"
  };
}
