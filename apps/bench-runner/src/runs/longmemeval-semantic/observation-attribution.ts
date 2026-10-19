import type { SourceGoldUnit } from "../measurement/source-gold-join.js";
import type { SourceSemanticObservation } from "../../../../core-daemon/src/runtime/recall-read-worker/source-semantic-observation.js";
import type { AnswerTurnGold } from "./answer-spans.js";
import type { ConsumerVisibilityMetric, ConsumerVisibilityScore } from "./message-visibility.js";
import { candidatePoolClosed, observationMessageFacts, type ObservationMessageFacts } from "./observation-evidence.js";
export type { ObservationStage, ObservationStageStatus, ObservationReadStatus, ObservationStagePosition,
  ObservationRouteFact, ObservationMessageFacts, ObservationReadInterval, ObservationNativeRoute,
  ObservationPackageFacts } from "./observation-evidence.js";

export const OBSERVATION_ATTRIBUTION_CONTRACT = "longmemeval-observation-attribution-v1" as const;
const ALL_LAYERS = ["H", "L1", "L2", "L3", "L4", "U"] as const;
export type ObservationAttributionLayer = typeof ALL_LAYERS[number];

/** Frozen request scope. Observations from another request, snapshot or index generation never mix. */
export type ObservationCallScope = Readonly<{
  kind: "prepare_query" | "recall" | "continuation";
  request_id: number | null;
  query_key: string;
  snapshot_id: string;
  index_generation: string;
}>;
/** The parent's admitted root map is keyed by bare record identity; the value carries the full binding. */
export type ObservationAdmittedRoot = Readonly<{
  record_id: string; source_id: string; snapshot_id: string; index_generation: string; identity: SourceGoldUnit;
}>;
export type ObservationAttributionInput = Readonly<{
  question_id: string; k: 5 | 10; call: ObservationCallScope;
  observations: readonly SourceSemanticObservation[];
  admitted_roots: ReadonlyMap<string, ObservationAdmittedRoot>;
  /** True only when the map exhausts admitted roots for the frozen snapshot, not index eligibility. */
  admitted_roots_complete: boolean;
  answer_gold: AnswerTurnGold; visibility: ConsumerVisibilityScore;
}>;
export type ObservationAttribution = Readonly<{
  contract: typeof OBSERVATION_ATTRIBUTION_CONTRACT;
  question_id: string; metric: "any_at_5" | "any_at_10";
  layer: ObservationAttributionLayer; reason: string;
  observation: Readonly<{
    status: "usable" | "missing" | "ambiguous" | "unavailable" | "partial" | "overflow" | "failure" | "not_observed";
    request_id: number | null; execution: "success" | "failure" | "unknown";
    complete: boolean; dropped_events: number; issues: readonly string[];
  }>;
  messages: readonly ObservationMessageFacts[];
  opportunities: Readonly<{ L1: boolean; L2: boolean; L3: boolean; L4: boolean;
    legal_delivery_bound: "unknown_no_sufficient_evidence_sets" }>;
  partition: Readonly<{ denominator: 1 } & Record<ObservationAttributionLayer, number>>;
  support_sufficiency: "not_measured_no_sufficient_evidence_sets";
}>;

/** Question partition only. Per-evidence facts preserve native routes; the shared scorer alone
 * owns final consumer visibility. Diagnostic membership is never a visibility substitute. */
export function attributeObservation(input: ObservationAttributionInput): ObservationAttribution {
  const correlated = correlate(input.observations, input.call);
  const frame = correlated.frame;
  const observation = observationState(frame, correlated.problem);
  const events = frame?.events ?? [];
  const complete = observation.complete;
  const poolClosed = complete && candidatePoolClosed(events);
  const any = input.visibility[input.k === 5 ? "any_at_5" : "any_at_10"];
  const all = input.visibility[input.k === 5 ? "all_at_5" : "all_at_10"];
  // Aggregate scorer facts can prove all messages visible or all absent, not which one of a mixed set hit.
  const delivery = all.status === "hit" ? "passed" : any.status === "miss" ? "failed" : "unknown";
  const messages = input.answer_gold.spans.map(span => observationMessageFacts(span, input, events, complete, poolClosed, delivery));
  const decided = attributeLayer(messages, any, input.admitted_roots_complete, poolClosed, complete);
  const opportunities = {
    L1: any.status === "miss" && input.admitted_roots_complete && messages.some(message => message.admission === "not_admitted"),
    L2: any.status === "miss" && poolClosed && messages.some(message => message.eligibility === "passed" && message.candidate === "absent"),
    L3: any.status === "miss" && messages.some(message => message.candidate === "present"
      && message.read !== "whole" && message.read !== "unknown"),
    L4: any.status === "miss" && messages.some(message => message.read === "whole"),
    legal_delivery_bound: "unknown_no_sufficient_evidence_sets" as const
  };
  return { contract: OBSERVATION_ATTRIBUTION_CONTRACT, question_id: input.question_id,
    metric: input.k === 5 ? "any_at_5" : "any_at_10", layer: decided.layer, reason: decided.reason,
    observation, messages, opportunities,
    partition: { denominator: 1, H: decided.layer === "H" ? 1 : 0, L1: decided.layer === "L1" ? 1 : 0,
      L2: decided.layer === "L2" ? 1 : 0, L3: decided.layer === "L3" ? 1 : 0,
      L4: decided.layer === "L4" ? 1 : 0, U: decided.layer === "U" ? 1 : 0 },
    support_sufficiency: "not_measured_no_sufficient_evidence_sets" };
}

