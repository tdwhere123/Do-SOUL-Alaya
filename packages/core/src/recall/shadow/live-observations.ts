import type { MemoryEntry, RecallPolicy } from "@do-soul/alaya-protocol";
import { clamp01 } from "../../shared/clamp.js";
import { compileRecallQueryDemand } from "../query/recall-query-demand.js";
import type { RecallQueryProbes } from "../query/recall-query-probes.js";
import { buildRecallCandidateDedupeKey } from "../runtime/recall-service-helpers.js";
import type {
  CoarseRecallCandidate,
  KeywordSearchLaneReceipt,
  RecallSupplementaryData
} from "../runtime/recall-service-types.js";
import {
  parseQueryTimeWindow,
  scoreTemporalEventTime,
  scoreTemporalQueryWindow,
  type QueryTimeWindow
} from "../scoring/temporal-fusion-scoring.js";
import { shadowLineageApplicability, type ShadowLineageApplicability } from "./demand.js";
import { freezeShadow } from "./envelope.js";
import {
  parsePointwiseObservation,
  type LexLaneId,
  type ShadowLineageId,
  type ShadowPointwiseObservation,
  type ShadowTemporalDomain,
  type ShadowTemporalEvaluator
} from "./observations.js";
import type { ShadowPsiObservationField } from "./psi.js";

const MERGE_LANES = ["exact", "porter", "trigram"] as const;
const LANE_PRIORITY: Readonly<Record<(typeof MERGE_LANES)[number], number>> = {
  exact: 0,
  porter: 1,
  trigram: 2
};
const LIVE_EMB_DOMAIN = freezeShadow({
  provider_kind: "recall.live",
  model_id: "embeddingSimilarityScores",
  dimensions: 1,
  schema_version: 1
});

export type LiveObservationSource = Readonly<{
  readonly candidates: readonly Readonly<CoarseRecallCandidate>[];
  readonly policy: Readonly<RecallPolicy>;
  readonly supplementaryData: RecallSupplementaryData;
  readonly memoryKeywordLanes?: readonly Readonly<KeywordSearchLaneReceipt>[];
  readonly nowIso?: string;
}>;

type LiveContext = Readonly<{
  readonly applicable: ShadowLineageApplicability;
  readonly lanes: readonly Readonly<KeywordSearchLaneReceipt>[];
  readonly scores: Readonly<Record<string, number>>;
  readonly probes: Readonly<RecallQueryProbes>;
  readonly nowIso: string | undefined;
  readonly clockOk: boolean;
  readonly window: QueryTimeWindow | null;
  readonly parseState: ShadowTemporalEvaluator["parse_state"];
  readonly queryId: string;
}>;

type LexHit = Readonly<{
  readonly lane_id: (typeof MERGE_LANES)[number];
  readonly normalized_rank: number;
  readonly list_n: number;
  readonly status: "complete" | "truncated";
}>;

export function buildLiveObservationField(
  input: LiveObservationSource
): ShadowPsiObservationField {
  const context = liveContext(input);
  const field: Record<string, ShadowPsiObservationField[string]> = {};
  for (const candidate of input.candidates) {
    field[buildRecallCandidateDedupeKey(candidate)] = freezeShadow({
      h_gate: "none" as const,
      lineages: liveLineages(candidate, context)
    });
  }
  return field;
}

export function liveLexicalMapping(
  field: ShadowPsiObservationField
): "lane_receipts" | "not_observed" {
  for (const view of Object.values(field)) {
    if (view?.lineages.lexical?.envelope.state === "observed") return "lane_receipts";
  }
  return "not_observed";
}

function liveContext(input: LiveObservationSource): LiveContext {
  const probes = input.supplementaryData.queryProbes;
  const nowIso = input.nowIso;
  const clockOk = nowIso !== undefined && Number.isFinite(Date.parse(nowIso));
  const window = input.supplementaryData.queryTimeWindow ??
    parseQueryTimeWindow(probes, nowIso);
  return freezeShadow({
    applicable: shadowLineageApplicability({
      demand: compileRecallQueryDemand(probes),
      probes,
      arm: input.policy.coarse_filter.semantic_supplement.embedding_enabled === true
        ? "E1"
        : "E0"
    }),
    lanes: input.memoryKeywordLanes ?? Object.freeze([]),
    scores: input.supplementaryData.embeddingSimilarityScores,
    probes,
    nowIso,
    clockOk,
    window,
    parseState: temporalParseState(probes, window),
    queryId: liveQueryId(probes)
  });
}

