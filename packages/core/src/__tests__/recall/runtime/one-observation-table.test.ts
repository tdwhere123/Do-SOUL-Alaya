import { describe, expect, it } from "vitest";
import { hashMemoryContent } from "../../../embedding-recall/helpers.js";
import {
  orderByCoverageMarginalGain,
  resolveCoverageIdentity
} from "../../../recall/delivery/coverage-selection.js";
import { resolveCandidateCoverageReceipt } from
  "../../../recall/delivery/fine-assessment-selection/coverage-atoms.js";
import { resolveRecallCandidateSemanticActivation } from
  "../../../recall/scoring/activation/candidate-semantic-activation-context.js";
import {
  evidenceSemanticScoreFromObservations,
  scoredObservationTable
} from "../../../recall/scoring/observation-table.js";
import { evidenceSemanticActivation } from
  "../fixtures/evidence-semantic-activation.js";
import {
  createCandidate,
  createSupplementaryData
} from "../fine-assessment-selection-fixtures.js";

const OBJECT_KEY = "workspace_local:memory_entry:mem-1";
const OWNER_PROJECTION = Object.freeze({
  projection_id: null,
  projection_kind: "owner" as const,
  matched_fact_key_forms: Object.freeze([])
});

describe("one observation table", () => {
  it("carries sibling rows with attributable identity on the scored surface", () => {
    const sharedHash = hashMemoryContent("shared evidence");
    const receipt = evidenceSemanticActivation(0.8, {
      evidenceObjectId: "evidence-1",
      documentIdentity: "owner_gist_600",
      contentHash: sharedHash,
      projection: OWNER_PROJECTION
    }, [{
      score: 0.4,
      evidenceObjectId: "evidence-1",
      documentIdentity: "owner",
      contentHash: sharedHash,
      projection: OWNER_PROJECTION
    }]);

    const table = scoredObservationTable(OBJECT_KEY, receipt);

    expect(table).toEqual([
      {
        objectKey: OBJECT_KEY,
        evidenceObjectId: "evidence-1",
        documentIdentity: "owner_gist_600",
        contentHash: sharedHash,
        projection: OWNER_PROJECTION,
        score: 0.8,
        completeness: "complete"
      },
      {
        objectKey: OBJECT_KEY,
        evidenceObjectId: "evidence-1",
        documentIdentity: "owner",
        contentHash: sharedHash,
        projection: OWNER_PROJECTION,
        score: 0.4,
        completeness: "complete"
      }
    ]);
    expect(table).toHaveLength(2);
    expect(evidenceSemanticScoreFromObservations(receipt)).toBe(0.8);
  });

  it("lets composition read sibling rows instead of the sealed scalar", () => {
    const receipt = Object.freeze({
      ...evidenceSemanticActivation(0.1, {
        evidenceObjectId: "evidence-1",
        documentIdentity: "owner",
        projection: OWNER_PROJECTION
      }, [{
        score: 0.8,
        evidenceObjectId: "evidence-1",
        documentIdentity: "owner_gist_600",
        projection: OWNER_PROJECTION
      }]),
      score: 0.1
    });
    const candidate = createCandidate("mem-1");
    const activation = resolveRecallCandidateSemanticActivation(candidate, {
      embeddingSimilarityScores: {},
      evidenceSemanticActivationsByCandidateKey: new Map([
        [candidate.fusion.candidate_key, receipt]
      ])
    });

    expect(receipt.score).toBe(0.1);
    expect(activation.observations.find((row) => row.channel === "evidence_semantic"))
      .toEqual({ channel: "evidence_semantic", state: "observed", score: 0.8 });
    expect(activation.score).toBe(0.8);
  });

  it("lets coverage atoms consume every sibling document identity", () => {
    const candidate = createCandidate("mem-1", { evidence_refs: ["evidence-1"] });
    const receipt = resolveCandidateCoverageReceipt(candidate, {
      embeddingSimilarityScores: {},
      evidenceSemanticActivationsByCandidateKey: new Map([[
        candidate.fusion.candidate_key,
        evidenceSemanticActivation(0.9, {
          evidenceObjectId: "evidence-1",
          documentIdentity: "owner_gist_600",
          projection: OWNER_PROJECTION
        }, [{
          score: 0.4,
          evidenceObjectId: "evidence-2",
          documentIdentity: "owner",
          projection: OWNER_PROJECTION
        }])
      ]]),
      evidenceProjectionMatchesByRef: {}
    });

    expect(receipt.atoms.filter((atom) => atom.kind === "independent_evidence")
      .map((atom) => atom.atom_id)).toEqual([
      "evidence:evidence-1",
      "evidence:evidence-2"
    ]);
  });

  it("keeps gist-text coverage identity so a same-gist pair stays penalized", () => {
    const sharedGistFirst = createCandidate("dup-1");
    const sharedGistSecond = createCandidate("dup-2");
    const novel = createCandidate("novel");
    const supplementary = createSupplementaryData({
      evidenceGistsByMemoryId: {
        "dup-1": "same-gist",
        "dup-2": "same-gist",
        novel: "fresh-gist"
      }
    });
    const current = [sharedGistFirst, sharedGistSecond, novel].map((candidate) =>
      resolveCoverageIdentity(candidate, supplementary)
    );
    const documentKeys = [sharedGistFirst, sharedGistSecond, novel].map((candidate) =>
      `document:${candidate.entry.object_id}:owner_gist_600`
    );

    expect(current[0]?.gistKey).toBe("gist:same-gist");
    expect(current[0]?.gistKey).toBe(current[1]?.gistKey);
    expect(current[2]?.gistKey).toBe("gist:fresh-gist");
    expect(documentKeys[0]).not.toBe(documentKeys[1]);

    const ordered = orderByCoverageMarginalGain({
      candidates: [
        { ...sharedGistFirst, fusion: { ...sharedGistFirst.fusion, fused_score: 0.99 } },
        { ...sharedGistSecond, fusion: { ...sharedGistSecond.fusion, fused_score: 0.98 } },
        { ...novel, fusion: { ...novel.fusion, fused_score: 0.5 } }
      ],
      relevanceByCandidateKey: new Map([
        [sharedGistFirst.fusion.candidate_key, 0.99],
        [sharedGistSecond.fusion.candidate_key, 0.98],
        [novel.fusion.candidate_key, 0.5]
      ]),
      supplementaryData: supplementary
    });

    expect(ordered.map((candidate) => candidate.entry.object_id)).toEqual([
      "dup-1",
      "novel",
      "dup-2"
    ]);
  });
});
