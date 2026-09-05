import { describe, expect, it } from "vitest";
import { compileRecallQueryProbes } from
  "../../../../recall/query/recall-query-probes.js";
import { buildProductionSetUtilities } from
  "../../../../recall/decision/prefix-capture/utility/production.js";
import { buildRecallCandidateDedupeKey } from
  "../../../../recall/runtime/recall-service-helpers.js";
import { evidenceSemanticActivation } from
  "../../fixtures/evidence-semantic-activation.js";
import { parseCoreKnownNoWitness } from
  "../../../../recall/decision/prefix-capture/receipts.js";
import type {
  CoarseRecallCandidate,
  RecallSupplementaryData
} from "../../../../recall/runtime/recall-service-types.js";
import { createMemoryEntry } from "../../recall-service-test-fixtures.js";

describe("production capture set utility states", () => {
  it("keeps unobserved producer absence unknown and unavailable", () => {
    const utility = onlyUtility(candidate("candidate-a"), supplementary());

    expect(utility.obligations.length).toBeGreaterThan(0);
    expect(utility.obligations.every((row) =>
      row.availability === "not_observed" && row.cover === 0 && !row.evaluated)).toBe(true);
    expect(utility.values).toEqual({ status: "unavailable", values: [] });
    expect(utility.cid).toMatchObject({ status: "available", grounding: "content" });
  });

  it("keeps content-owned miss known_zero only when semantic completeness is complete", () => {
    const item = candidate("candidate-a", [], "I bought a bike");
    const key = buildRecallCandidateDedupeKey(item);
    const complete = onlyUtility(item, supplementary(undefined, new Map([
      [key, evidenceSemanticActivation(0)]
    ])));
    const unobserved = onlyUtility(item, supplementary());

    expect(complete.obligations.every((row) =>
      row.availability === "known_zero" && row.cover === 0 && row.evaluated)).toBe(true);
    expect(unobserved.obligations.every((row) =>
      row.availability === "not_observed" && row.cover === 0 && !row.evaluated)).toBe(true);
    expect(unobserved.availability.facility).toBe("unavailable");
    expect(complete.availability.facility).not.toBe("unavailable");
  });

  it("emits known-zero only for a complete evaluated producer", () => {
    const item = candidate("candidate-a");
    const key = buildRecallCandidateDedupeKey(item);
    const utility = onlyUtility(item, supplementary(undefined, new Map([
      [key, evidenceSemanticActivation(0)]
    ])));
    expect(utility.obligations.every((row) =>
      row.availability === "known_zero" && row.cover === 0 && row.evaluated)).toBe(true);
  });

  it("distinguishes composed no-match from unavailable and correlates aliases", () => {
    const a = candidate("candidate-a", ["evidence-a"], "Equivalent evidence");
    const b = candidate("candidate-b", ["evidence-b"], "Equivalent evidence");
    const data = supplementary({
      status: "composed" as const,
      truncated: false,
      variable_collections: [{
        variable_id: "answer",
        observation_count: 1,
        distinct_value_count: 1,
        values: [{
          semantic_identity: "other-value",
          surfaces: ["Other"],
          evidence_ids: ["evidence-other"]
        }]
      }]
    } as unknown as RecallSupplementaryData["openSemanticFactorComposition"]);
    const utilities = buildProductionSetUtilities({ candidates: [a, b], supplementaryData: data });
    const rows = [...utilities.values()];

    expect(rows.map((row) => row.values.status)).toEqual(["no_match", "no_match"]);
    expect(rows[0]?.cid).toMatchObject({ status: "available", grounding: "content" });
    expect(rows[0]?.cid.status === "available" ? rows[0].cid.cid : "")
      .toMatch(/^content:sha256:[0-9a-f]{64}$/u);
    expect(rows[1]?.cid).toEqual(rows[0]?.cid);
  });

  it("keeps positive cover and known-no-witness distinct from unavailable", () => {
    const data = supplementary();
    const utility = onlyUtility(candidate("missing-object"), {
      ...data,
      queryProbes: Object.freeze({
        ...data.queryProbes,
        object_ids: Object.freeze(["missing-object", "other-object"])
      })
    });
    expect(utility.obligations.some((row) =>
      row.availability === "available" && row.cover > 0 && row.evaluated)).toBe(true);
    expect(utility.availability.facility).toBe("partially_unavailable");
    expect(parseCoreKnownNoWitness({
      witness: "values",
      core_candidate_key: utility.candidate_key,
      status: "available_known_absent",
      basis: "composed without pair"
    }).status).toBe("available_known_absent");
    expect(() => parseCoreKnownNoWitness({
      witness: "values",
      core_candidate_key: utility.candidate_key,
      status: "unavailable",
      basis: "composition missing"
    })).toThrow(/cannot prove exclusivity/u);
  });

  it("keeps truncated Values unknown and neutral", () => {
    const utility = onlyUtility(candidate("candidate-a", ["evidence-a"]), supplementary({
      status: "composed", truncated: true, variable_collections: []
    } as unknown as RecallSupplementaryData["openSemanticFactorComposition"]));
    expect(utility.values).toEqual({ status: "truncated", values: [] });
  });

  it("does not let evidence refs override canonical content identity", () => {
    const partial = candidate("partial", ["evidence-a"], "Equivalent evidence");
    const ambiguous = candidate("ambiguous", ["evidence-b", "evidence-a"], "Equivalent evidence");
    const rows = [...buildProductionSetUtilities({
      candidates: [partial, ambiguous], supplementaryData: supplementary()
    }).values()];
    expect(rows[0]?.cid).toEqual(rows[1]?.cid);
  });

  it("does not treat source or document identity as CID novelty", () => {
    const first = {
      ...candidate("first", [], "Equivalent evidence"),
      evidenceSourceIdentity: "source-a", evidenceDocumentIdentity: "document-a"
    };
    const second = {
      ...candidate("second", [], "Equivalent evidence"),
      evidenceSourceIdentity: "source-b", evidenceDocumentIdentity: "document-b"
    };
    const rows = [...buildProductionSetUtilities({
      candidates: [first, second], supplementaryData: supplementary()
    }).values()];
    expect(rows[0]?.cid).toMatchObject({ status: "available", grounding: "content" });
    expect(rows[1]?.cid).toEqual(rows[0]?.cid);
  });
});

