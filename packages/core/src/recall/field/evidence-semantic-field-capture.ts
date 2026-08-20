import type {
  EmbeddingProviderPort,
  EvidenceCandidateScoringResult,
  ScoreEvidenceCandidatesParams
} from "../../embedding-recall/types.js";
import {
  createRecallFiniteFieldChannelCapture,
  type RecallFiniteFieldChannelCapture
} from "./finite-field-capture.js";
import { digestRecallFieldIdentity } from "./field-identity.js";

export function buildEvidenceSemanticFieldCapture(params: Readonly<{
  readonly request: Readonly<ScoreEvidenceCandidatesParams>;
  readonly provider: Readonly<EmbeddingProviderPort>;
  readonly result: Readonly<EvidenceCandidateScoringResult>;
}>): RecallFiniteFieldChannelCapture {
  const channel = buildChannel(params.result);
  return createRecallFiniteFieldChannelCapture({
    source_snapshot_digest: digestRecallFieldIdentity({
      workspace_id: params.request.workspaceId,
      run_id: params.request.runId,
      query_text: params.request.queryText,
      provider: {
        kind: params.provider.providerKind,
        model: params.provider.modelId,
        schema_version: params.provider.schemaVersion
      },
      selection_receipt: params.request.selectionReceipt ?? null,
      candidates: candidateInventory(params.request.candidates)
    }),
    channel
  });
}

function buildChannel(result: Readonly<EvidenceCandidateScoringResult>) {
  if (result.status === "not_applicable") {
    return emptyChannel("ineligible");
  }
  if (result.status !== "returned" || result.expectedCount !== result.scoredCount) {
    return emptyChannel("unavailable");
  }
  const ranked = [...result.activationsByCandidateKey]
    .filter(([, receipt]) => Number.isFinite(receipt.score) && receipt.score > 0)
    .sort(([leftKey, left], [rightKey, right]) =>
      right.score - left.score || leftKey.localeCompare(rightKey));
  return Object.freeze({
    channel_id: "evidence_semantic" as const,
    status: "complete" as const,
    depth: ranked.length,
    observations: Object.freeze(ranked.map(([candidateKey, receipt], index) =>
      Object.freeze({
        observation_id: [
          "evidence_semantic",
          candidateKey,
          receipt.winner.evidenceObjectId,
          receipt.winner.documentIdentity
        ].join(":"),
        candidate_key: candidateKey,
        rank: index + 1
      }))),
    unseen_upper_bound: 0
  });
}

function emptyChannel(status: "unavailable" | "ineligible") {
  return Object.freeze({
    channel_id: "evidence_semantic" as const,
    status,
    depth: 0,
    observations: Object.freeze([]),
    unseen_upper_bound: null
  });
}

function candidateInventory(
  candidates: ScoreEvidenceCandidatesParams["candidates"]
) {
  return candidates.map((candidate) => Object.freeze({
    candidate_key: candidate.candidateKey,
    evidence_object_id: candidate.evidenceObjectId,
    document_identity: candidate.documentIdentity,
    content_digest: digestRecallFieldIdentity(candidate.content)
  })).sort((left, right) =>
    left.candidate_key.localeCompare(right.candidate_key) ||
    left.evidence_object_id.localeCompare(right.evidence_object_id) ||
    left.document_identity.localeCompare(right.document_identity));
}
