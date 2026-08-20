import { FIELD_PINS } from "./fine-assessment-selection-fixtures.js";
import { describe, expect, it, vi } from "vitest";
import {
  MemoryDimension,
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
import type { RecallSupplementaryData } from "../../recall/runtime/recall-service-types.js";
import { evidenceSemanticActivation } from
  "./fixtures/evidence-semantic-activation.js";
import {
  captureCoverageReceipt,
  createCandidate,
  createRanks,
  createSupplementaryData,
  legacyCoveragePass,
  relevanceMap,
  withDimension
} from "./coverage-selection-test-support.js";

describe("coverage-aware delivery budget", () => {
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
    ...FIELD_PINS,
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
    ...FIELD_PINS,
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
    ...FIELD_PINS,
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
    ...FIELD_PINS,
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
      "conflict",
      "protected"
    ]);
    expect(result.diagnostics.find(
      (candidate) => candidate.object_id === "conflict"
    )?.dropped_reason).toBeNull();
    expect(result.diagnostics.find(
      (candidate) => candidate.object_id === "embedding-head"
    )?.dropped_reason).toBe("max_entries");
  });

  it("uses diminishing returns without discarding repeated-gist items", () => {
    const candidates = Array.from({ length: 4 }, (_, index) =>
      createCandidate(`same-gist-${index + 1}`, 1 - index * 0.01)
    );
    const result = selectFineAssessmentCandidates({
    ...FIELD_PINS,
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

});
