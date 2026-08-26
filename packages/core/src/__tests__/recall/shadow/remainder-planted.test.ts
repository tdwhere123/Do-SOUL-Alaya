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
  computeGammaTuple,
  emptySelectedSet,
  obligationUniverseFrom
} from "../../../recall/shadow/gamma-tuple.js";
import {
  deterministicTailDecidedThisPick,
  isCapturedWalk,
  walkShadowCapture,
  type ShadowCaptureWalkCandidate
} from "../../../recall/shadow/walk.js";
import type {
  CoarseRecallCandidate,
  RecallEvidenceProjectionMatchReceipt,
  RecallSupplementaryData
} from "../../../recall/runtime/recall-service-types.js";
import { createMemoryEntry } from "../recall-service-test-fixtures.js";

const QUERY = "What degree I graduate";
const DISTRACTOR_ID = "aaa-none";
const COVER_ID = "zzz-degree";

describe("remainder separates empty-Psi capture from candidate_key tail", () => {
  it("picks the larger-key degree cover, not the smaller-key distractor", async () => {
    const { coverKey, distractorKey, cover, distractor, walked } =
      await plantDegreeWalk();
    expect(distractorKey < coverKey).toBe(true);
    expect(cover.obligations.some((row) =>
      row.key.kind === "entity" && row.key.value === "degree" &&
      row.availability === "available" && row.cover > 0
    )).toBe(true);
    expect(distractor.obligations.filter((row) =>
      row.key.kind === "entity" && row.key.value === "degree"
    ).every((row) => row.cover === 0)).toBe(true);

    const universe = obligationUniverseFrom([cover, distractor]);
    const empty = emptySelectedSet();
    const coverG = computeGammaTuple(cover, empty, universe);
    const distractorG = computeGammaTuple(distractor, empty, universe);
    expect(coverG.unscaled_remainder).toBeGreaterThan(0);
    expect(distractorG.unscaled_remainder).toBe(0);
    expect(walked.S_infty[0]).toBe(coverKey);
    expect(walked.decisions[0]).toMatchObject({
      candidate_key: coverKey,
      G: coverG,
      max_g_cohort: [coverKey],
      equal_g_dominance_rejects: [],
      deterministic_tail: "candidate_key_code_unit_ascending"
    });
    expect(deterministicTailDecidedThisPick(walked.decisions[0]!)).toBe(false);
  });

  it("covers from stored content when the candidate has no evidence_refs", async () => {
    const { coverKey, distractorKey, cover, distractor, walked } =
      await plantDegreeWalk({ omitEvidenceRefs: true });
    expect(distractorKey < coverKey).toBe(true);
    expect(cover.obligations.some((row) =>
      row.key.kind === "entity" && row.key.value === "degree" &&
      row.availability === "available" && row.cover > 0
    )).toBe(true);
    expect(distractor.obligations.filter((row) =>
      row.key.kind === "entity" && row.key.value === "degree"
    ).every((row) => row.cover === 0)).toBe(true);
    expect(walked.S_infty[0]).toBe(coverKey);
    expect(deterministicTailDecidedThisPick(walked.decisions[0]!)).toBe(false);
  });

  it("does not grant remainder from inflection-only content without a porter lane", async () => {
    const { coverKey, distractorKey, walked } = await plantDegreeWalk({
      omitEvidenceRefs: true,
      coverContent: "she graduated yesterday"
    });
    expect(distractorKey < coverKey).toBe(true);
    expect(walked.S_infty[0]).toBe(distractorKey);
    expect(deterministicTailDecidedThisPick(walked.decisions[0]!)).toBe(true);
  });

  it("serializes by candidate_key when remainder is zero for both", async () => {
    const { coverKey, distractorKey, walked } = await plantDegreeWalk({
      coverSlots: appleSlots(),
      coverContent: "a red apple"
    });
    expect(distractorKey < coverKey).toBe(true);
    expect(walked.S_infty[0]).toBe(distractorKey);
    expect(walked.decisions[0]).toMatchObject({
      candidate_key: distractorKey,
      G: {
        unscaled_remainder: 0,
        Values_v: 0,
        evidence_novelty_redundancy: 1
      },
      max_g_cohort: [distractorKey, coverKey].sort(),
      equal_g_dominance_rejects: [],
      deterministic_tail: "candidate_key_code_unit_ascending"
    });
    expect(deterministicTailDecidedThisPick(walked.decisions[0]!)).toBe(true);
  });
});

async function plantDegreeWalk(options: Readonly<{
  readonly coverSlots?: RecallEvidenceProjectionMatchReceipt["fact_slots"];
  readonly coverContent?: string;
  readonly omitEvidenceRefs?: boolean;
}> = {}) {
  const distractor = candidate(DISTRACTOR_ID, "noise about weather");
  const cover = candidate(
    COVER_ID,
    options.coverContent ?? "an undergraduate degree",
    options.omitEvidenceRefs === true ? [] : ["evidence-degree"]
  );
  const utilities = buildProductionSetUtilities({
    candidates: [distractor, cover],
    supplementaryData: await supplementary(
      cover,
      options.coverSlots ?? degreeSlots(),
      options.omitEvidenceRefs === true
    )
  });
  const distractorKey = buildRecallCandidateDedupeKey(distractor);
  const coverKey = buildRecallCandidateDedupeKey(cover);
  const coverUtility = utilities.get(coverKey)!;
  const distractorUtility = utilities.get(distractorKey)!;
  const result = walkShadowCapture({
    candidates: [
      walkCandidate(distractorUtility),
      walkCandidate(coverUtility)
    ],
    psi: () => false,
    token_budget: 10_000,
    per_dimension_limits: null
  });
  expect(isCapturedWalk(result)).toBe(true);
  if (!isCapturedWalk(result)) throw new Error("expected captured walk");
  return {
    coverKey,
    distractorKey,
    cover: coverUtility,
    distractor: distractorUtility,
    walked: result
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
  cover: CoarseRecallCandidate,
  slots: RecallEvidenceProjectionMatchReceipt["fact_slots"],
  omitEvidenceRefs: boolean = false
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
    evidenceProjectionMatchesByRef: omitEvidenceRefs
      ? {}
      : {
        [evidenceRef]: [projection(evidenceRef, slots)]
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

function appleSlots(): RecallEvidenceProjectionMatchReceipt["fact_slots"] {
  return [
    { role: "subject", text: "Bob" },
    { role: "relation", text: "likes" },
    { role: "value", text: "a red apple" }
  ];
}
