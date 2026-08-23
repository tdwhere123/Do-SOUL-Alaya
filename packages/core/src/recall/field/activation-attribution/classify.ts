import { StorageTier } from "@do-soul/alaya-protocol";
import {
  splitLexicalTokens,
  type RecallQueryProbes
} from "../../query/recall-query-probes.js";
import type {
  ActivationAttributionAuditRow,
  ActivationAttributionChannel,
  ActivationAttributionChannelReceipt,
  ActivationAttributionEvidenceObservation,
  ActivationAttributionPathObservation,
  ActivationAttributionProximityObservation,
  ActivationAttributionReason,
  ActivationAttributionStatus
} from "./types.js";

const SPEAKER_LANGUAGE = /\b(?:who said|speaker|told me)\b/iu;

export function classifyActivationAttributionChannels(
  row: ActivationAttributionAuditRow,
  probes: Readonly<RecallQueryProbes>
): readonly Readonly<ActivationAttributionChannelReceipt>[] {
  return Object.freeze([
    classifyQueryProbes(row.gold_surface, probes),
    classifySlice(row.slice),
    classifyPath(row.path),
    classifyEvidence(row.evidence),
    classifyDate(probes),
    classifySpeaker(row.query_text),
    classifySourceProximity(row.source_proximity)
  ]);
}

function classifyQueryProbes(
  goldSurface: string | null | undefined,
  probes: Readonly<RecallQueryProbes>
): ActivationAttributionChannelReceipt {
  if (probes.normalized_query === null) {
    return receipt("query_probes", "not_applicable", "empty_query");
  }
  if (goldSurface === undefined || goldSurface === null) {
    return receipt("query_probes", "unavailable", "no_gold_surface");
  }
  if (!hasRetrievalProbeOverlap(probes, goldSurface)) {
    return receipt("query_probes", "zero_match", "no_retrieval_probe_overlap");
  }
  return receipt("query_probes", "missing_attribution", "receipt_attribution_partial");
}

function classifySlice(
  slice: ActivationAttributionAuditRow["slice"]
): ActivationAttributionChannelReceipt {
  if (slice === undefined) {
    return receipt("slice_compatibility", "unavailable", "slice_unobserved");
  }
  if (slice === "pass_through") {
    return receipt("slice_compatibility", "not_applicable", "slice_pass_through");
  }
  return receipt("slice_compatibility", "zero_match", "slice_no_match");
}

function classifyPath(
  path: ActivationAttributionPathObservation | undefined
): ActivationAttributionChannelReceipt {
  if (path === undefined) {
    return receipt("path_inflow", "unavailable", "path_unobserved");
  }
  if (!path.eligible) {
    return receipt("path_inflow", "not_applicable", "path_not_eligible");
  }
  if (path.availability === "unavailable" || path.availability === "storage_error") {
    return receipt("path_inflow", "unavailable", "path_index_unavailable");
  }
  if ((path.inflow_count ?? 0) <= 0) {
    return receipt("path_inflow", "not_applicable", "path_no_inflow");
  }
  if ((path.a_path ?? 0) <= 0) {
    return receipt("path_inflow", "zero_match", "path_no_fuel");
  }
  return receipt("path_inflow", "not_applicable", "path_attributed_fuel");
}

function classifyEvidence(
  evidence: ActivationAttributionEvidenceObservation | undefined
): ActivationAttributionChannelReceipt {
  if (evidence === undefined) {
    return receipt("evidence_support", "unavailable", "evidence_unobserved");
  }
  if (!evidence.vectors_present) {
    return receipt("evidence_support", "unavailable", "evidence_vectors_absent");
  }
  if ((evidence.support ?? 0) <= 0) {
    return receipt("evidence_support", "zero_match", "evidence_no_support");
  }
  return receipt("evidence_support", "not_applicable", "evidence_attributed_fuel");
}

function classifyDate(
  probes: Readonly<RecallQueryProbes>
): ActivationAttributionChannelReceipt {
  if (probes.date_terms.length === 0) {
    return receipt("date", "not_applicable", "no_date_language");
  }
  // Date language is compiled onto Q_q; it is not attributed flood fuel.
  return receipt("date", "missing_attribution", "date_not_flood_fuel");
}

function classifySpeaker(queryText: string): ActivationAttributionChannelReceipt {
  if (!SPEAKER_LANGUAGE.test(queryText)) {
    return receipt("speaker", "not_applicable", "no_speaker_language");
  }
  return receipt("speaker", "missing_attribution", "speaker_not_flood_fuel");
}

function classifySourceProximity(
  proximity: ActivationAttributionProximityObservation | undefined
): ActivationAttributionChannelReceipt {
  if (proximity === undefined) {
    return receipt("source_proximity", "unavailable", "proximity_unobserved");
  }
  if (proximity.tier !== StorageTier.HOT) {
    return receipt("source_proximity", "not_applicable", "proximity_not_hot_substrate");
  }
  if (proximity.seed_count <= 0) {
    return receipt("source_proximity", "not_applicable", "proximity_no_seeds");
  }
  if (proximity.neighbor_count <= 0) {
    return receipt("source_proximity", "zero_match", "proximity_no_neighbors");
  }
  // Omega neighbor admission is not A/G_L/M fuel on the original object.
  return receipt("source_proximity", "missing_attribution", "neighbor_not_flood_fuel");
}

function hasRetrievalProbeOverlap(
  probes: Readonly<RecallQueryProbes>,
  goldSurface: string
): boolean {
  const goldNormalized = goldSurface.trim().toLocaleLowerCase();
  if (goldNormalized.length === 0) return false;
  const goldTokens = new Set(splitLexicalTokens(goldSurface));
  return retrievalProbeValues(probes).some((value) => {
    const normalized = value.toLocaleLowerCase();
    if (normalized.length === 0) return false;
    return goldNormalized.includes(normalized) ||
      splitLexicalTokens(value).some((token) => goldTokens.has(token));
  });
}

function retrievalProbeValues(probes: Readonly<RecallQueryProbes>): readonly string[] {
  return Object.freeze([
    ...probes.lexical_terms,
    ...probes.expanded_terms,
    ...probes.phrases,
    ...probes.date_terms,
    ...probes.object_ids,
    ...probes.evidence_refs,
    ...probes.domain_tags
  ]);
}

function receipt(
  channel: ActivationAttributionChannel,
  status: ActivationAttributionStatus,
  reason: ActivationAttributionReason
): ActivationAttributionChannelReceipt {
  return Object.freeze({ channel, status, reason });
}
