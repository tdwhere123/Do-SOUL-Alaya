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
  RecallSupplementaryData
} from "../../../recall/runtime/recall-service-types.js";
import { createMemoryEntry } from "../recall-service-test-fixtures.js";

const QUERY = "What I volunteer";
const DISTRACTOR_ID = "aaa-none";
const COVER_ID = "zzz-volunteer";

describe("answer-assertion remainder join", () => {
  it("picks the covering volunteer assertion under empty Psi", async () => {
    const distractor = memory(DISTRACTOR_ID, "noise about weather");
    const cover = memory(COVER_ID, "I volunteered at the clinic");
    const utilities = buildProductionSetUtilities({
      candidates: [distractor, cover],
      supplementaryData: await frameSupplementary(QUERY, [
        { role: "value", text: "What" },
        { role: "subject", text: "I" },
        { role: "relation", text: "volunteer" }
      ])
    });
    const distractorKey = buildRecallCandidateDedupeKey(distractor);
    const coverKey = buildRecallCandidateDedupeKey(cover);
    const coverUtility = utilities.get(coverKey)!;
    const distractorUtility = utilities.get(distractorKey)!;

    expect(distractorKey < coverKey).toBe(true);
    expect(coverUtility.obligations.some((row) =>
      row.key.kind === "relation" && row.key.value === "volunteer" &&
      row.availability === "available" && row.cover > 0
    )).toBe(true);
    expect(distractorUtility.obligations.filter((row) =>
      row.key.kind === "relation" && row.key.value === "volunteer"
    ).every((row) => row.cover === 0)).toBe(true);

    const universe = obligationUniverseFrom([coverUtility, distractorUtility]);
    const empty = emptySelectedSet();
    const coverG = computeGammaTuple(coverUtility, empty, universe);
    const distractorG = computeGammaTuple(distractorUtility, empty, universe);
    expect(coverG.unscaled_remainder).toBeGreaterThan(0);
    expect(distractorG.unscaled_remainder).toBe(0);

    const walked = walkShadowCapture({
      candidates: [walkCandidate(distractorUtility), walkCandidate(coverUtility)],
      psi: () => false,
      token_budget: 10_000,
      per_dimension_limits: null
    });
    expect(isCapturedWalk(walked)).toBe(true);
    if (!isCapturedWalk(walked)) throw new Error("expected captured walk");
    expect(walked.S_infty[0]).toBe(coverKey);
    expect(walked.decisions[0]).toMatchObject({
      candidate_key: coverKey,
      G: coverG,
      max_g_cohort: [coverKey]
    });
    expect(deterministicTailDecidedThisPick(walked.decisions[0]!)).toBe(false);
  });

  it("covers qualifier Japan from owned value-slot content under empty Psi", async () => {
    const distractor = memory(DISTRACTOR_ID, "noise about weather");
    const cover = memory("zzz-japan", "I was in Japan for two weeks");
    const utilities = buildProductionSetUtilities({
      candidates: [distractor, cover],
      supplementaryData: await frameSupplementary("What I visit Japan", [
        { role: "value", text: "What" },
        { role: "subject", text: "I" },
        { role: "relation", text: "visit" },
        { role: "qualifier", text: "Japan" }
      ])
    });
    const distractorKey = buildRecallCandidateDedupeKey(distractor);
    const coverKey = buildRecallCandidateDedupeKey(cover);
    const coverUtility = utilities.get(coverKey)!;
    const distractorUtility = utilities.get(distractorKey)!;

    expect(distractorKey < coverKey).toBe(true);
    expect(coverUtility.obligations.some((row) =>
      row.key.kind === "entity" && row.key.value === "japan" &&
      row.availability === "available" && row.cover > 0
    )).toBe(true);
    expect(distractorUtility.obligations.filter((row) =>
      row.key.kind === "entity" && row.key.value === "japan"
    ).every((row) =>
      row.cover === 0 && row.availability === "not_observed" && !row.evaluated
    )).toBe(true);
    expect(distractorUtility.availability.facility).toBe("unavailable");

    const universe = obligationUniverseFrom([coverUtility, distractorUtility]);
    const empty = emptySelectedSet();
    const coverG = computeGammaTuple(coverUtility, empty, universe);
    expect(coverG.unscaled_remainder).toBeGreaterThan(0);
    expect(computeGammaTuple(distractorUtility, empty, universe).unscaled_remainder)
      .toBe(0);

    const walked = walkShadowCapture({
      candidates: [walkCandidate(distractorUtility), walkCandidate(coverUtility)],
      psi: () => false,
      token_budget: 10_000,
      per_dimension_limits: null
    });
    expect(isCapturedWalk(walked)).toBe(true);
    if (!isCapturedWalk(walked)) throw new Error("expected captured walk");
    expect(walked.S_infty[0]).toBe(coverKey);
    expect(deterministicTailDecidedThisPick(walked.decisions[0]!)).toBe(false);
  });

  it("does not cover irregular or unrelated owned relation text", async () => {
    const irregular = memory(COVER_ID, "I went to the clinic");
    const unrelated = memory(DISTRACTOR_ID, "I bought a bike");
    const utilities = buildProductionSetUtilities({
      candidates: [irregular, unrelated],
      supplementaryData: await frameSupplementary("What I go", [
        { role: "value", text: "What" },
        { role: "subject", text: "I" },
        { role: "relation", text: "go" }
      ])
    });
    const irregularUtility = utilities.get(buildRecallCandidateDedupeKey(irregular))!;
    const unrelatedUtility = utilities.get(buildRecallCandidateDedupeKey(unrelated))!;

    expect(irregularUtility.obligations.filter((row) =>
      row.key.kind === "relation" && row.key.value === "go"
    ).every((row) => row.cover === 0)).toBe(true);
    expect(unrelatedUtility.obligations.filter((row) =>
      row.key.kind === "relation" && row.key.value === "go"
    ).every((row) => row.cover === 0)).toBe(true);
  });
});

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

function memory(objectId: string, content: string): CoarseRecallCandidate {
  return {
    entry: createMemoryEntry({
      object_id: objectId,
      content,
      evidence_refs: []
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

async function frameSupplementary(
  queryText: string,
  slots: readonly Readonly<{ readonly role: "value" | "subject" | "relation" | "qualifier"; readonly text: string }>[]
): Promise<RecallSupplementaryData> {
  const capture = await captureRecallQueryFactFrames({
    query_text: queryText,
    port: {
      operator_id: "structured_query_frame_v1",
      extract: async () => [{
        schema_version: 1,
        slots
      }]
    }
  });
  return {
    queryProbes: compileRecallQueryProbes(queryText),
    queryFactFrameExtraction: capture,
    ftsRanks: {}, trigramFtsRanks: {}, synthesisFtsRanks: {}, evidenceFtsRanks: {},
    evidenceProjectionMatchesByRef: {},
    sourceProximityScores: {}, sourceCohortKeys: {},
    structuralScores: {}, graphExpansionScores: {}, entitySeedScores: {},
    pathExpansionScores: {}, pathSuppressionScores: {}, embeddingSimilarityScores: {},
    evidenceSemanticActivationsByCandidateKey: new Map(), graphSupportCounts: {},
    budgetPenaltyFactor: 0, plasticityFactors: {}, graphAndPathColdScore: 0,
    recallsEdgeCount: 0, weightTransferAmount: 0, evidenceGistsByMemoryId: {},
    governanceCeilingByMemoryId: {}
  };
}
