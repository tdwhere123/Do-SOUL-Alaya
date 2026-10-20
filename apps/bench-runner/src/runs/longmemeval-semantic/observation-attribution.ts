import type { SourceGoldUnit } from "../measurement/source-gold-join.js";
import type { SourceSemanticNativeFacts } from "../../../../core-daemon/src/runtime/recall-read-worker/source-semantic-provenance.js";
import type { AnswerTurnGold } from "./answer-spans.js";
import type { ConsumerVisibilityMetric, ConsumerVisibilityScore } from "./message-visibility.js";
import { observationMessageFacts, type ObservationMessageFacts } from "./observation-evidence.js";
import { joinObservationFrames, observedFiniteUnion, type ObservationCallScope,
  type ObservationCapturedFrame, type ObservationFrozenIndex } from "./observation-ancestry.js";
export type { ObservationCallScope, ObservationCapturedFrame, ObservationFrozenIndex } from "./observation-ancestry.js";
export type { ObservationStage, ObservationStageStatus, ObservationReadStatus, ObservationStagePosition,
  ObservationRouteFact, ObservationMessageFacts, ObservationReadInterval, ObservationNativeRoute,
  ObservationPackageFacts } from "./observation-evidence.js";

export const OBSERVATION_ATTRIBUTION_CONTRACT = "longmemeval-observation-attribution-v1" as const;
const ALL_LAYERS = ["H", "L1", "L2", "L3", "L4", "U"] as const;
const LOSS_LAYERS = ["L1", "L2", "L3", "L4"] as const;
export type ObservationAttributionLayer = typeof ALL_LAYERS[number];
type LossLayer = typeof LOSS_LAYERS[number];
export type ObservationOpportunityBound = Readonly<{ lower: 0 | 1; upper: 0 | 1; unknown: 0 | 1 }>;
/** Snapshot admission helps resolve bare record events only; it is not index/window eligibility. */
export type ObservationAdmittedRoot = Readonly<{
  record_id: string; source_id: string; snapshot_id: string; identity: SourceGoldUnit;
}>;
export type ObservationAttributionInput = Readonly<{
  question_id: string; k: 5 | 10; call: ObservationCallScope;
  frames: readonly ObservationCapturedFrame[]; frozen_index: ObservationFrozenIndex | null;
  admitted_roots: ReadonlyMap<string, ObservationAdmittedRoot>; admitted_roots_complete: boolean;
  answer_gold: AnswerTurnGold; visibility: ConsumerVisibilityScore;
}>;
export type ObservationAttribution = Readonly<{
  contract: typeof OBSERVATION_ATTRIBUTION_CONTRACT; question_id: string; metric: "any_at_5" | "any_at_10";
  layer: ObservationAttributionLayer; reason: string;
  observation: Readonly<{
    status: string; request_id: number | null; execution: "success" | "failure" | "unknown";
    complete: boolean; dropped_events: number; issues: readonly string[];
    joined_requests: readonly Readonly<{ session_id: string | null; request_id: number; kind: ObservationCallScope["kind"];
      binding: SourceSemanticNativeFacts["binding"]; pool_origin: NonNullable<SourceSemanticNativeFacts["pool"]>["origin"];
      lease_reads: SourceSemanticNativeFacts["lease_reads"]; lease_issues: SourceSemanticNativeFacts["lease_issues"] }>[];
    finite_union_complete: boolean; snapshot_bound: boolean;
  }>;
  messages: readonly ObservationMessageFacts[];
  /** These overlap. Booleans mean proven opportunities; bounds retain unresolved possibilities. */
  opportunities: Readonly<Record<LossLayer, boolean> & { bounds: Readonly<Record<LossLayer, ObservationOpportunityBound>>;
    legal_delivery_bound: "unknown_no_sufficient_evidence_sets" }>;
  partition: Readonly<{ denominator: 1 } & Record<ObservationAttributionLayer, number>>;
  support_sufficiency: "not_measured_no_sufficient_evidence_sets";
}>;

