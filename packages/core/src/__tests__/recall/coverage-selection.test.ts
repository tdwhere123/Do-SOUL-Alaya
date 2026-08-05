import { describe, expect, it, vi } from "vitest";
import {
  MemoryDimension,
  ScopeClass,
  type MemoryEntry,
  type RecallScoreFactors
} from "@do-soul/alaya-protocol";
import {
  orderByCoverageMarginalGain,
  resolveCoverageIdentity,
  type CoverageMarginalObservation,
  type CoverageSelectionObjective
} from "../../recall/delivery/coverage-selection.js";
import type { CandidateCoverageReceipt } from
  "../../recall/delivery/fine-assessment-selection/coverage-atoms.js";
import {
  selectFineAssessmentCandidates,
  type FineAssessmentCandidate
} from "../../recall/delivery/fine-assessment-selection.js";
import { buildEmptyRecallFusionBreakdown } from "../../recall/delivery/fusion-delivery-scoring.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import type { RecallSupplementaryData } from "../../recall/runtime/recall-service-types.js";
import { evidenceSemanticActivation } from
  "./fixtures/evidence-semantic-activation.js";

describe("coverage-aware delivery", () => {
  it("orders a new-gist item ahead of a higher-rank duplicate-gist item", () => {
    const sharedGistFirst = createCandidate("dup-1", 0.99);
    const sharedGistSecond = createCandidate("dup-2", 0.98);
    const novel = createCandidate("novel", 0.5);
    const ordered = orderByCoverageMarginalGain({
      candidates: [sharedGistFirst, sharedGistSecond, novel],
      relevanceByCandidateKey: new Map([
        [sharedGistFirst.fusion.candidate_key, 0.99],
        [sharedGistSecond.fusion.candidate_key, 0.98],
        [novel.fusion.candidate_key, 0.5]
      ]),
      supplementaryData: createSupplementaryData({
        evidenceGistsByMemoryId: {
          "dup-1": "same-gist",
          "dup-2": "same-gist",
          novel: "fresh-gist"
        }
      })
    });

    expect(ordered.map((candidate) => candidate.entry.object_id)).toEqual([
      "dup-1",
      "novel",
      "dup-2"
    ]);
  });

  it("observes the live marginal gain without changing coverage order", () => {
    const sharedGistFirst = createCandidate("dup-1", 0.99);
    const sharedGistSecond = createCandidate("dup-2", 0.98);
    const novel = createCandidate("novel", 0.5);
    const candidates = [sharedGistFirst, sharedGistSecond, novel];
    const relevanceByCandidateKey = relevanceMap(candidates);
    const supplementaryData = createSupplementaryData({
      evidenceGistsByMemoryId: {
        "dup-1": "same-gist",
        "dup-2": "same-gist",
        novel: "fresh-gist"
      }
    });
    const observations: Array<Readonly<{
      candidate_key: string;
      marginal_gain: number;
      selection_order: number;
    }>> = [];
    const withoutTrace = orderByCoverageMarginalGain({
      candidates,
      relevanceByCandidateKey,
      supplementaryData
    });
    const withTrace = orderByCoverageMarginalGain({
      candidates,
      relevanceByCandidateKey,
      supplementaryData,
      onSelection: (observation) => observations.push(observation)
    });

    expect(withTrace).toEqual(withoutTrace);
    expect(observations).toEqual([
      {
        candidate_key: sharedGistFirst.fusion.candidate_key,
        marginal_gain: 0.99,
        selection_order: 1
      },
      {
        candidate_key: novel.fusion.candidate_key,
        marginal_gain: 0.5,
        selection_order: 2
      },
      {
        candidate_key: sharedGistSecond.fusion.candidate_key,
        marginal_gain: 0.49,
        selection_order: 3
      }
    ]);
  });

  it("accepts a replaceable objective operator without adding a second selector", () => {
    const first = createCandidate("first", 0.99);
    const second = createCandidate("second", 0.98);
    const third = createCandidate("third", 0.5);
    const objective: CoverageSelectionObjective<
      FineAssessmentCandidate,
      { selected: number }
    > = Object.freeze({
      operator_id: "offline_reverse_relevance_v1",
      createState: () => ({ selected: 0 }),
      marginalGain: ({ relevance }) => 1 - relevance,
      accept: ({ state }) => { state.selected += 1; }
    });

    const ordered = orderByCoverageMarginalGain({
      candidates: [first, second, third],
      relevanceByCandidateKey: relevanceMap([first, second, third]),
      supplementaryData: createSupplementaryData(),
      objective
    });

    expect(ordered.map((candidate) => candidate.entry.object_id)).toEqual([
      "third",
      "second",
      "first"
    ]);
  });

  it("passes source-attributed coverage atoms through the one selector seam", () => {
    const baseCandidate = createCandidate("first", 0.99);
    const candidate = {
      ...baseCandidate,
      entry: { ...baseCandidate.entry, evidence_refs: ["evidence-1"] }
    };
    const winner = {
      score: 0.9,
      evidenceObjectId: "evidence-1",
      documentIdentity: "fact_key:5:strong",
      projection: {
        projection_id: 5,
        projection_kind: "fact_key",
        matched_fact_key_forms: [
          { kind: "leave_one_slot_out", omitted_slot: { slot_index: 2, role: "value" } },
          { kind: "leave_one_slot_out", omitted_slot: { slot_index: 4, role: "time" } },
          { kind: "leave_one_slot_out", omitted_slot: { slot_index: 2, role: "value" } }
        ],
        fact_slots: [
          { role: "subject", text: "I" },
          { role: "relation", text: "bought" },
          { role: "value", text: "a bookshelf" },
          { role: "time", text: "last year" }
        ]
      }
    } as const;
    const weakerAlias = {
      score: 0.4,
      evidenceObjectId: "evidence-1",
      documentIdentity: "fact_key:5:weak",
      projection: {
        projection_id: 5,
        projection_kind: "fact_key",
        matched_fact_key_forms: [
          { kind: "leave_one_slot_out", omitted_slot: { slot_index: 1, role: "relation" } }
        ]
      }
    } as const;
    const independentSource = {
      score: 0.7,
      evidenceObjectId: "evidence-2",
      documentIdentity: "owner",
      projection: {
        projection_id: null,
        projection_kind: "owner",
        matched_fact_key_forms: []
      }
    } as const;
    const receipt = captureCoverageReceipt(
      candidate,
      createSupplementaryData({
        evidenceSemanticActivationsByCandidateKey: new Map([[
          candidate.fusion.candidate_key,
          evidenceSemanticActivation(0.9, winner, [weakerAlias, independentSource])
        ]]),
        evidenceProjectionMatchesByRef: {
          "evidence-1": [{
            evidence_ref: "evidence-1",
            projection_kind: "fact_key",
            projection_id: 5,
            normalized_rank: 0.85,
            matched_fts_lanes: ["porter"],
            fact_key_forms: [{
              kind: "leave_one_slot_out",
              omitted_slot: { slot_index: 0, role: "subject" }
            }],
            fact_slots: [
              { role: "subject", text: "I" },
              { role: "relation", text: "bought" },
              { role: "value", text: "a bookshelf" },
              { role: "time", text: "last year" }
            ]
          }]
        }
      })
    );

    expect(receipt).toMatchObject({
      operator_id: "attributed_coverage_atoms_v1",
      candidate_key: candidate.fusion.candidate_key,
      evidence_semantic_completeness: "complete",
      projection_match_count: 1,
      activation: {
        operator_id: "candidate_semantic_max_v1",
        state: "observed",
        winner: { channel: "evidence_semantic", score: 0.9 }
      }
    });
    expect(receipt.atoms.map((atom) => atom.kind)).toEqual([
      "logical_object",
      "independent_evidence",
      "independent_evidence",
      "fact_projection"
    ]);
    const evidenceAtom = receipt.atoms.find(
      (atom) => atom.atom_id === "evidence:evidence-1"
    )!;
    const factAtom = receipt.atoms.find(
      (atom) => atom.atom_id === "fact:evidence-1:5"
    )!;
    expect(factAtom).toMatchObject({
      strength: 0.9,
      document_identity: "fact_key:5:strong",
      demand_roles: ["subject", "relation", "value", "time"],
      observation_channels: ["evidence_fts", "evidence_semantic"],
      matched_fts_lanes: ["porter"]
    });
    expect(factAtom.projection?.fact_slots).toEqual([
      { role: "subject", text: "I" },
      { role: "relation", text: "bought" },
      { role: "value", text: "a bookshelf" },
      { role: "time", text: "last year" }
    ]);
    expect(evidenceAtom.observation_channels).toEqual([
      "evidence_fts",
      "evidence_semantic"
    ]);
    expect(evidenceAtom.matched_fts_lanes).toEqual(["porter"]);
    expect(factAtom.independence_key).toBe(evidenceAtom.independence_key);
  });

  it("materializes A-side Fact-Key atoms without a semantic receipt", () => {
    const baseCandidate = createCandidate("fts-only", 0.8);
    const candidate = {
      ...baseCandidate,
      entry: { ...baseCandidate.entry, evidence_refs: ["evidence-fts"] }
    };
    const receipt = captureCoverageReceipt(candidate, createSupplementaryData({
      evidenceProjectionMatchesByRef: {
        "evidence-fts": [{
          evidence_ref: "evidence-fts",
          projection_kind: "fact_key",
          projection_id: 7,
          normalized_rank: 0.6,
          fact_key_forms: [{
            kind: "leave_one_slot_out",
            omitted_slot: { slot_index: 2, role: "value" }
          }]
        }]
      }
    }));

    expect(receipt).toMatchObject({
      evidence_semantic_completeness: "not_observed",
      projection_match_count: 1,
      activation: { state: "absent", score: null }
    });
    expect(receipt.atoms.map((atom) => atom.kind)).toEqual([
      "logical_object",
      "independent_evidence",
      "fact_projection"
    ]);
    expect(receipt.atoms[2]).toMatchObject({
      atom_id: "fact:evidence-fts:7",
      strength: 0.6,
      demand_roles: ["value"],
      observation_channels: ["evidence_fts"]
    });
  });

  it("does not mint a fact atom without a complete projection identity", () => {
    const baseCandidate = createCandidate("invalid-projection", 0.8);
    const candidate = {
      ...baseCandidate,
      entry: { ...baseCandidate.entry, evidence_refs: ["evidence-incomplete"] }
    };
    const receipt = captureCoverageReceipt(candidate, createSupplementaryData({
      evidenceProjectionMatchesByRef: {
        "evidence-incomplete": [{
          evidence_ref: "evidence-incomplete",
          projection_kind: "fact_key",
          projection_id: null,
          normalized_rank: 0.6,
          fact_key_forms: []
        }]
      }
    }));

    expect(receipt.atoms.map((atom) => atom.kind)).toEqual([
      "logical_object",
      "independent_evidence"
    ]);
    expect(receipt.atoms.some((atom) => atom.atom_id.includes(":null"))).toBe(false);
  });

  it("keeps coverage order and observations at a fixed point", () => {
    const rejected = createCandidate("rejected", 1);
    const sharedFirst = createCandidate("shared-first", 1);
    const sharedSecond = createCandidate("shared-second", 1);
    const novel = createCandidate("novel", 1);
    const candidates = [rejected, sharedFirst, sharedSecond, novel];
    const relevanceByCandidateKey = relevanceMap(candidates);
    const supplementaryData = createSupplementaryData({
      evidenceGistsByMemoryId: {
        rejected: "shared-gist",
        "shared-first": "shared-gist",
        "shared-second": "shared-gist",
        novel: "novel-gist"
      }
    });
    const runPass = (input: readonly FineAssessmentCandidate[]) => {
      const observations: Array<Readonly<{
        candidate_key: string;
        marginal_gain: number;
        selection_order: number;
      }>> = [];
      const ordered = orderByCoverageMarginalGain({
        candidates: input,
        relevanceByCandidateKey,
        supplementaryData,
        advancesCoverage: (candidate) => candidate !== rejected,
        onSelection: (observation) => observations.push(observation)
      });
      return { ordered, observations };
    };

    const first = runPass(candidates);
    const second = runPass(first.ordered);

    expect(first.ordered.map((candidate) => candidate.entry.object_id)).toEqual([
      "rejected",
      "shared-first",
      "novel",
      "shared-second"
    ]);
    expect(second.ordered).toEqual(first.ordered);
    expect(second.observations).toEqual(first.observations);
  });

  it("resolves each candidate coverage identity only once per pass", () => {
    let objectIdReads = 0;
    const candidates = Array.from({ length: 200 }, (_, index) => {
      const objectId = `memory-${index}`;
      const candidate = createCandidate(objectId, 1 - index / 100);
      return {
        ...candidate,
        entry: {
          ...candidate.entry,
          get object_id() {
            objectIdReads += 1;
            return objectId;
          }
        }
      };
    });

    orderByCoverageMarginalGain({
      candidates,
      relevanceByCandidateKey: relevanceMap(candidates),
      supplementaryData: createSupplementaryData()
    });

    expect(objectIdReads).toBeLessThanOrEqual(candidates.length * 2);
  });

  it("matches the legacy pass across generated permutations and rejections", () => {
    for (let seed = 0; seed < 128; seed += 1) {
      const generated = Array.from({ length: 9 }, (_, index) =>
        createCandidate(`memory-${seed}-${index}`, ((index * 7 + seed) % 4 + 1) / 10)
      );
      const pivot = seed % generated.length;
      const candidates = [
        ...generated.slice(pivot),
        ...generated.slice(0, pivot)
      ];
      if (seed % 2 === 1) candidates.reverse();
      const supplementaryData = createSupplementaryData({
        evidenceGistsByMemoryId: Object.fromEntries(candidates.map((candidate, index) => [
          candidate.entry.object_id,
          `gist-${(index + seed) % 3}`
        ]))
      });
      const relevanceByCandidateKey = relevanceMap(candidates);
      const rejected = new Set(candidates
        .filter((_candidate, index) => (index + seed) % 5 === 0)
        .map((candidate) => candidate.fusion.candidate_key));
      const expected = legacyCoveragePass(
        candidates,
        relevanceByCandidateKey,
        supplementaryData,
        rejected
      );
      const observations: CoverageMarginalObservation[] = [];
      const actual = orderByCoverageMarginalGain({
        candidates,
        relevanceByCandidateKey,
        supplementaryData,
        advancesCoverage: (candidate) => !rejected.has(candidate.fusion.candidate_key),
        onSelection: (observation) => observations.push(observation)
      });

      expect(actual).toEqual(expected.ordered);
      expect(observations).toEqual(expected.observations);
    }
  });

  it("fills toward the token budget instead of stopping early with unused tokens", () => {
    const candidates = Array.from({ length: 6 }, (_, index) =>
      createCandidate(`mem-${index + 1}`, 1 - index * 0.05)
    );
    const result = selectFineAssessmentCandidates({
      orderedCandidates: candidates,
      config: {
        conflict_awareness: false,
        budgets: {
          max_entries: 10,
          max_total_tokens: 30,
          per_dimension_limits: null
        }
      },
      supplementaryData: createSupplementaryData({
        evidenceGistsByMemoryId: Object.fromEntries(
          candidates.map((candidate, index) => [candidate.entry.object_id, `gist-${index}`])
        )
      }),
      tokenEstimator: { estimate: () => 6 },
      rankByCandidateKey: createRanks(candidates),
      finalRelevanceByCandidateKey: relevanceMap(candidates)
    });

    expect(result.candidates).toHaveLength(5);
    expect(result.candidates.reduce((sum, candidate) => sum + candidate.token_estimate, 0)).toBe(30);
    expect(result.diagnostics.filter((row) => row.dropped_reason === "max_total_tokens")).toHaveLength(1);
  });

  it("does not let a token-rejected candidate consume coverage", () => {
    const rejected = createCandidate("rejected-shared", 0.99);
    const deliverableShared = createCandidate("deliverable-shared", 0.8);
    const novel = createCandidate("novel", 0.6);
    const candidates = [rejected, deliverableShared, novel];
    const result = selectFineAssessmentCandidates({
      orderedCandidates: candidates,
      config: {
        conflict_awareness: false,
        budgets: {
          max_entries: 1,
          max_total_tokens: 5,
          per_dimension_limits: null
        }
      },
      supplementaryData: createSupplementaryData({
        evidenceGistsByMemoryId: {
          "rejected-shared": "shared-gist",
          "deliverable-shared": "shared-gist",
          novel: "novel-gist"
        }
      }),
      tokenEstimator: {
        estimate: (content) => content.includes("rejected-shared") ? 6 : 5
      },
      rankByCandidateKey: createRanks(candidates),
      finalRelevanceByCandidateKey: relevanceMap(candidates)
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "deliverable-shared"
    ]);
    expect(result.diagnostics.find(
      (candidate) => candidate.object_id === "rejected-shared"
    )?.dropped_reason).toBe("max_total_tokens");
  });

  it("does not let duplicate or dimension rejections consume coverage", () => {
    const anchor = createCandidate("shared", 1);
    const duplicateBase = createCandidate("shared", 0.95);
    const duplicate = {
      ...duplicateBase,
      originPlane: "global" as const,
      fusion: {
        ...duplicateBase.fusion,
        candidate_key: "global:memory_entry:shared"
      }
    };
    const dimensionRejected = createCandidate("dimension-rejected", 0.9);
    const deliverableShared = withDimension(
      createCandidate("deliverable-shared", 0.8),
      MemoryDimension.FACT
    );
    const novel = withDimension(createCandidate("novel", 0.35), MemoryDimension.PREFERENCE);
    const candidates = [anchor, duplicate, dimensionRejected, deliverableShared, novel];
    const result = selectFineAssessmentCandidates({
      orderedCandidates: candidates,
      config: {
        conflict_awareness: false,
        budgets: {
          max_entries: 2,
          max_total_tokens: 100,
          per_dimension_limits: { [MemoryDimension.PROCEDURE]: 1 }
        }
      },
      supplementaryData: createSupplementaryData({
        evidenceGistsByMemoryId: {
          shared: "shared-gist",
          "dimension-rejected": "shared-gist",
          "deliverable-shared": "shared-gist",
          novel: "novel-gist"
        }
      }),
      tokenEstimator: { estimate: () => 5 },
      rankByCandidateKey: createRanks(candidates),
      finalRelevanceByCandidateKey: relevanceMap(candidates)
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "shared",
      "deliverable-shared"
    ]);
    expect(result.diagnostics.find(
      (candidate) => candidate.candidate_key === duplicate.fusion.candidate_key
    )?.dropped_reason).toBe("duplicate");
    expect(result.diagnostics.find(
      (candidate) => candidate.object_id === "dimension-rejected"
    )?.dropped_reason).toBe("dimension_limit");
  });

  it("keeps embedding as evidence instead of a pre-governor deletion authority", () => {
    const conflict = createCandidate("conflict", 0.99);
    const protectedWinner = createCandidate("protected", 0.9);
    const embeddingBase = createCandidate("embedding-head", 0.7);
    const embeddingHead = {
      ...embeddingBase,
      fusion: {
        ...embeddingBase.fusion,
        per_stream_rank: {
          ...embeddingBase.fusion.per_stream_rank,
          embedding_similarity: 1
        }
      }
    };
    const novel = createCandidate("novel", 0.4);
    const candidates = [conflict, protectedWinner, embeddingHead, novel];
    const result = selectFineAssessmentCandidates({
      orderedCandidates: candidates,
      config: {
        conflict_awareness: false,
        budgets: { max_entries: 2, max_total_tokens: 100, per_dimension_limits: null }
      },
      supplementaryData: createSupplementaryData({
        evidenceGistsByMemoryId: {
          conflict: "shared-gist",
          protected: "protected-gist",
          "embedding-head": "shared-gist",
          novel: "novel-gist"
        },
        embeddingSimilarityScores: { conflict: 0.2, "embedding-head": 0.9 }
      }),
      tokenEstimator: { estimate: () => 5 },
      rankByCandidateKey: createRanks(candidates),
      finalRelevanceByCandidateKey: relevanceMap(candidates),
      answerRelevanceRankByCandidateKey: new Map([
        [protectedWinner.fusion.candidate_key, 1]
      ])
    });
    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "embedding-head",
      "protected"
    ]);
    expect(result.diagnostics.find(
      (candidate) => candidate.object_id === "conflict"
    )?.dropped_reason).toBe("max_entries");
    expect(result.diagnostics.find(
      (candidate) => candidate.object_id === "embedding-head"
    )?.dropped_reason).toBeNull();
  });

  it("uses diminishing returns without discarding repeated-gist items", () => {
    const candidates = Array.from({ length: 4 }, (_, index) =>
      createCandidate(`same-gist-${index + 1}`, 1 - index * 0.01)
    );
    const result = selectFineAssessmentCandidates({
      orderedCandidates: candidates,
      config: {
        conflict_awareness: false,
        budgets: {
          max_entries: 10,
          max_total_tokens: 100,
          per_dimension_limits: null
        }
      },
      supplementaryData: createSupplementaryData({
        evidenceGistsByMemoryId: Object.fromEntries(
          candidates.map((candidate) => [candidate.entry.object_id, "shared"])
        )
      }),
      tokenEstimator: { estimate: () => 6 },
      rankByCandidateKey: createRanks(candidates),
      finalRelevanceByCandidateKey: relevanceMap(candidates)
    });

    expect(result.candidates).toHaveLength(candidates.length);
    expect(result.diagnostics.filter((row) => row.dropped_reason === "duplicate")).toHaveLength(0);
  });

  it("does not let fused_score fallback outrank a tiny CE deep-head map", () => {
    const ceWinner = createCandidate("ce-winner", 0.04);
    const fusedTail = createCandidate("fused-tail", 0.08);
    const ordered = orderByCoverageMarginalGain({
      candidates: [fusedTail, ceWinner],
      relevanceByCandidateKey: new Map([
        [ceWinner.fusion.candidate_key, 0.002]
      ]),
      supplementaryData: createSupplementaryData({
        evidenceGistsByMemoryId: {
          "ce-winner": "gist-a",
          "fused-tail": "gist-b"
        }
      })
    });
    expect(ordered.map((candidate) => candidate.entry.object_id)).toEqual([
      "ce-winner",
      "fused-tail"
    ]);
  });

  it("does not treat distinct facts from one source session as duplicates", () => {
    const anchor = createCandidate("cohort-anchor", 0.9);
    const sameCohort = createCandidate("same-cohort", 0.8);
    const otherCohort = createCandidate("other-cohort", 0.5);
    const ordered = orderByCoverageMarginalGain({
      candidates: [anchor, sameCohort, otherCohort],
      relevanceByCandidateKey: new Map([
        [anchor.fusion.candidate_key, 0.9],
        [sameCohort.fusion.candidate_key, 0.8],
        [otherCohort.fusion.candidate_key, 0.5]
      ]),
      supplementaryData: createSupplementaryData({
        evidenceGistsByMemoryId: {
          "cohort-anchor": "gist-a",
          "same-cohort": "gist-b",
          "other-cohort": "gist-c"
        },
        sourceCohortKeys: {
          "cohort-anchor": "cohort-1",
          "same-cohort": "cohort-1",
          "other-cohort": "cohort-2"
        }
      })
    });
    expect(ordered.map((candidate) => candidate.entry.object_id)).toEqual([
      "cohort-anchor",
      "same-cohort",
      "other-cohort"
    ]);
  });

  it("keeps the final packet in the coverage-selected order", () => {
    const highFusedDupA = createCandidate("dup-a", 0.99);
    const highFusedDupB = createCandidate("dup-b", 0.98);
    const lowFusedNovel = createCandidate("novel", 0.4);
    const result = selectFineAssessmentCandidates({
      orderedCandidates: [highFusedDupA, highFusedDupB, lowFusedNovel],
      config: {
        conflict_awareness: false,
        budgets: {
          max_entries: 2,
          max_total_tokens: 100,
          per_dimension_limits: null
        }
      },
      supplementaryData: createSupplementaryData({
        evidenceGistsByMemoryId: {
          "dup-a": "same-gist",
          "dup-b": "same-gist",
          novel: "fresh-gist"
        }
      }),
      tokenEstimator: { estimate: () => 6 },
      rankByCandidateKey: createRanks([highFusedDupA, highFusedDupB, lowFusedNovel]),
      finalRelevanceByCandidateKey: new Map([
        [highFusedDupA.fusion.candidate_key, 0.99],
        [highFusedDupB.fusion.candidate_key, 0.98],
        [lowFusedNovel.fusion.candidate_key, 0.4]
      ]),
      coverageRelevanceByCandidateKey: new Map([
        [highFusedDupA.fusion.candidate_key, 0.2],
        [highFusedDupB.fusion.candidate_key, 0.15],
        [lowFusedNovel.fusion.candidate_key, 0.95]
      ]),
      finalOrderAfterCoverage: "public_relevance"
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "novel",
      "dup-a"
    ]);
    expect(result.candidates.map((candidate) => candidate.relevance_score)).toEqual([
      0.4,
      0.99
    ]);
    // Coverage chooses both the admitted set and the final selector order.
    expect(result.candidates[0]).toMatchObject({
      score_factors: { relevance: 0.4 },
      budget_state: { remaining_entries: 1, remaining_tokens: 94 }
    });
    const diagnostics = new Map(result.diagnostics.map((row) => [row.object_id, row]));
    expect(diagnostics.get("novel")).toMatchObject({
      rank_after_coverage_selector: 1,
      final_rank: 1,
      post_rank: 1
    });
    expect(diagnostics.get("dup-a")).toMatchObject({
      rank_after_coverage_selector: 2,
      final_rank: 2,
      post_rank: 2
    });
  });

  it("does not perform a second public-order displacement", () => {
    const publicA = createCandidate("public-a", 0.99);
    const publicB = createCandidate("public-b", 0.98);
    const headA = createCandidate("head-a", 0.4);
    const candidates = [publicA, publicB, headA];
    const result = selectFineAssessmentCandidates({
      orderedCandidates: candidates,
      config: {
        conflict_awareness: false,
        budgets: { max_entries: 3, max_total_tokens: 100, per_dimension_limits: null }
      },
      supplementaryData: createSupplementaryData(),
      tokenEstimator: { estimate: () => 6 },
      rankByCandidateKey: new Map([
        [headA.fusion.candidate_key, 1],
        [publicA.fusion.candidate_key, 2],
        [publicB.fusion.candidate_key, 3]
      ]),
      finalOrderAfterCoverage: "public_relevance",
      maxHeadDropAfterCoverage: 1
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual([
      "public-a",
      "public-b",
      "head-a"
    ]);
    expect(new Set(result.candidates.map((candidate) => candidate.object_id)))
      .toEqual(new Set(candidates.map((candidate) => candidate.entry.object_id)));
    const diagnostics = new Map(result.diagnostics.map((row) => [row.object_id, row]));
    expect(diagnostics.get("head-a")).toMatchObject({ final_rank: 3, post_rank: 3 });
    expect(result.candidates[1]?.budget_state).toMatchObject({
      remaining_entries: 1,
      remaining_tokens: 88
    });
  });

  it("still deduplicates object_id across provenance projections", () => {
    const local = createCandidate("shared", 0.9);
    const globalBase = createCandidate("shared", 0.8);
    const global = {
      ...globalBase,
      originPlane: "global" as const,
      fusion: {
        ...globalBase.fusion,
        candidate_key: "global:memory_entry:shared",
        fused_rank: 2,
        fused_score: 0.8
      }
    };
    const next = createCandidate("next", 0.7);
    const estimate = vi.fn(() => 6);

    const result = selectFineAssessmentCandidates({
      orderedCandidates: [local, global, next],
      config: {
        conflict_awareness: false,
        budgets: {
          max_entries: 2,
          max_total_tokens: 100,
          per_dimension_limits: null
        }
      },
      supplementaryData: createSupplementaryData({
        evidenceGistsByMemoryId: {
          shared: "gist-a",
          next: "gist-b"
        }
      }),
      tokenEstimator: { estimate },
      rankByCandidateKey: new Map([
        [local.fusion.candidate_key, 1],
        [global.fusion.candidate_key, 2],
        [next.fusion.candidate_key, 3]
      ]),
      finalRelevanceByCandidateKey: new Map([
        [local.fusion.candidate_key, 0.9],
        [global.fusion.candidate_key, 0.8],
        [next.fusion.candidate_key, 0.7]
      ])
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual(["shared", "next"]);
    expect(result.diagnostics.map((row) => ({
      candidateKey: row.candidate_key,
      droppedReason: row.dropped_reason
    }))).toEqual([
      { candidateKey: local.fusion.candidate_key, droppedReason: null },
      { candidateKey: next.fusion.candidate_key, droppedReason: null },
      { candidateKey: global.fusion.candidate_key, droppedReason: "duplicate" }
    ]);
  });
});

function createCandidate(objectId: string, fusedScore: number): FineAssessmentCandidate {
  const breakdown = buildEmptyRecallFusionBreakdown(objectId);
  return {
    entry: createMemoryEntry(objectId),
    effectiveScore: fusedScore,
    effectiveFactors: createScoreFactors(),
    fusion: {
      ...breakdown,
      fused_rank: Math.round((1 - fusedScore) * 100) + 1,
      fused_score: fusedScore
    }
  };
}

function createMemoryEntry(objectId: string): MemoryEntry {
  return {
    object_id: objectId,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-05-13T00:00:00.000Z",
    updated_at: "2026-05-13T00:00:00.000Z",
    created_by: "system",
    dimension: MemoryDimension.PROCEDURE,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: ScopeClass.PROJECT,
    content: `Recall content for ${objectId}.`,
    domain_tags: ["repo"],
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: 0.7,
    retention_score: null,
    manifestation_state: null,
    retention_state: null,
    decay_profile: null,
    confidence: null,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: null,
    contradiction_count: null,
    superseded_by: null
  };
}

function withDimension(
  candidate: FineAssessmentCandidate,
  dimension: MemoryDimension
): FineAssessmentCandidate {
  return { ...candidate, entry: { ...candidate.entry, dimension } };
}

function createScoreFactors(): RecallScoreFactors {
  return {
    activation: 0.7,
    relevance: 0.6,
    graph_support: 0,
    path_plasticity: 0,
    budget_penalty: 0,
    conflict_penalty: 0
  };
}

function createRanks(candidates: readonly FineAssessmentCandidate[]): ReadonlyMap<string, number> {
  return new Map(candidates.map((candidate, index) => [candidate.fusion.candidate_key, index + 1]));
}

function relevanceMap(candidates: readonly FineAssessmentCandidate[]): ReadonlyMap<string, number> {
  return new Map(candidates.map((candidate) => [
    candidate.fusion.candidate_key,
    candidate.fusion.fused_score
  ]));
}

function legacyCoveragePass(
  candidates: readonly FineAssessmentCandidate[],
  relevanceByCandidateKey: ReadonlyMap<string, number>,
  supplementaryData: RecallSupplementaryData,
  rejected: ReadonlySet<string>
): Readonly<{
  readonly ordered: readonly FineAssessmentCandidate[];
  readonly observations: readonly CoverageMarginalObservation[];
}> {
  const remaining = [...candidates];
  const ordered: FineAssessmentCandidate[] = [];
  const observations: CoverageMarginalObservation[] = [];
  const objectCounts = new Map<string, number>();
  const gistCounts = new Map<string, number>();
  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestGain = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index]!;
      const identity = resolveCoverageIdentity(candidate, supplementaryData);
      const relevance = relevanceByCandidateKey.get(candidate.fusion.candidate_key) ?? 0;
      const gain = relevance / (
        1 + (objectCounts.get(identity.objectKey) ?? 0) + (gistCounts.get(identity.gistKey) ?? 0)
      );
      if (gain > bestGain) [bestIndex, bestGain] = [index, gain];
    }
    const picked = remaining.splice(bestIndex, 1)[0]!;
    const identity = resolveCoverageIdentity(picked, supplementaryData);
    ordered.push(picked);
    observations.push(Object.freeze({
      candidate_key: picked.fusion.candidate_key,
      marginal_gain: bestGain,
      selection_order: ordered.length
    }));
    if (rejected.has(picked.fusion.candidate_key)) continue;
    objectCounts.set(identity.objectKey, (objectCounts.get(identity.objectKey) ?? 0) + 1);
    gistCounts.set(identity.gistKey, (gistCounts.get(identity.gistKey) ?? 0) + 1);
  }
  return { ordered, observations };
}

