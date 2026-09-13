import { describe, expect, it } from "vitest";
import { EVIDENCE_DOCUMENT_MAX_OPERATOR_ID } from "../../embedding-recall/constants.js";
import type { EvidenceCandidateScoringReceipt } from "../../embedding-recall/types.js";
import type { RecallEvidenceSemanticActivationReceipt } from "../../recall/runtime/recall-service-results.js";

describe("evidence document max operator id", () => {
  it("accepts the shared operator constant on scoring and recall receipts", () => {
    const scoring: EvidenceCandidateScoringReceipt = {
      schema_version: 1,
      operator_id: EVIDENCE_DOCUMENT_MAX_OPERATOR_ID,
      state: "observed",
      score: 1,
      winner: { score: 1, evidenceObjectId: "e1", documentIdentity: "d1" },
      observations: [],
      observation_completeness: "complete",
      missing_channel_policy: "no_op"
    };
    const recall: RecallEvidenceSemanticActivationReceipt = {
      schema_version: 1,
      operator_id: EVIDENCE_DOCUMENT_MAX_OPERATOR_ID,
      state: "observed",
      score: 1,
      winner: {
        score: 1,
        evidenceObjectId: "e1",
        documentIdentity: "d1",
        projection: null
      },
      observations: [],
      observation_completeness: "complete",
      missing_channel_policy: "no_op"
    };
    expect(scoring.operator_id).toBe(EVIDENCE_DOCUMENT_MAX_OPERATOR_ID);
    expect(recall.operator_id).toBe(EVIDENCE_DOCUMENT_MAX_OPERATOR_ID);
    expect(EVIDENCE_DOCUMENT_MAX_OPERATOR_ID).toBe("evidence_document_max_v1");
  });
});
