import { describe, expect, it } from "vitest";
import { compileRecallQueryProbes } from
  "../../../recall/query/recall-query-probes.js";
import { captureRecallQueryFactFrames } from
  "../../../recall/field/query-attribution/query-fact-frame-attribution-producer.js";
import { buildProductionSetUtilities } from
  "../../../recall/shadow/utility/production.js";
import { buildRecallCandidateDedupeKey } from
  "../../../recall/runtime/recall-service-helpers.js";
import {
  isCapturedWalk,
  walkShadowCapture,
  type ShadowCaptureWalkCandidate
} from "../../../recall/shadow/walk.js";
import {
  CHEAP_RANKING_RUNG_COST,
  CHEAP_RANKING_RUNG_ID,
  cheapRungAnyAt5,
  scoreCheapRankingRung,
  type CheapRankingRungRow
} from "../../../recall/shadow/ranking/cheap-rung.js";
import type {
  CoarseRecallCandidate,
  RecallEvidenceProjectionMatchReceipt,
  RecallSupplementaryData
} from "../../../recall/runtime/recall-service-types.js";
import { createMemoryEntry } from "../recall-service-test-fixtures.js";
import { compareText } from "../../../shared/compare-text.js";

const QUERY = "What degree I graduate";
const CHEAP_RANKING_RUNG_QUESTION_IDS = [
  "n4-rung-degree-0",
  "n4-rung-degree-1",
  "n4-rung-degree-2",
  "n4-rung-degree-3",
  "n4-rung-degree-4",
  "n4-rung-degree-5"
] as const;
const DISTRACTORS_PER_FIELD = 6;

describe("cheap ranking rung planted covering field", () => {
  it("scores live remainder walks any@5 and tail share in-process", async () => {
    const rows = await Promise.all(
      CHEAP_RANKING_RUNG_QUESTION_IDS.map((questionId, index) =>
        plantCoveringRungRow(questionId, index)
      )
    );
    const report = scoreCheapRankingRung(rows);
    expect(report.rung_id).toBe(CHEAP_RANKING_RUNG_ID);
    expect(report.cost).toBe(CHEAP_RANKING_RUNG_COST);
    expect(report.questions).toBe(6);
    expect(report.any_at_5).toEqual({ hits: 6, denominator: 6, rate: 1 });
    expect(report.tail_share.share).toBe(0);
    expect(report.degeneracy.holds).toBe(true);
  });

  it("separates a candidate_key prefix of the same field", async () => {
    const live = await plantCoveringRungRow(CHEAP_RANKING_RUNG_QUESTION_IDS[0], 0);
    const keyOrder = keyOrderedRow(live);
    expect(live.any_at_5).toBe(true);
    expect(keyOrder.any_at_5).toBe(false);
    const report = scoreCheapRankingRung([keyOrder]);
    expect(report.any_at_5.hits).toBe(0);
    expect(report.tail_share.share).toBe(1);
    expect(report.degeneracy.holds).toBe(false);
  });
});

type PlantedRungRow = CheapRankingRungRow & Readonly<{
  readonly gold_candidate_key: string;
  readonly field_keys: readonly string[];
}>;

async function plantCoveringRungRow(
  questionId: string,
  index: number
): Promise<PlantedRungRow> {
  const distractors = Array.from({ length: DISTRACTORS_PER_FIELD }, (_, slot) =>
    candidate(`aaa-n4-${index}-d${slot}`, "noise about weather")
  );
  const cover = candidate(
    `zzz-n4-${index}-degree`,
    "an undergraduate degree",
    [`evidence-n4-${index}`]
  );
  const utilities = buildProductionSetUtilities({
    candidates: [...distractors, cover],
    supplementaryData: await supplementary(cover)
  });
  const walkCandidates = [...utilities.values()].map(walkCandidate);
  const walked = walkShadowCapture({
    candidates: walkCandidates,
    psi: () => false,
    token_budget: 10_000,
    per_dimension_limits: null
  });
  expect(isCapturedWalk(walked)).toBe(true);
  if (!isCapturedWalk(walked)) throw new Error("expected captured walk");
  const goldKey = buildRecallCandidateDedupeKey(cover);
  const fieldKeys = walkCandidates.map((row) => row.candidate_key);
  return {
    question_id: questionId,
    any_at_5: cheapRungAnyAt5([goldKey], walked.S_infty),
    first_pick: walked.decisions[0] ?? null,
    gold_candidate_key: goldKey,
    field_keys: fieldKeys
  };
}

