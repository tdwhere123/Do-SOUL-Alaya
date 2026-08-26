import {
  type MemoryEntry,
  type RecallPolicy
} from "@do-soul/alaya-protocol";
import { clamp01 } from "../../../shared/clamp.js";
import { compileRecallQueryDemand } from "../../query/recall-query-demand.js";
import type { RecallQueryProbes } from "../../query/recall-query-probes.js";
import {
  isTrustedPreferenceProfileOwner,
  scorePreferenceProfileAlignment,
  scoreSelfReferenceAlignment
} from
  "../../scoring/preference-fusion-scoring.js";
import { recallProjectionScoringEnabled } from
  "../../scoring/temporal-fusion-scoring.js";
import { buildRecallCandidateDedupeKey } from "../../runtime/recall-service-helpers.js";
import type {
  CoarseRecallCandidate,
  KeywordLexicalLaneId,
  KeywordLexicalMergeCapture,
  KeywordSearchLaneReceipt,
  RecallEvidenceSemanticActivationReceipt,
  RecallSupplementaryData
} from "../../runtime/recall-service-types.js";
import {
  parseQueryTimeWindow,
  scoreTemporalEventTime,
  scoreTemporalQueryWindow,
  type QueryTimeWindow
} from "../../scoring/temporal-fusion-scoring.js";
import { shadowLineageApplicability, type ShadowLineageApplicability } from "../demand.js";
import { freezeShadow } from "../envelope.js";
import {
  parsePointwiseObservation,
  type ShadowLineageId,
  type ShadowPointwiseObservation,
  type ShadowTemporalDomain,
  type ShadowTemporalEvaluator
} from "../observations.js";
import type { ShadowPsiObservationField } from "../psi.js";

export type LiveObservationSource = Readonly<{
  readonly candidates: readonly Readonly<CoarseRecallCandidate>[];
  readonly policy: Readonly<RecallPolicy>;
  readonly supplementaryData: RecallSupplementaryData;
  readonly memoryKeywordLanes?: readonly Readonly<KeywordSearchLaneReceipt>[];
  readonly memoryLexicalCaptures?: readonly Readonly<KeywordLexicalMergeCapture>[];
  readonly nowIso?: string;
}>;

type LiveContext = Readonly<{
  readonly applicable: ShadowLineageApplicability;
  readonly lanes: readonly Readonly<KeywordSearchLaneReceipt>[];
  readonly captures: readonly Readonly<KeywordLexicalMergeCapture>[];
  readonly scores: Readonly<Record<string, number>>;
  readonly evidenceActivations: RecallSupplementaryData[
    "evidenceSemanticActivationsByCandidateKey"
  ];
  readonly embeddingDomain: LiveObservationSource["supplementaryData"]["embeddingObservationDomain"];
  readonly contentHashes: Readonly<Record<string, string>>;
  readonly probes: Readonly<RecallQueryProbes>;
  readonly nowIso: string | undefined;
  readonly clockOk: boolean;
  readonly window: QueryTimeWindow | null;
  readonly parseState: ShadowTemporalEvaluator["parse_state"];
  readonly queryId: string;
}>;

