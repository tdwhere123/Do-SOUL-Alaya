import { describe, expect, it, vi } from "vitest";
import { createSelectionContext } from
  "../../recall/delivery/fine-assessment-selection/coverage-order.js";
import {
  projectFineAssessmentNestedField,
  projectFineAssessmentNestedCandidate,
  selectNestedFineAssessmentCandidates
} from
  "../../recall/delivery/nested-selector/fine-assessment-nested-selector.js";
import type { FineAssessmentCandidate } from
  "../../recall/delivery/fine-assessment-selection.js";
import { compileRecallQueryProbes } from
  "../../recall/query/recall-query-probes.js";
import {
  createCandidate,
  createConfig,
  createSupplementaryData,
  rankMap
} from "./fine-assessment-selection-fixtures.js";

describe("selectNestedFineAssessmentCandidates", () => {
  it("preserves the existing order exactly when semantic observation is absent", () => {
    const candidates = [ranked("one", 1, null), ranked("two", 2, null)];
    const result = selectNestedFineAssessmentCandidates(candidates, context(candidates));

    expect(result.status).toBe("no_semantic_observation");
    expect(result.orderedCandidates).toBe(candidates);
    expect(result.plan).toBeNull();
  });

  it("projects source-role demand into the nested semantic selection", () => {
    const plain = ranked("plain", 1, 2);
    const answer = attributedAnswer(withStreamRank(
      ranked("answer", 2, 1, "evidence_capsule"), "lexical_fts", 1
    ));
    const candidates = [plain, answer];
    const result = selectNestedFineAssessmentCandidates(
      candidates,
      context(candidates, "Which option did you recommend?", 1)
    );

    expect(result.status).toBe("selected");
    expect(result.plan?.headKeys).toEqual([
      "workspace_local:evidence_capsule:answer"
    ]);
    expect(result.orderedCandidates[0]?.entry.object_id).toBe("answer");
  });

  it("projects correlated streams as one activation-family observation", () => {
    const base = ranked("candidate", 4, 3);
    const candidate = {
      ...base,
      fusion: {
        ...base.fusion,
        per_stream_rank: {
          ...base.fusion.per_stream_rank,
          lexical_fts: 8,
          trigram_fts: 2,
          evidence_fts: 5,
          existing_score: 7,
          source_proximity: 4,
          graph_expansion: 6,
          path_expansion: 1,
          temporal_recency: 9,
          subject_alignment: 3
        }
      }
    };
    const selectionContext = context([candidate]);

    const projected = projectFineAssessmentNestedCandidate(
      candidate, 1, selectionContext
    );

    expect(projected.scenarioRanks).toMatchObject({
      semantic: 3,
      lexical: 2,
      structural: 4,
      graph_path: 1,
      temporal_facet: 3
    });
  });

  it("keeps Evidence semantic strength as an independent ranked observation", () => {
    const candidates = [ranked("a", 1, 1), ranked("b", 2, 2), ranked("c", 3, 3)];
    const evidenceScores = new Map([
      ["workspace_local:memory_entry:a", 0.8],
      ["workspace_local:memory_entry:b", 0.8],
      ["workspace_local:memory_entry:c", 0.4]
    ]);
    const selectionContext = context(candidates, null, 10, evidenceScores);

    const projected = projectFineAssessmentNestedField(candidates, selectionContext);

    expect(projected.map((candidate) =>
      candidate.scenarioRanks.evidence_semantic
    )).toEqual([2, 2, 3]);
  });

  it("treats a broad rank tie as the worst position the channel can prove", () => {
    const candidates = [
      withStreamRank(ranked("a", 1, 1), "existing_score", 1),
      withStreamRank(ranked("b", 2, 2), "existing_score", 1),
      withStreamRank(ranked("c", 3, 3), "existing_score", 3)
    ];

    const projected = projectFineAssessmentNestedField(candidates, context(candidates));

    expect(projected.map((candidate) =>
      candidate.scenarioRanks.structural
    )).toEqual([2, 2, 3]);
  });

  it("withholds core demand authority from a one-channel candidate", () => {
    const answer = attributedAnswer(ranked("answer", 12, 1, "evidence_capsule"));
    const projected = projectFineAssessmentNestedField(
      [answer], context([answer], "Which option did you recommend?")
    );

    expect(projected[0]?.coreDemandIds).toEqual([]);
  });

  it("retains core demand authority when independent channels corroborate it", () => {
    const answer = attributedAnswer(withStreamRank(
      ranked("answer", 12, 1, "evidence_capsule"), "lexical_fts", 1
    ));
    const projected = projectFineAssessmentNestedField(
      [answer], context([answer], "Which option did you recommend?")
    );

    expect(projected[0]?.coreDemandIds).toContain("source_role:assistant");
  });
});

function context(
  candidates: readonly FineAssessmentCandidate[],
  query: string | null = null,
  maxEntries = 10,
  evidenceScores: ReadonlyMap<string, number> = new Map()
) {
  return createSelectionContext({
    orderedCandidates: candidates,
    config: {
      ...createConfig(),
      budgets: { ...createConfig().budgets, max_entries: maxEntries }
    },
    supplementaryData: createSupplementaryData({
      queryProbes: compileRecallQueryProbes(query),
      evidenceSemanticScoresByCandidateKey: evidenceScores
    }),
    tokenEstimator: { estimate: vi.fn(() => 5) },
    rankByCandidateKey: rankMap(candidates)
  });
}

function ranked(
  id: string,
  fusedRank: number,
  semanticRank: number | null,
  objectKind: FineAssessmentCandidate["objectKind"] = "memory_entry"
): FineAssessmentCandidate {
  const base = createCandidate(id, {}, objectKind);
  return {
    ...base,
    fusion: {
      ...base.fusion,
      fused_rank: fusedRank,
      per_stream_rank: {
        ...base.fusion.per_stream_rank,
        embedding_similarity: semanticRank
      }
    }
  };
}

function withStreamRank(
  candidate: FineAssessmentCandidate,
  stream: keyof FineAssessmentCandidate["fusion"]["per_stream_rank"],
  rank: number
): FineAssessmentCandidate {
  return {
    ...candidate,
    fusion: {
      ...candidate.fusion,
      per_stream_rank: {
        ...candidate.fusion.per_stream_rank,
        [stream]: rank
      }
    }
  };
}

function attributedAnswer(candidate: FineAssessmentCandidate): FineAssessmentCandidate {
  return {
    ...candidate,
    evidenceDocumentIdentity: "assistant_observation:1",
    evidenceSourceRole: "assistant"
  };
}