function keyOrderedRow(live: PlantedRungRow): CheapRankingRungRow {
  const ordered = [...live.field_keys].sort(compareText);
  return {
    question_id: `${live.question_id}:candidate_key_prefix`,
    any_at_5: cheapRungAnyAt5([live.gold_candidate_key], ordered),
    first_pick: {
      max_g_cohort: ordered,
      equal_g_dominance_rejects: []
    }
  };
}

function walkCandidate(
  utility: ShadowCaptureWalkCandidate["utility"]
): ShadowCaptureWalkCandidate {
  return {
    candidate_key: utility.candidate_key,
    object_key: utility.object_key,
    token_cost: 1,
    dimension: "mem",
    h_eligible: true,
    utility,
    static_frontier_index: null
  };
}

function candidate(
  objectId: string,
  content: string,
  evidenceRefs: readonly string[] = []
): CoarseRecallCandidate {
  return {
    entry: createMemoryEntry({
      object_id: objectId,
      content,
      evidence_refs: [...evidenceRefs]
    }),
    objectKind: "memory_entry",
    originPlane: "workspace_local",
    isAdvisory: false,
    scoreMultiplier: 1,
    sourceChannels: ["local_lexical"],
    admissionPlanes: ["lexical"],
    firstAdmissionPlane: "lexical"
  };
}

async function supplementary(
  cover: CoarseRecallCandidate
): Promise<RecallSupplementaryData> {
  const capture = await captureRecallQueryFactFrames({
    query_text: QUERY,
    port: {
      operator_id: "structured_query_frame_v1",
      extract: async () => [{
        schema_version: 1,
        slots: [
          { role: "value", text: "What degree" },
          { role: "subject", text: "I" },
          { role: "relation", text: "graduate" }
        ]
      }]
    }
  });
  const evidenceRef = cover.entry.evidence_refs[0] ?? "evidence-degree";
  return {
    queryProbes: compileRecallQueryProbes(QUERY),
    queryFactFrameExtraction: capture,
    ftsRanks: {}, trigramFtsRanks: {}, synthesisFtsRanks: {}, evidenceFtsRanks: {},
    evidenceProjectionMatchesByRef: {
      [evidenceRef]: [projection(evidenceRef, degreeSlots())]
    },
    sourceProximityScores: {}, sourceCohortKeys: {},
    structuralScores: {}, graphExpansionScores: {}, entitySeedScores: {},
    pathExpansionScores: {}, pathSuppressionScores: {}, embeddingSimilarityScores: {},
    evidenceSemanticActivationsByCandidateKey: new Map(), graphSupportCounts: {},
    budgetPenaltyFactor: 0, plasticityFactors: {}, graphAndPathColdScore: 0,
    recallsEdgeCount: 0, weightTransferAmount: 0, evidenceGistsByMemoryId: {},
    governanceCeilingByMemoryId: {}
  };
}

function projection(
  evidenceRef: string,
  slots: RecallEvidenceProjectionMatchReceipt["fact_slots"]
): RecallEvidenceProjectionMatchReceipt {
  return {
    evidence_ref: evidenceRef,
    projection_kind: "fact_key",
    projection_id: 7,
    normalized_rank: 0.8,
    matched_fts_lanes: ["exact"],
    fact_key_forms: [{ kind: "complete" }],
    fact_slots: slots
  };
}

function degreeSlots(): RecallEvidenceProjectionMatchReceipt["fact_slots"] {
  return [
    { role: "subject", text: "Alice" },
    { role: "relation", text: "holds" },
    { role: "value", text: "an undergraduate degree" }
  ];
}
