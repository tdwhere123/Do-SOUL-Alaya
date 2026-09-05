import type { MemoryEntry } from "@do-soul/alaya-protocol";
import type { RecallQueryProbes } from "../query/recall-query-probes.js";
import {
  clamp01,
  isSynthesisChildCandidate,
  normalizeActivationScore,
  normalizeGraphSupport
} from "../runtime/recall-service-helpers.js";
import { resolveRecallCandidateSemanticActivation } from
  "../scoring/activation/candidate-semantic-activation-context.js";
import {
  scorePreferenceProfileAlignment,
  scoreSelfReferenceAlignment
} from "../scoring/preference-fusion-scoring.js";
import {
  parseQueryTimeWindow,
  scoreTemporalEventTime,
  scoreTemporalQueryWindow
} from "../scoring/temporal-fusion-scoring.js";
import type { RecallFusionStream, RecallSupplementaryData } from "../runtime/recall-service-types.js";
import type { RecallFusionCandidateInput } from "./fusion-delivery-scoring-candidate.js";

export function scoreRecallFusionStream(
  candidate: RecallFusionCandidateInput,
  stream: RecallFusionStream,
  supplementaryData: RecallSupplementaryData,
  nowIso: string,
  candidateKey?: string
): number {
  if (candidate.objectKind === "synthesis_capsule") {
    return scoreSynthesisCapsuleFusionStream(candidate, stream, supplementaryData);
  }
  if (candidate.objectKind === "evidence_capsule") {
    if (stream === "evidence_fts") {
      return clamp01(supplementaryData.evidenceFtsRanks[candidate.entry.object_id] ?? 0);
    }
    if (stream === "embedding_similarity") {
      return resolveSemanticFusionActivation(candidate, supplementaryData, candidateKey);
    }
    return 0;
  }
  if (candidate.originPlane === "global") {
    return scoreGlobalFusionStream(
      candidate,
      stream,
      supplementaryData,
      nowIso,
      candidateKey
    );
  }
  return scoreWorkspaceLocalFusionStream(
    candidate,
    stream,
    supplementaryData,
    nowIso,
    candidateKey
  );
}
function scoreSynthesisCapsuleFusionStream(
  candidate: RecallFusionCandidateInput,
  stream: RecallFusionStream,
  supplementaryData: RecallSupplementaryData
): number {
  return stream === "synthesis_fts" ? clamp01(supplementaryData.synthesisFtsRanks[candidate.entry.object_id] ?? 0) : 0;
}

// A date-like query that cannot be resolved must not silently change meaning to recency.
export function scoreTemporalFusion(
  entry: Readonly<MemoryEntry>,
  queryProbes: Readonly<RecallQueryProbes>,
  nowIso: string
): number {
  const window = parseQueryTimeWindow(queryProbes, nowIso);
  if (window !== null) {
    return scoreTemporalQueryWindow(entry, window, nowIso);
  }
  if (queryProbes.date_terms.length > 0) {
    return 0;
  }
  return scoreTemporalEventTime(entry, nowIso);
}

function scoreGlobalFusionStream(
  candidate: RecallFusionCandidateInput,
  stream: RecallFusionStream,
  supplementaryData: RecallSupplementaryData,
  nowIso: string,
  candidateKey?: string
): number {
  switch (stream) {
    case "subject_alignment":
      return scoreSubjectAlignment(candidate.entry, supplementaryData.queryProbes);
    case "structural":
      return clamp01(candidate.structuralScore ?? 0);
    case "existing_score":
      return clamp01(candidate.effectiveScore);
    case "embedding_similarity":
      return resolveSemanticFusionActivation(candidate, supplementaryData, candidateKey);
    case "temporal_recency":
      return scoreTemporalFusion(candidate.entry, supplementaryData.queryProbes, nowIso);
    case "workspace_activation":
      return normalizeActivationScore(candidate.entry.activation_score);
    default:
      return 0;
  }
}