function liveLineages(
  candidate: Readonly<CoarseRecallCandidate>,
  context: LiveContext
): Readonly<Partial<Record<ShadowLineageId, ShadowPointwiseObservation>>> {
  const lineages: Partial<Record<ShadowLineageId, ShadowPointwiseObservation>> = {};
  if (context.applicable.lexical) {
    lineages.lexical = liveLexical(candidate.entry.object_id, context.lanes);
  }
  if (context.applicable.embedding) {
    lineages.embedding = liveEmbedding(candidate.entry.object_id, context.scores);
  }
  if (context.applicable.temporal) {
    lineages.temporal = liveTemporal(candidate.entry, context);
  }
  if (context.applicable.subject_preference) lineages.subject_preference = liveSubject();
  return freezeShadow(lineages);
}

function liveLexical(
  objectId: string,
  lanes: readonly Readonly<KeywordSearchLaneReceipt>[]
): ShadowPointwiseObservation {
  const hit = chooseLexicalHit(objectId, lanes);
  if (hit === null) {
    return parsePointwiseObservation({
      lineage: "lexical",
      receipt: "fts.lexical.observe.v1",
      correlation: "dup:lexical-family",
      envelope: { state: "not_observed", reason: "missing_rank" },
      domain: null
    });
  }
  return parsePointwiseObservation({
    lineage: "lexical",
    receipt: "fts.lexical.observe.v1",
    correlation: "dup:lexical-family",
    envelope: { state: "observed", value: hit.normalized_rank },
    domain: {
      lane_id: hit.lane_id as LexLaneId,
      list_n: hit.list_n,
      status: hit.status,
      raw_key_kind: hit.lane_id === "exact" ? "matched_token_count" : "bm25_raw_rank"
    }
  });
}

function chooseLexicalHit(
  objectId: string,
  lanes: readonly Readonly<KeywordSearchLaneReceipt>[]
): LexHit | null {
  let best: LexHit | null = null;
  for (const lane of lanes) {
    if (!isMergeLane(lane.lane)) continue;
    if (lane.status !== "complete" && lane.status !== "truncated") continue;
    if (!Number.isInteger(lane.depth) || lane.depth <= 0) continue;
    for (const observation of lane.observations) {
      if (observation.object_id !== objectId) continue;
      if (!Number.isFinite(observation.normalized_rank) || observation.normalized_rank <= 0) {
        continue;
      }
      best = preferLexicalHit(freezeShadow({
        lane_id: lane.lane,
        normalized_rank: observation.normalized_rank,
        list_n: lane.depth,
        status: lane.status
      }), best);
    }
  }
  return best;
}

function preferLexicalHit(candidate: LexHit, current: LexHit | null): LexHit {
  if (current === null) return candidate;
  if (candidate.normalized_rank !== current.normalized_rank) {
    return candidate.normalized_rank > current.normalized_rank ? candidate : current;
  }
  return LANE_PRIORITY[candidate.lane_id] < LANE_PRIORITY[current.lane_id] ? candidate : current;
}

function liveEmbedding(
  objectId: string,
  scores: Readonly<Record<string, number>>
): ShadowPointwiseObservation {
  if (!Object.hasOwn(scores, objectId) || !Number.isFinite(scores[objectId])) {
    return parsePointwiseObservation({
      lineage: "embedding",
      receipt: "embed.observe.v1",
      correlation: "dup:embed-max-v1",
      envelope: { state: "not_observed", reason: "missing_vector" },
      snapshot: { status: "not_observed", value: null, domain: null, content_hash: null }
    });
  }
  const value = clamp01(scores[objectId]!);
  return parsePointwiseObservation({
    lineage: "embedding",
    receipt: "embed.observe.v1",
    correlation: "dup:embed-max-v1",
    envelope: { state: "observed", value },
    snapshot: {
      status: "observed",
      value,
      domain: LIVE_EMB_DOMAIN,
      content_hash: `live.embed:${objectId}`
    }
  });
}