/** Question-exclusive partition; opportunity tables are intentionally not summed here. */
export function summarizeObservationAttribution(rows: readonly ObservationAttribution[]) {
  const counts = Object.fromEntries(ALL_LAYERS.map(layer =>
    [layer, rows.filter(row => row.layer === layer).length])) as Record<ObservationAttributionLayer, number>;
  const denominator = rows.length;
  return { contract: OBSERVATION_ATTRIBUTION_CONTRACT, denominator, ...counts,
    conserved: denominator === ALL_LAYERS.reduce((sum, layer) => sum + counts[layer], 0) };
}

/** The deepest proven progress across all gold wins; unknown deeper progress blocks shallow losses. */
function attributeLayer(messages: readonly ObservationMessageFacts[], any: ConsumerVisibilityMetric,
  admittedComplete: boolean, poolClosed: boolean, complete: boolean): Readonly<{
    layer: ObservationAttributionLayer; reason: string;
  }> {
  if (any.status === "hit") return { layer: "H", reason: "shared_scorer_any_visible" };
  if (any.status === "unknown") return { layer: "U", reason: `visibility_unknown:${any.reason ?? "unstated"}` };
  if (messages.some(message => message.read === "whole")) {
    return { layer: "L4", reason: "whole_message_read_but_shared_scorer_not_visible" };
  }
  if (!complete) return { layer: "U", reason: "observation_incomplete_deeper_read_unknown" };
  if (messages.some(message => message.read === "unknown")) return { layer: "U", reason: "gold_progress_unknown" };
  if (messages.some(message => message.candidate === "present")) {
    return { layer: "L3", reason: "gold_in_candidate_pool_without_whole_message_read" };
  }
  if (admittedComplete && messages.length > 0 && messages.every(message => message.admission === "not_admitted")) {
    return { layer: "L1", reason: "gold_not_in_complete_frozen_snapshot_admission" };
  }
  if (messages.some(message => message.candidate === "unknown")) return { layer: "U", reason: "candidate_pool_progress_unknown" };
  if (poolClosed && messages.some(message => message.eligibility === "passed")) {
    return { layer: "L2", reason: "index_eligible_gold_absent_from_closed_candidate_pool" };
  }
  return { layer: "U", reason: "per_message_index_eligibility_unavailable" };
}

function correlate(observations: readonly SourceSemanticObservation[], call: ObservationCallScope): Readonly<{
  frame: SourceSemanticObservation | null; problem: string | null;
}> {
  if (call.request_id === null) return { frame: null, problem: "observation_request_unscoped" };
  const matches = observations.filter(observation => observation.request_id === call.request_id);
  if (matches.length === 0) return { frame: null, problem: "observation_missing_for_request" };
  if (matches.length > 1) return { frame: null, problem: "ambiguous_observation_request" };
  return { frame: matches[0]!, problem: null };
}
function observationState(frame: SourceSemanticObservation | null, problem: string | null): ObservationAttribution["observation"] {
  if (frame === null) return { status: problem === "ambiguous_observation_request" ? "ambiguous" : "missing",
    request_id: null, execution: "unknown", complete: false, dropped_events: 0, issues: problem === null ? [] : [problem] };
  return { status: frame.status === "observed" ? "usable" : frame.status,
    request_id: frame.request_id, execution: frame.execution,
    complete: frame.status === "observed" && frame.execution === "success" && frame.dropped_events === 0
      && frame.aggregates_complete && frame.issues.length === 0,
    dropped_events: frame.dropped_events, issues: frame.issues };
}