function onlyUtility(
  item: CoarseRecallCandidate,
  data: RecallSupplementaryData
) {
  return [...buildProductionSetUtilities({ candidates: [item], supplementaryData: data }).values()][0]!;
}

function candidate(
  objectId: string,
  evidenceRefs: readonly string[] = [],
  content?: string
): CoarseRecallCandidate {
  return {
    entry: createMemoryEntry({
      object_id: objectId,
      evidence_refs: [...evidenceRefs],
      ...(content === undefined ? {} : { content })
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

function supplementary(
  composition?: RecallSupplementaryData["openSemanticFactorComposition"],
  activations: RecallSupplementaryData["evidenceSemanticActivationsByCandidateKey"] = new Map()
): RecallSupplementaryData {
  const probes = compileRecallQueryProbes("where does the operator work?");
  return {
    queryProbes: Object.freeze({ ...probes, object_ids: Object.freeze(["missing-object"]) }),
    ftsRanks: {}, trigramFtsRanks: {}, synthesisFtsRanks: {}, evidenceFtsRanks: {},
    evidenceProjectionMatchesByRef: {}, sourceProximityScores: {}, sourceCohortKeys: {},
    structuralScores: {}, graphExpansionScores: {}, entitySeedScores: {},
    pathExpansionScores: {}, pathSuppressionScores: {}, embeddingSimilarityScores: {},
    evidenceSemanticActivationsByCandidateKey: activations, graphSupportCounts: {},
    budgetPenaltyFactor: 0, plasticityFactors: {}, graphAndPathColdScore: 0,
    recallsEdgeCount: 0, weightTransferAmount: 0, evidenceGistsByMemoryId: {},
    governanceCeilingByMemoryId: {},
    ...(composition === undefined ? {} : { openSemanticFactorComposition: composition })
  };
}