function liveTemporal(entry: Readonly<MemoryEntry>, context: LiveContext): ShadowPointwiseObservation {
  const eventTime = parseEventTime(entry.event_time_start);
  if (eventTime === null) {
    return temporalObservation({
      envelope: { state: "not_observed", reason: "missing_event_time" },
      evaluator: unevaluatedTemporal(context, null)
    });
  }
  if (context.parseState === "unparseable_date_terms") {
    return temporalObservation({
      envelope: { state: "not_observed", reason: "unparseable_window" },
      evaluator: unevaluatedTemporal(context, eventTime)
    });
  }
  const domain = temporalDomain(context);
  if (!context.clockOk || context.nowIso === undefined || domain === null) {
    return temporalObservation({
      envelope: { state: "not_observed" },
      evaluator: unevaluatedTemporal(context, eventTime)
    });
  }
  const value = context.window === null
    ? scoreTemporalEventTime(entry, context.nowIso)
    : scoreTemporalQueryWindow(entry, context.window, context.nowIso);
  return temporalObservation({
    envelope: { state: "observed", value },
    evaluator: {
      applicable: true,
      parse_state: context.parseState,
      clock_state: "ok",
      candidate_evaluated: true,
      event_time: eventTime,
      domain,
      finite_value: value
    }
  });
}

function liveSubject(): ShadowPointwiseObservation {
  return parsePointwiseObservation({
    lineage: "subject_preference",
    receipt: "subject.observe.v1",
    correlation: "subject.observe.v1",
    envelope: { state: "not_observed", reason: "not_run" },
    domain: {
      query_id: "shadow.live",
      applicable_component_ids: ["preference"],
      component_operator_ids: ["scorePreferenceProfileAlignment"]
    },
    components: [{
      component_id: "preference",
      operator_id: "scorePreferenceProfileAlignment",
      envelope: { state: "not_observed", reason: "not_run" }
    }]
  });
}

function temporalObservation(input: {
  readonly envelope: { readonly state: string; readonly reason?: string; readonly value?: number };
  readonly evaluator: ShadowTemporalEvaluator;
}): ShadowPointwiseObservation {
  return parsePointwiseObservation({
    lineage: "temporal",
    receipt: "temporal.observe.v1",
    correlation: "temporal.observe.v1",
    envelope: input.envelope,
    evaluator: input.evaluator
  });
}

function unevaluatedTemporal(
  context: LiveContext,
  eventTime: string | null
): ShadowTemporalEvaluator {
  return freezeShadow({
    applicable: true,
    parse_state: context.parseState,
    clock_state: context.clockOk ? "ok" as const : "unusable" as const,
    candidate_evaluated: false,
    event_time: eventTime,
    domain: context.parseState === "unparseable_date_terms" ? null : temporalDomain(context),
    finite_value: null
  });
}

function temporalDomain(context: LiveContext): ShadowTemporalDomain | null {
  if (context.parseState === "window" && context.window !== null) {
    return freezeShadow({
      kind: "window" as const,
      query_id: context.queryId,
      start_ms: context.window.startMs,
      end_ms: context.window.endMs,
      decay_days: 90 as const
    });
  }
  if (context.parseState === "recency" && context.nowIso !== undefined && context.clockOk) {
    return freezeShadow({
      kind: "recency" as const,
      query_id: context.queryId,
      now_iso: context.nowIso,
      decay_days: 365 as const
    });
  }
  return null;
}

function temporalParseState(
  probes: Readonly<RecallQueryProbes>,
  window: QueryTimeWindow | null
): ShadowTemporalEvaluator["parse_state"] {
  if (window !== null) return "window";
  if (probes.date_terms.length > 0) return "unparseable_date_terms";
  return "recency";
}

function liveQueryId(probes: Readonly<RecallQueryProbes>): string {
  const normalized = probes.normalized_query?.trim();
  return normalized !== undefined && normalized.length > 0 ? normalized : "shadow.live";
}

function parseEventTime(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.length === 0) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function isMergeLane(lane: string): lane is (typeof MERGE_LANES)[number] {
  return lane === "exact" || lane === "porter" || lane === "trigram";
}