type LexHit = Readonly<{
  readonly lane_id: KeywordLexicalLaneId;
  readonly normalized_rank: number;
  readonly list_n: number;
  readonly status: "complete" | "truncated";
  readonly raw_key_kind: "matched_token_count" | "bm25_raw_rank";
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
  field: ShadowPsiObservationField,
  captures: readonly Readonly<KeywordLexicalMergeCapture>[] = []
): "raw_rank_capture" | "lane_receipts" | "not_observed" {
  let observed = false;
  let captureOnly = true;
  for (const [key, view] of Object.entries(field)) {
    if (view?.lineages.lexical?.envelope.state !== "observed") continue;
    observed = true;
    const objectId = key.split(":").slice(2).join(":");
    if (chooseCaptureHit(objectId, captures) === null) captureOnly = false;
  }
  if (!observed) return "not_observed";
  return captureOnly && captures.length > 0 ? "raw_rank_capture" : "lane_receipts";
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
    captures: input.memoryLexicalCaptures ?? Object.freeze([]),
    scores: input.supplementaryData.embeddingSimilarityScores,
    evidenceActivations:
      input.supplementaryData.evidenceSemanticActivationsByCandidateKey,
    embeddingDomain: input.supplementaryData.embeddingObservationDomain,
    contentHashes: input.supplementaryData.embeddingContentHashByObjectId ?? Object.freeze({}),
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
    lineages.lexical = liveLexical(candidate.entry.object_id, context);
  }
  if (context.applicable.embedding) {
    lineages.embedding = liveEmbedding(candidate, context);
  }
  if (context.applicable.temporal) {
    lineages.temporal = liveTemporal(candidate.entry, context);
  }
  if (context.applicable.subject_preference) {
    lineages.subject_preference = liveSubject(candidate.entry, context);
  }
  return freezeShadow(lineages);
}

function liveLexical(
  objectId: string,
  context: LiveContext
): ShadowPointwiseObservation {
  const hit = chooseCaptureHit(objectId, context.captures);
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
      lane_id: hit.lane_id,
      list_n: hit.list_n,
      status: hit.status,
      raw_key_kind: hit.raw_key_kind
    }
  });
}

function chooseCaptureHit(
  objectId: string,
  captures: readonly Readonly<KeywordLexicalMergeCapture>[]
): LexHit | null {
  for (const capture of captures) {
    const row = capture.candidates.find((candidate) =>
      candidate.candidate_key === objectId &&
      candidate.admitted &&
      candidate.chosen_lane_id !== null &&
      candidate.chosen_normalized_rank !== null
    );
    if (row === undefined || row.chosen_lane_id === null ||
        row.chosen_normalized_rank === null) continue;
    const lane = capture.lanes.find((item) => item.lane_id === row.chosen_lane_id);
    if (lane === undefined || (lane.status !== "complete" && lane.status !== "truncated")) {
      continue;
    }
    return freezeShadow({
      lane_id: row.chosen_lane_id,
      normalized_rank: row.chosen_normalized_rank,
      list_n: lane.list_n,
      status: lane.status,
      raw_key_kind: lane.raw_key_kind
    });
  }
  return null;
}

function liveEmbedding(
  candidate: Readonly<CoarseRecallCandidate>,
  context: LiveContext
): ShadowPointwiseObservation {
  const objectId = candidate.entry.object_id;
  const objectScore = Object.hasOwn(context.scores, objectId) &&
    Number.isFinite(context.scores[objectId])
    ? context.scores[objectId]
    : undefined;
  const evidence = strongestEvidenceEmbedding(
    context.evidenceActivations.get(buildRecallCandidateDedupeKey(candidate))
  );
  const objectContentHash = context.contentHashes[objectId];
  const objectHasAuthority = objectContentHash !== undefined && objectContentHash.length > 0;
  const evidenceHasAuthority = evidence?.contentHash !== undefined &&
    evidence.contentHash.length > 0;
  const useEvidence = evidence !== null &&
    evidenceHasAuthority &&
    (!objectHasAuthority || objectScore === undefined || evidence.score >= objectScore);
  const score = useEvidence ? evidence.score : objectScore;
  if (score === undefined) {
    return parsePointwiseObservation({
      lineage: "embedding",
      receipt: "embed.observe.v1",
      correlation: "dup:embed-max-v1",
      envelope: { state: "not_observed", reason: "missing_vector" },
      snapshot: { status: "not_observed", value: null, domain: null, content_hash: null }
    });
  }
  const value = clamp01(score);
  const contentHash = useEvidence ? evidence.contentHash : objectContentHash;
  if (context.embeddingDomain === undefined || contentHash === undefined ||
      contentHash.length === 0) {
    return parsePointwiseObservation({
      lineage: "embedding",
      receipt: "embed.observe.v1",
      correlation: "dup:embed-max-v1",
      envelope: { state: "not_observed", reason: "missing_authority" },
      snapshot: { status: "not_observed", value: null, domain: null, content_hash: null }
    });
  }
  return parsePointwiseObservation({
    lineage: "embedding",
    receipt: "embed.observe.v1",
    correlation: "dup:embed-max-v1",
    envelope: { state: "observed", value },
    snapshot: {
      status: "observed",
      value,
      domain: context.embeddingDomain,
      content_hash: contentHash
    }
  });
}