/** Native causal ancestry supplies progress; only the shared scorer supplies final visibility. */
export function attributeObservation(input: ObservationAttributionInput): ObservationAttribution {
  const joined = joinObservationFrames(input.call, input.frames), finite = observedFiniteUnion(joined);
  const frame = joined.target;
  const any = input.visibility[input.k === 5 ? "any_at_5" : "any_at_10"];
  const messages = input.answer_gold.spans.map(span => observationMessageFacts(span, input, joined, finite));
  const decided = attributeLayer(messages, any, joined.complete, input.answer_gold.complete);
  const bounds = Object.fromEntries(LOSS_LAYERS.map(layer => [layer,
    opportunityBound(layer, messages, any, input.answer_gold.complete)])) as Record<LossLayer, ObservationOpportunityBound>;
  return { contract: OBSERVATION_ATTRIBUTION_CONTRACT, question_id: input.question_id,
    metric: input.k === 5 ? "any_at_5" : "any_at_10", layer: decided.layer, reason: decided.reason,
    observation: { status: joined.status === "usable" ? frame?.status === "observed" ? "usable" : frame?.status ?? "unavailable" : joined.status,
      request_id: frame?.request_id ?? null, execution: frame?.execution ?? "unknown", complete: joined.complete,
      dropped_events: joined.frames.reduce((sum, row) => sum + row.observation.dropped_events, 0),
      issues: [...joined.issues, ...joined.frames.flatMap(row => row.observation.issues)],
      joined_requests: joined.frames.map(row => ({ session_id: row.call.session_id, request_id: row.observation.request_id, kind: row.call.kind,
        binding: row.observation.facts?.binding ?? null, pool_origin: row.observation.facts?.pool?.origin ?? null,
        lease_reads: row.observation.facts?.lease_reads ?? [], lease_issues: row.observation.facts?.lease_issues ?? [] })),
      finite_union_complete: finite.complete, snapshot_bound: joined.snapshot_bound }, messages,
    opportunities: { L1: bounds.L1.lower === 1, L2: bounds.L2.lower === 1, L3: bounds.L3.lower === 1, L4: bounds.L4.lower === 1,
      bounds, legal_delivery_bound: "unknown_no_sufficient_evidence_sets" },
    partition: { denominator: 1, H: Number(decided.layer === "H"), L1: Number(decided.layer === "L1"),
      L2: Number(decided.layer === "L2"), L3: Number(decided.layer === "L3"), L4: Number(decided.layer === "L4"), U: Number(decided.layer === "U") },
    support_sufficiency: "not_measured_no_sufficient_evidence_sets" };
}

/** Exclusive losses conserve N. Overlapping opportunities have independent evidence bounds. */
export function summarizeObservationAttribution(rows: readonly ObservationAttribution[]) {
  const counts = Object.fromEntries(ALL_LAYERS.map(layer =>
    [layer, rows.filter(row => row.layer === layer).length])) as Record<ObservationAttributionLayer, number>;
  const opportunities = Object.fromEntries(LOSS_LAYERS.map(layer => [layer, {
    lower: rows.reduce((sum, row) => sum + row.opportunities.bounds[layer].lower, 0),
    upper: rows.reduce((sum, row) => sum + row.opportunities.bounds[layer].upper, 0),
    unknown: rows.reduce((sum, row) => sum + row.opportunities.bounds[layer].unknown, 0)
  }])) as Record<LossLayer, { lower: number; upper: number; unknown: number }>;
  return { contract: OBSERVATION_ATTRIBUTION_CONTRACT, denominator: rows.length, ...counts, opportunities,
    conserved: rows.length === ALL_LAYERS.reduce((sum, layer) => sum + counts[layer], 0) };
}

function attributeLayer(messages: readonly ObservationMessageFacts[], any: ConsumerVisibilityMetric,
  complete: boolean, goldComplete: boolean): Readonly<{ layer: ObservationAttributionLayer; reason: string }> {
  if (any.status === "hit") return { layer: "H", reason: "shared_scorer_any_visible" };
  if (any.status === "unknown") return { layer: "U", reason: `visibility_unknown:${any.reason ?? "unstated"}` };
  if (messages.some(message => message.read === "whole")) return { layer: "L4", reason: "whole_message_read_but_shared_scorer_not_visible" };
  if (!complete) return { layer: "U", reason: "observation_incomplete_deeper_read_unknown" };
  if (!goldComplete || messages.length === 0 || messages.some(message => message.read === "unknown")) {
    return { layer: "U", reason: "gold_progress_unknown" };
  }
  if (messages.some(message => message.candidate === "present")) return { layer: "L3", reason: "gold_in_candidate_pool_without_whole_message_read" };
  if (messages.some(message => message.candidate === "unknown")) return { layer: "U", reason: "candidate_pool_progress_unknown" };
  if (messages.some(message => message.eligibility === "passed")) return { layer: "L2", reason: "index_eligible_gold_absent_from_closed_candidate_pool" };
  if (messages.every(message => message.eligibility === "failed")) return { layer: "L1", reason: "gold_outside_frozen_index_rows_and_windows" };
  return { layer: "U", reason: "per_message_index_eligibility_unavailable" };
}

function opportunityBound(layer: LossLayer, messages: readonly ObservationMessageFacts[],
  any: ConsumerVisibilityMetric, goldComplete: boolean): ObservationOpportunityBound {
  if (any.status === "hit") return { lower: 0, upper: 0, unknown: 0 };
  const statuses = messages.map(message => {
    if (layer === "L1") return message.eligibility === "failed" ? "yes" : message.eligibility === "passed" ? "no" : "unknown";
    if (layer === "L2") return message.eligibility === "failed" || message.candidate === "present" ? "no"
      : message.eligibility === "passed" && message.candidate === "absent" ? "yes" : "unknown";
    if (layer === "L3") return message.candidate === "absent" || message.read === "whole" ? "no"
      : message.candidate === "present" && message.read !== "unknown" ? "yes" : "unknown";
    return message.read === "whole" ? "yes" : message.read === "unknown" ? "unknown" : "no";
  });
  const proven = any.status === "miss" && statuses.includes("yes");
  const possible = statuses.includes("yes") || !goldComplete || statuses.includes("unknown");
  return { lower: proven ? 1 : 0, upper: possible ? 1 : 0, unknown: possible && !proven ? 1 : 0 };
}
