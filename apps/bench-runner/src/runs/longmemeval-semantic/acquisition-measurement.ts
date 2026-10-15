import type { z } from "zod";
import type { measureSemanticChain, ReplaySchema } from "../semantic-chain/replay.js";
import { deliveredSourceSemanticLibraryIntervals } from "../measurement/source-semantic-library-measurement.js";
import { sourceTargetJoinsGold, type SourceGoldUnit } from "../measurement/source-gold-join.js";
import type { AnswerTurnGold } from "./answer-spans.js";

type NativeMeasurement = ReturnType<typeof measureSemanticChain>["result"]["rows"][number];
type NativeReplayRow = z.infer<typeof ReplaySchema>["rows"][number];
export type AcquisitionMetric = Readonly<{ status: "hit" | "miss" | "unknown"; reason: string | null }>;
const unknown = (reason: string): AcquisitionMetric => ({ status: "unknown", reason });
const hit: AcquisitionMetric = { status: "hit", reason: null };
const miss: AcquisitionMetric = { status: "miss", reason: null };
export const ACQUISITION_METRICS = ["source_bearing_any@5", "source_bearing_any@10",
  "answer_span_exposure@5", "answer_span_exposure@10"] as const;
const STAGES = ["source_available", "candidate_pool", "deliverable_window", "admission", "delivery", "consumer_use"] as const;
type Stage = typeof STAGES[number];
type Observation = Readonly<{ stage: Stage; status: "passed" | "failed" | "unknown" | "not_run"; reason: string }>;

type Cost = Readonly<{ status: "known" | "unknown" | "not_run"; unit: string; value: number | null }>;
const unavailableCost: Cost = { status: "unknown", unit: "unobserved", value: null };
const knownCost = (unit: string, value: number | null | undefined): Cost => value == null
  ? { status: "unknown", unit, value: null } : { status: "known", unit, value };

/** No aggregate native counter is silently allocated to a stage, nor to cold start/reuse. */
function measurementCosts(native?: NativeMeasurement) {
  const work = native?.diagnostics?.work;
  return {
    temperature: "unknown" as const,
    components: { write_index: unavailableCost, H_formation: unavailableCost, Q_formation: unavailableCost,
      C_formation: unavailableCost, source_reads: unavailableCost, Field: unavailableCost,
      composition_encoding: unavailableCost, consumer: { status: "not_run", unit: "unobserved", value: null } as Cost },
    observed: {
      preparation_elapsed: knownCost("milliseconds", native?.preparation_elapsed_ms),
      // Includes preparation: these elapsed measurements must not be added together.
      native_elapsed_including_preparation: knownCost("milliseconds", native?.diagnostics?.native_elapsed_ms),
      native_work: knownCost("native_work_units", work?.native_work),
      logical_work: knownCost("logical_work_units", work?.logical_work),
      native_bytes: knownCost("native_bytes", work?.native_bytes),
      native_logical_allocation: knownCost("logical_allocation_bytes", work?.logical_memory_bytes),
      native_rss: knownCost("rss_bytes", work?.rss_bytes),
      evaluator_proof_work: knownCost("work_units", native?.evaluator_usage?.work_units),
      evaluator_proof_allocation: knownCost("logical_allocation_bytes", native?.evaluator_usage?.logical_memory_bytes)
    }
  };
}

function lossAttribution(stages: readonly Observation[]) {
  const firstFailure = stages.find(stage => stage.status === "failed");
  const firstUnknown = stages.find(stage => stage.status === "unknown");
  const priorUnknown = firstUnknown !== undefined && (firstFailure === undefined
    || STAGES.indexOf(firstUnknown.stage) < STAGES.indexOf(firstFailure.stage));
  return { status: priorUnknown ? "unknown" as const : firstFailure !== undefined ? "observed_loss" as const : "no_observed_loss" as const,
    stage: priorUnknown ? null : firstFailure?.stage ?? null,
    earliest_unknown_stage: firstUnknown?.stage ?? null, observed_failed_stage: firstFailure?.stage ?? null };
}