function strongestEvidenceEmbedding(
  receipt: Readonly<RecallEvidenceSemanticActivationReceipt> | undefined
): Readonly<{ score: number; contentHash: string | undefined }> | null {
  if (receipt === undefined) return null;
  let strongest: Readonly<{ score: number; contentHash: string | undefined }> | null = null;
  for (const observation of receipt.observations) {
    if (!Number.isFinite(observation.score)) continue;
    if (strongest === null || observation.score > strongest.score) {
      strongest = { score: observation.score, contentHash: observation.contentHash };
    }
  }
  return strongest;
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

function liveSubject(
  entry: Readonly<MemoryEntry>,
  context: LiveContext
): ShadowPointwiseObservation {
  const components = subjectComponents(entry, context);
  const applicable = components.filter((component) =>
    component.envelope.state !== "not_applicable"
  );
  const observed = applicable.every((component) => component.envelope.state === "observed");
  const value = observed
    ? Math.max(...applicable.map((component) =>
      component.envelope.state === "observed" ? component.envelope.value : 0
    ))
    : null;
  return parsePointwiseObservation({
    lineage: "subject_preference",
    receipt: "subject.observe.v1",
    correlation: "subject.observe.v1",
    envelope: value === null
      ? { state: "not_observed", reason: "not_run" }
      : { state: "observed", value },
    domain: {
      query_id: context.queryId,
      applicable_component_ids: applicable.map((component) => component.component_id),
      component_operator_ids: applicable.map((component) => component.operator_id)
    },
    components
  });
}

function subjectComponents(entry: Readonly<MemoryEntry>, context: LiveContext) {
  return ([
    subjectComponent("preference", "scorePreferenceProfileAlignment",
      context.probes.dimensions.includes("preference"),
      () => scorePreferenceProfileAlignment(entry, context.probes), entry, context),
    subjectComponent("self_reference", "scoreSelfReferenceAlignment",
      context.probes.subject_hints.includes("self_reference"),
      () => scoreSelfReferenceAlignment(entry, context.probes), entry, context)
  ] as const).filter((component) => component.envelope.state !== "not_applicable");
}

function subjectComponent(
  component_id: "preference" | "self_reference",
  operator_id: string,
  applicable: boolean,
  score: () => number,
  entry: Readonly<MemoryEntry>,
  context: LiveContext
) {
  if (!applicable) return freezeShadow({
    component_id, operator_id, authority_state: "not_applicable" as const,
    envelope: { state: "not_applicable" as const }
  });
  const state = productionSubjectComponentState(component_id, entry);
  return freezeShadow({
    component_id,
    operator_id,
    authority_state: state === "available" ? "evaluated" as const : state,
    envelope: state === "available"
      ? { state: "observed" as const, value: score() }
      : { state: "not_observed" as const, reason: "not_run" as const }
  });
}

function productionSubjectComponentState(
  component: "preference" | "self_reference",
  entry: Readonly<MemoryEntry>
): "available" | "disabled" | "untrusted" | "not_run" {
  if (!recallProjectionScoringEnabled()) return "disabled";
  if (!isTrustedPreferenceProfileOwner(entry)) return "untrusted";
  if (component === "preference" && entry.preference_object == null &&
      entry.preference_category == null && entry.preference_polarity == null) {
    return "not_run";
  }
  return "available";
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
