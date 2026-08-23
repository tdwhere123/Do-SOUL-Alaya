import { StorageTier } from "@do-soul/alaya-protocol";
import {
  classifyRecallIntent,
  type RecallQueryIntent
} from "../../query/recall-query-plan.js";
import {
  splitLexicalTokens,
  type RecallQueryProbes
} from "../../query/recall-query-probes.js";
import { QUERY_PROBE_RETRIEVAL_FIELDS } from "./consumers.js";
import { classifyLiveFloodAxes } from "./flood-axes.js";
import type {
  ActivationAttributionAuditRow,
  ActivationAttributionChannel,
  ActivationAttributionChannelReceipt,
  ActivationAttributionProximityObservation,
  ActivationAttributionReason,
  ActivationAttributionStatus
} from "./types.js";
import type { RecallQueryFieldAttributionReceipt } from
  "../query-attribution/query-field-attribution.js";

export function classifyActivationAttribution(
  row: ActivationAttributionAuditRow,
  probes: Readonly<RecallQueryProbes>
): Readonly<{
  readonly channels: readonly Readonly<ActivationAttributionChannelReceipt>[];
  readonly fuel_verified: boolean | null;
  readonly intent: RecallQueryIntent;
}> {
  const flood = classifyLiveFloodAxes({ flood: row.flood, slice: row.slice });
  const intent = classifyRecallIntent(probes);
  return Object.freeze({
    channels: Object.freeze([
      classifyQueryProbes(row, probes),
      flood.slice,
      flood.path,
      flood.evidence,
      classifyDate(probes),
      classifySpeaker(),
      classifySourceProximity(row.source_proximity),
      classifyGuardedUpdate(intent)
    ]),
    fuel_verified: flood.fuel_verified,
    intent
  });
}

function classifyQueryProbes(
  row: ActivationAttributionAuditRow,
  probes: Readonly<RecallQueryProbes>
): ActivationAttributionChannelReceipt {
  if (probes.normalized_query === null) {
    return nonFuel("query_probes", "not_applicable", "empty_query");
  }
  if (row.gold_surface === undefined || row.gold_surface === null) {
    return nonFuel("query_probes", "unavailable", "no_gold_surface");
  }
  if (!hasRetrievalProbeOverlap(probes, row.gold_surface)) {
    return nonFuel("query_probes", "zero_match", "no_gold_surface_overlap");
  }
  return classifyQueryProbeReceipt(row.query_field_attribution);
}

function classifyQueryProbeReceipt(
  receipt: RecallQueryFieldAttributionReceipt | undefined
): ActivationAttributionChannelReceipt {
  if (receipt === undefined) {
    return nonFuel("query_probes", "unavailable", "query_attribution_unobserved");
  }
  if (receipt.attributions.length === 0) {
    return nonFuel("query_probes", "missing_attribution", "receipt_attribution_partial");
  }
  return nonFuel("query_probes", "not_applicable", "gold_surface_overlap");
}

function classifyDate(
  probes: Readonly<RecallQueryProbes>
): ActivationAttributionChannelReceipt {
  if (probes.date_terms.length === 0) {
    return nonFuel("date", "not_applicable", "no_date_language");
  }
  // Date language is Q_q / fusion, not Slice×path×evidence fuel.
  return nonFuel("date", "not_applicable", "date_not_flood_fuel");
}

function classifySpeaker(): ActivationAttributionChannelReceipt {
  // No Q_q speaker field exists; a local regex would be a second query condition.
  return nonFuel("speaker", "not_applicable", "no_speaker_probe");
}

function classifyGuardedUpdate(
  intent: RecallQueryIntent
): ActivationAttributionChannelReceipt {
  if (intent !== "knowledge_update") {
    return nonFuel("guarded_update", "not_applicable", "no_update_language");
  }
  // Live intent is not A/G_L/M fuel and must not close via recency-β.
  return nonFuel("guarded_update", "not_applicable", "guarded_update_not_flood_fuel");
}

function classifySourceProximity(
  proximity: ActivationAttributionProximityObservation | undefined
): ActivationAttributionChannelReceipt {
  if (proximity === undefined) {
    return nonFuel("source_proximity", "unavailable", "proximity_unobserved");
  }
  if (proximity.tier !== StorageTier.HOT) {
    return nonFuel("source_proximity", "not_applicable", "proximity_not_hot_substrate");
  }
  if (proximity.seed_count <= 0) {
    return nonFuel("source_proximity", "not_applicable", "proximity_no_seeds");
  }
  if (proximity.neighbor_count <= 0) {
    return nonFuel("source_proximity", "zero_match", "proximity_no_neighbors");
  }
  // Omega HOT-window membership is not attributed flood fuel.
  return nonFuel("source_proximity", "not_applicable", "neighbor_not_flood_fuel");
}

function hasRetrievalProbeOverlap(
  probes: Readonly<RecallQueryProbes>,
  goldSurface: string
): boolean {
  const goldNormalized = goldSurface.trim().toLocaleLowerCase();
  if (goldNormalized.length === 0) return false;
  const goldTokens = new Set(splitLexicalTokens(goldSurface));
  return retrievalProbeValues(probes).some((value) => {
    const normalized = String(value).toLocaleLowerCase();
    if (normalized.length === 0) return false;
    return goldNormalized.includes(normalized) ||
      splitLexicalTokens(normalized).some((token) => goldTokens.has(token));
  });
}

function retrievalProbeValues(probes: Readonly<RecallQueryProbes>): readonly string[] {
  return Object.freeze(QUERY_PROBE_RETRIEVAL_FIELDS.flatMap((field) =>
    [...probes[field]].map((value) => String(value))
  ));
}

function nonFuel(
  channel: ActivationAttributionChannel,
  status: ActivationAttributionStatus,
  reason: ActivationAttributionReason
): ActivationAttributionChannelReceipt {
  return Object.freeze({
    channel,
    status,
    reason,
    counts_as_fuel: false,
    flood_axis_status: null
  });
}