function stageObservations(native: NativeMeasurement | undefined, gold: readonly SourceGoldUnit[],
  sourceHit: boolean, exposure: AcquisitionMetric, complete: boolean): readonly Observation[] {
  if (native?.measurement?.status !== "validated") return STAGES.map(stage => ({ stage,
    status: stage === "consumer_use" ? "not_run" : "unknown", reason: stage === "consumer_use" ? "provider_gated" : "native_admission_unavailable" }));
  const traces = native.preparation_trace ?? [];
  const candidates = traces.flatMap(page => page.access.source_candidates);
  const poolHit = sourceHit || candidates.some(candidate => gold.some(unit => unit.root_id === candidate.record_id));
  const last = traces.at(-1)?.access;
  const poolClosed = last !== undefined && !last.unvisited_sources
    && new Set(candidates.map(candidate => candidate.record_id)).size === last.observed_source_count;
  const exposed = exposure.status === "hit";
  return [
    { stage: "source_available", status: poolHit ? "passed" : "unknown",
      reason: poolHit ? "native_authorized_source_observed" : "publication_preservation_does_not_attest_allowed_read_scope" },
    { stage: "candidate_pool", status: poolHit ? "passed" : poolClosed && complete ? "failed" : "unknown",
      reason: poolHit ? "gold_root_in_native_pool_or_delivery" : poolClosed && complete
        ? "complete_observed_pool_excludes_gold_roots" : "pool_membership_not_fully_observed" },
    { stage: "deliverable_window", status: exposed ? "passed" : "unknown",
      reason: exposed ? "answer_turn_in_admitted_delivered_window" : "archive_does_not_record_all_deliverable_candidate_windows" },
    { stage: "admission", status: sourceHit ? "passed" : "unknown",
      reason: sourceHit ? "gold_root_native_delivery_admitted" : "no_per_gold_exclusion_receipt" },
    { stage: "delivery", status: exposed ? "passed" : exposure.status === "miss" ? "failed" : "unknown",
      reason: exposed ? "answer_turn_exposed" : exposure.reason ?? "answer_turn_not_in_delivered_intervals" },
    { stage: "consumer_use", status: "not_run", reason: "provider_gated" }
  ];
}

/** Only after immutable native output and its existing archive/first-exposure admission.
 * This replay contract retains one page. A continuation pointer is not observed exposure. */