function createSupplementaryData(
  overrides: Partial<RecallSupplementaryData> = {}
): RecallSupplementaryData {
  return {
    queryProbes: compileRecallQueryProbes(null),
    ftsRanks: {},
    trigramFtsRanks: {},
    synthesisFtsRanks: {},
    evidenceFtsRanks: {},
    sourceProximityScores: {},
    sourceCohortKeys: {},
    structuralScores: {},
    graphExpansionScores: {},
    entitySeedScores: {},
    pathExpansionScores: {},
    pathSuppressionScores: {},
    embeddingSimilarityScores: {},
    evidenceSemanticActivationsByCandidateKey: new Map(),
    graphSupportCounts: {},
    budgetPenaltyFactor: 0,
    plasticityFactors: {},
    graphAndPathColdScore: 0,
    recallsEdgeCount: 0,
    weightTransferAmount: 0,
    evidenceGistsByMemoryId: {},
    governanceCeilingByMemoryId: {},
    ...overrides
  };
}

function captureCoverageReceipt(
  candidate: FineAssessmentCandidate,
  supplementaryData: RecallSupplementaryData
): CandidateCoverageReceipt {
  let receipt: CandidateCoverageReceipt | null = null;
  const objective: CoverageSelectionObjective<
    FineAssessmentCandidate,
    Record<string, never>
  > = Object.freeze({
    operator_id: "coverage_receipt_probe_v1",
    createState: () => ({}),
    marginalGain: ({ coverage, relevance }) => {
      receipt = coverage;
      return relevance;
    },
    accept: () => {}
  });
  orderByCoverageMarginalGain({
    candidates: [candidate],
    relevanceByCandidateKey: relevanceMap([candidate]),
    supplementaryData,
    objective
  });
  if (receipt === null) throw new Error("coverage receipt was not observed");
  return receipt;
}
