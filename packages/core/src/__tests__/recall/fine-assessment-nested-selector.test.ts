import { describe, expect, it, vi } from "vitest";
import { createSelectionContext } from
  "../../recall/delivery/fine-assessment-selection/coverage-order.js";
import {
  projectFineAssessmentNestedField,
  projectFineAssessmentNestedCandidate,
  refineNestedFineAssessmentCandidates,
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
  it("keeps one selector active when semantic observation is absent", () => {
    const candidates = [ranked("one", 1, null), ranked("two", 2, null)];
    const result = selectNestedFineAssessmentCandidates(candidates, context(candidates));

    expect(result.orderedCandidates).toEqual(candidates);
    expect(result.plan?.packKeys).toEqual([
      "workspace_local:memory_entry:one",
      "workspace_local:memory_entry:two"
    ]);
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

  it("withholds supporting coverage from an uncorroborated channel", () => {
    const candidate = withContent(
      withStreamRank(ranked("candidate", 12, null), "lexical_fts", 1),
      "I joined several unrelated communities."
    );
    const projected = projectFineAssessmentNestedField(
      [candidate], context([candidate], "Which online communities did I join?")
    );

    expect(projected[0]?.supportingDemandIds).toEqual([]);
  });

  it("retains supporting coverage when independent channels corroborate it", () => {
    const candidate = withContent(
      attributedUser(withStreamRank(
        ranked("candidate", 12, 1, "evidence_capsule"), "lexical_fts", 1
      )),
      "I joined several online communities."
    );
    const projected = projectFineAssessmentNestedField(
      [candidate], context([candidate], "Which online communities did I join?")
    );

    expect(projected[0]?.supportingDemandIds).toEqual(expect.arrayContaining([
      "target:online", "target:communities", "phrase:online communities"
    ]));
  });

  it("does not reward text matches without an Evidence validity receipt", () => {
    const candidate = withoutEvidence(withContent(
      withStreamRank(ranked("candidate", 1, 1), "lexical_fts", 1),
      "I bought my new bookshelf from IKEA."
    ));
    const projected = projectFineAssessmentNestedField(
      [candidate], context([candidate], "Where did I buy my new bookshelf?")
    );

    expect(projected[0]?.supportingDemandIds).toEqual([]);
    expect(projected[0]?.applicabilityDemandIds).toContain("target:bookshelf");
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

  it("retains same-candidate conjunctive demand with one strong channel", () => {
    const answer = withContent(attributedAnswer(
      withStreamRank(ranked("answer", 12, null, "evidence_capsule"), "lexical_fts", 1)
    ), "I recommend the Rust language.");
    const projected = projectFineAssessmentNestedField(
      [answer], context([answer], "Which language did you recommend?")
    );

    expect(projected[0]?.coreDemandIds).toContain("source_role:assistant");
  });

  it("does not let a relation alone qualify broad source-role demand", () => {
    const candidate = withContent(attributedUser(
      withStreamRank(ranked("candidate", 12, null, "evidence_capsule"), "graph_expansion", 1)
    ), "I take the train every morning.");
    const projected = projectFineAssessmentNestedField(
      [candidate], context([candidate], "Where do I take yoga classes?")
    );

    expect(projected[0]?.coreDemandIds).toEqual([]);
    expect(projected[0]?.supportingDemandIds).toEqual([]);
  });

  it("binds personalized recommendation demand to user preference Evidence", () => {
    const preference = withPreferenceDimension(attributedUser(
      ranked("preference", 12, 1, "evidence_capsule")
    ));
    const projected = projectFineAssessmentNestedField(
      [preference],
      context([preference], "Can you recommend a restaurant based on my preferences?")
    );

    expect(projected[0]?.coreDemandIds).toEqual(expect.arrayContaining([
      "answer_slot:recommendation",
      "source_role:user"
    ]));
  });

  it("binds personalized recommendation to a relevant user fact across noun inflection", () => {
    const fact = withContent(attributedUser(
      withStreamRank(ranked("fact", 12, null, "evidence_capsule"), "lexical_fts", 1)
    ), "I enjoy classic cocktails at small get-togethers.");
    const projected = projectFineAssessmentNestedField(
      [fact], context([fact], "Can you suggest a cocktail for my get-together?")
    );

    expect(projected[0]?.coreDemandIds).toEqual(expect.arrayContaining([
      "answer_slot:recommendation",
      "source_role:user"
    ]));
    expect(projected[0]?.supportingDemandIds).toContain("target:cocktail");
  });

  it("uses an explicit source-target conjunction for episodic user Evidence", () => {
    const episode = withContent(attributedUser(
      withStreamRank(ranked("episode", 12, null, "evidence_capsule"), "lexical_fts", 1)
    ), "I stayed at a quiet hotel in Miami.");
    const projected = projectFineAssessmentNestedField(
      [episode], context([episode], "Can you suggest a hotel for my Miami trip?")
    );

    expect(projected[0]?.coreDemandIds).toContain("source_role:user");
    expect(projected[0]?.coreDemandIds).toContain("answer_slot:recommendation");
    expect(projected[0]?.conjunctiveCoreDemandIds.some((id) =>
      id.includes("source_role:user") && id.includes("target:hotel"))).toBe(true);
    expect(projected[0]?.coreDemandIds.some((id) =>
      id.startsWith("conjunction:"))).toBe(false);
  });

  it("can safely exchange a qualified lexical candidate without semantic state", () => {
    const plain = ranked("plain", 1, null);
    const answer = withContent(attributedAnswer(
      withStreamRank(ranked("answer", 8, null, "evidence_capsule"), "lexical_fts", 1)
    ), "I recommend the Rust language.");
    const candidates = [plain, answer];
    const result = refineNestedFineAssessmentCandidates(
      candidates,
      context(candidates, "Which language did you recommend?", 1),
      {
        headKeys: ["workspace_local:memory_entry:plain"],
        packKeys: ["workspace_local:memory_entry:plain"]
      }
    );

    expect(result.plan?.headKeys).toEqual([
      "workspace_local:evidence_capsule:answer"
    ]);
  });

  it("grants latest ordering coverage only to the applicable temporal extremum", () => {
    const earlier = withEventTime(withContent(attributedUser(
      withStreamRank(ranked("earlier", 1, null, "evidence_capsule"), "lexical_fts", 1)
    ), "I visited Rome."), "2025-01-01T00:00:00.000Z");
    const later = withEventTime(withContent(attributedUser(
      withStreamRank(ranked("later", 2, null, "evidence_capsule"), "lexical_fts", 2)
    ), "I visited Paris."), "2025-02-01T00:00:00.000Z");
    const projected = projectFineAssessmentNestedField(
      [earlier, later], context([earlier, later], "What was the latest place I visited?")
    );

    expect(projected[0]?.coreDemandIds).not.toContain("ordering:latest");
    expect(projected[1]?.coreDemandIds).toContain("ordering:latest");
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

function attributedUser(candidate: FineAssessmentCandidate): FineAssessmentCandidate {
  return {
    ...candidate,
    evidenceDocumentIdentity: "user_observation:1",
    evidenceSourceRole: "user"
  };
}

function withContent(
  candidate: FineAssessmentCandidate,
  content: string
): FineAssessmentCandidate {
  return {
    ...candidate,
    entry: { ...candidate.entry, content }
  };
}

function withoutEvidence(candidate: FineAssessmentCandidate): FineAssessmentCandidate {
  return {
    ...candidate,
    entry: { ...candidate.entry, evidence_refs: [] }
  };
}

function withEventTime(
  candidate: FineAssessmentCandidate,
  eventTime: string
): FineAssessmentCandidate {
  return {
    ...candidate,
    entry: { ...candidate.entry, event_time_start: eventTime }
  };
}

function withPreferenceDimension(
  candidate: FineAssessmentCandidate
): FineAssessmentCandidate {
  return {
    ...candidate,
    entry: { ...candidate.entry, dimension: "preference" }
  };
}