export function measureLongMemEvalAcquisition(input: Readonly<{
  cohort: "answerable" | "abstention";
  sourceGold?: Readonly<{ sourceUnits: readonly SourceGoldUnit[]; complete: boolean }>;
  answerGold?: AnswerTurnGold;
  native?: NativeMeasurement;
  replay?: NativeReplayRow;
  unavailableReason?: string;
}>) {
  const { native, replay, sourceGold, answerGold } = input;
  const measurement = native?.status === "replayed" ? native.measurement : null;
  const intervals = measurement?.status === "validated" && replay?.status === "replayed"
    ? deliveredSourceSemanticLibraryIntervals(measurement, replay.response) : null;
  const unavailable = input.cohort === "abstention" ? "abstention_requires_separate_calibration"
    : intervals === null ? input.unavailableReason ?? "native_delivery_unavailable" : null;
  const source5: AcquisitionMetric = unavailable !== null ? unknown(unavailable)
    : native?.source_bearing_union?.any_at_5.status === "hit" ? hit
    : sourceGold?.complete && native?.source_bearing_union?.any_at_5.status === "miss" ? miss
    : unknown(sourceGold?.complete ? "native_access_or_computation_unresolved" : "source_or_gold_mapping_incomplete");
  const spanHit = intervals?.some(interval => answerGold?.spans.some(span => interval.start <= span.start
    && interval.end >= span.end && sourceTargetJoinsGold({ ...interval, object_kind: "source_evidence" }, span.target))) ?? false;
  const answer5: AcquisitionMetric = unavailable !== null ? unknown(unavailable) : spanHit ? hit
    : !answerGold?.complete ? unknown("answer_turn_mapping_incomplete")
    : native?.source_bearing_union?.any_at_5.status === "hit" || native?.source_bearing_union?.any_at_5.status === "miss" ? miss
    : unknown("native_access_or_computation_unresolved");
  const hasContinuation = measurement?.status === "validated" && measurement.delivered_index.continuation !== null;
  const at10 = (at5: AcquisitionMetric): AcquisitionMetric => at5.status === "hit" ? at5
    : hasContinuation ? unknown("second_page_not_observed") : at5;
  const stages = stageObservations(native, sourceGold?.sourceUnits ?? [], source5.status === "hit", answer5, sourceGold?.complete ?? false);
  // has_answer annotations do not identify a complete sufficient support set (especially multi-hop).
  return { metrics: { "source_bearing_any@5": source5, "source_bearing_any@10": at10(source5),
      "answer_span_exposure@5": answer5, "answer_span_exposure@10": at10(answer5) },
    support_sufficiency: { status: "not_measured" as const, reason: "no_evaluator_frozen_full_support_set" },
    answer_gold: answerGold ?? null,
    delivery: { unit: "roots_in_native_delivery_order", observed_pages: intervals === null ? 0 : 1,
      observed_roots: intervals?.length ?? null, continuation: hasContinuation ? "unobserved" : intervals === null ? "unknown" : "none" },
    stages, earliest_observable_loss: lossAttribution(stages), costs: measurementCosts(native) };
}

export type LongMemEvalAcquisition = ReturnType<typeof measureLongMemEvalAcquisition>;

/** Every selected row remains in every metric denominator, including abstention and unavailable producers. */
export function summarizeLongMemEvalAcquisition(rows: readonly LongMemEvalAcquisition[]) {
  const metrics = Object.fromEntries(ACQUISITION_METRICS.map(name => {
    const hits = rows.filter(row => row.metrics[name].status === "hit").length;
    const misses = rows.filter(row => row.metrics[name].status === "miss").length;
    const unknown = rows.length - hits - misses;
    return [name, { denominator: rows.length, hits, misses, unknown,
      lower_bound: rows.length === 0 ? null : hits / rows.length,
      upper_bound: rows.length === 0 ? null : (hits + unknown) / rows.length }];
  }));
  return { contract: "longmemeval-acquisition-observation-v1", metrics,
    support_sufficiency: { measured: 0, not_measured: rows.length },
    loss_attribution: { denominator: rows.length,
      stages: Object.fromEntries(STAGES.map(stage => [stage, rows.filter(row => row.earliest_observable_loss.stage === stage).length])),
      unknown: rows.filter(row => row.earliest_observable_loss.status === "unknown").length,
      no_observed_loss: rows.filter(row => row.earliest_observable_loss.status === "no_observed_loss").length },
    observed_costs: Object.fromEntries(Object.entries(measurementCosts().observed).map(([name, empty]) => {
      const costs = rows.map(row => row.costs.observed[name as keyof typeof row.costs.observed]);
      const known = costs.filter(cost => cost.status === "known");
      return [name, { unit: empty.unit, known: known.length, unknown: rows.length - known.length,
        known_sum: known.length === 0 || name === "native_rss" ? null : known.reduce((sum, cost) => sum + cost.value!, 0) }];
    })),
    cost_availability: Object.fromEntries(Object.keys(measurementCosts().components).map(component => [component, {
      known: rows.filter(row => row.costs.components[component as keyof typeof row.costs.components].status === "known").length,
      unknown: rows.filter(row => row.costs.components[component as keyof typeof row.costs.components].status === "unknown").length,
      not_run: rows.filter(row => row.costs.components[component as keyof typeof row.costs.components].status === "not_run").length
    }])) };
}