function scoreWorkspaceLocalFusionStream(
  candidate: RecallFusionCandidateInput,
  stream: RecallFusionStream,
  supplementaryData: RecallSupplementaryData,
  nowIso: string,
  candidateKey?: string
): number {
  const objectId = candidate.entry.object_id;
  switch (stream) {
    case "lexical_fts":
      return clamp01(supplementaryData.ftsRanks[objectId] ?? 0);
    case "trigram_fts":
      return clamp01(supplementaryData.trigramFtsRanks[objectId] ?? 0);
    case "synthesis_fts":
      return isSynthesisChildCandidate(candidate)
        ? clamp01(supplementaryData.synthesisFtsRanks[objectId] ?? 0)
        : 0;
    case "evidence_fts":
      return clamp01(supplementaryData.evidenceFtsRanks[objectId] ?? 0);
    case "evidence_structural_agreement":
      return scoreEvidenceStructuralAgreement(candidate, supplementaryData);
    case "source_proximity":
      return clamp01(supplementaryData.sourceProximityScores[objectId] ?? 0);
    case "source_evidence_agreement":
      return scoreSourceEvidenceAgreement(candidate, supplementaryData);
    case "subject_alignment":
      return scoreSubjectAlignment(candidate.entry, supplementaryData.queryProbes);
    case "structural":
      return clamp01(candidate.structuralScore ?? supplementaryData.structuralScores[objectId] ?? 0);
    case "existing_score":
      return clamp01(candidate.effectiveScore);
    case "embedding_similarity":
      return resolveSemanticFusionActivation(candidate, supplementaryData, candidateKey);
    case "graph_expansion":
      return clamp01(Math.max(
        supplementaryData.graphExpansionScores[objectId] ?? 0,
        normalizeGraphSupport(supplementaryData.graphSupportCounts[objectId] ?? 0)
      ));
    case "entity_seed":
      return clamp01(supplementaryData.entitySeedScores[objectId] ?? 0);
    case "path_expansion":
      return clamp01(supplementaryData.pathExpansionScores[objectId] ?? 0);
    case "temporal_recency":
      return scoreTemporalFusion(candidate.entry, supplementaryData.queryProbes, nowIso);
    case "workspace_activation":
      return normalizeActivationScore(candidate.entry.activation_score);
  }
}

function resolveSemanticFusionActivation(
  candidate: RecallFusionCandidateInput,
  supplementaryData: RecallSupplementaryData,
  candidateKey?: string
): number {
  return resolveRecallCandidateSemanticActivation(
    candidate,
    supplementaryData,
    candidateKey
  ).score ?? 0;
}

function scoreEvidenceStructuralAgreement(
  candidate: RecallFusionCandidateInput,
  supplementaryData: RecallSupplementaryData
): number {
  const objectId = candidate.entry.object_id;
  const evidenceScore = clamp01(supplementaryData.evidenceFtsRanks[objectId] ?? 0);
  const structuralScore = clamp01(candidate.structuralScore ?? supplementaryData.structuralScores[objectId] ?? 0);
  if (evidenceScore <= 0 || structuralScore <= 0) {
    return 0;
  }
  return clamp01(Math.sqrt(evidenceScore * structuralScore) + Math.min(evidenceScore, structuralScore) * 0.1);
}

function scoreSourceEvidenceAgreement(
  candidate: RecallFusionCandidateInput,
  supplementaryData: RecallSupplementaryData
): number {
  const objectId = candidate.entry.object_id;
  const evidenceScore = clamp01(supplementaryData.evidenceFtsRanks[objectId] ?? 0);
  const sourceScore = clamp01(supplementaryData.sourceProximityScores[objectId] ?? 0);
  if (evidenceScore <= 0 || sourceScore <= 0) {
    return 0;
  }
  return clamp01(Math.sqrt(evidenceScore * sourceScore) + Math.min(evidenceScore, sourceScore) * 0.1);
}

function scoreSubjectAlignment(
  entry: Readonly<MemoryEntry>,
  queryProbes: Readonly<RecallQueryProbes>
): number {
  const preferenceScore = scorePreferenceProfileAlignment(entry, queryProbes);
  return Math.max(preferenceScore, scoreSelfReferenceAlignment(entry, queryProbes));
}
