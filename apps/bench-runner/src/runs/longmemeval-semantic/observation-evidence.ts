import { SourceEvidenceTargetSchema, SourceSemanticAcquisitionPhaseSchema, SourceSemanticProfiledAcquisitionPhaseSchema,
  SourceSemanticRetainedNominationWitnessSchema, sourceSemanticRetainedWitnessMatchesPhase, sourceRecallTarget,
  type SourceSemanticNominationOccurrence, type SourceSemanticProfiledAcquisitionPhase,
  type SourceEvidenceTarget, type SourceSemanticAcquisitionPhase } from "@do-soul/alaya-protocol";
import { sourceTargetJoinsGold, type SourceGoldUnit } from "../measurement/source-gold-join.js";
import { observationIndexEligibility, type ObservationAncestry, type ObservationEvent,
  type ObservationIndexEligibility, type observedFiniteUnion } from "./observation-ancestry.js";
import type { AnswerTurnSpan } from "./answer-spans.js";
import { byteIntervalsCoverSpan, type ConsumerVisibilityInterval, type ConsumerVisibilityScore,
  type MessageByteInterval } from "./message-visibility.js";
import type { ObservationAdmittedRoot, ObservationAttributionInput, ObservationCallScope } from "./observation-attribution.js";

export type ObservationStage = "eligibility" | "nomination" | "access_read" | "package" | "delivery";
export type ObservationStageStatus = "passed" | "failed" | "unknown" | "not_run";
export type ObservationReadStatus = "whole" | "partial" | "attempted" | "none" | "unknown";
export type ObservationStagePosition = Readonly<{ stage: ObservationStage; reason: string }>;
type Events = readonly ObservationEvent[];
type EventReference = Pick<ObservationEvent, "session_id" | "request_id" | "call_kind" | "event_position">;
/** Present event metadata rejected by its native schema, not a producer limitation or causal failure. */
export type ObservationDiagnosticIssue = Readonly<{
  field: "lexical_rank" | "vector_rank" | "resource_refusal" | "retained_occurrences"; reference: EventReference;
}>;
const VECTOR_INSPECTION_DETAIL_UNAVAILABLE = "vector_inspection_detail_unavailable";
type Nomination = NonNullable<SourceSemanticAcquisitionPhase["result"]>["nominations"][number];
type ResourceRefusal = NonNullable<SourceSemanticAcquisitionPhase["result"]>["resource_refusals"][number];
const acquisitionResult = SourceSemanticAcquisitionPhaseSchema.unwrap().shape.result.unwrap().unwrap();
const nominationFields = acquisitionResult.shape.nominations.unwrap().element.unwrap().shape;
const lexicalRankSchema = nominationFields.lexical.unwrap().element;
const vectorRankSchema = nominationFields.vector.unwrap();
const resourceRefusalSchema = acquisitionResult.shape.resource_refusals.unwrap().element;
type NativePhaseFact = Readonly<{ family: "legacy" | "profiled"; invocation: "original" | "hint";
  phase: SourceSemanticAcquisitionPhase | SourceSemanticProfiledAcquisitionPhase | null;
  retained?: readonly SourceSemanticNominationOccurrence[] | null; retained_issue?: boolean;
  position: EventReference | null; invocation_position: number; call_bound: boolean }>;

export type ObservationReadInterval = MessageByteInterval & Readonly<{
  provenance: "source_read" | "observation_read_complete" | "verification_reuse" | "access_order";
  /** Zero-based position in the originating request's frozen event stream, not an access rank. */
  event_position: number; request_id: number; session_id: string | null; call_kind: ObservationCallScope["kind"];
}>;
export type ObservationNativeRoute = Readonly<{
  invocation: "original" | "hint"; channel: "lexical" | "vector";
  position: EventReference | null; invocation_position: number;
  acquisition_status: SourceSemanticAcquisitionPhase["status"] | null;
  completion: string | null; reason: string | null; navigation_digest: string | null;
  /** Null means no valid captured rank, never valid-empty. Diagnostic issues distinguish corrupt
   * captures from missing evidence, independently of valid ranks supplied by another event or receipt. */
  lexical_ranks: Nomination["lexical"] | null;
  /** Compatibility summary of one available rank/window pair, not proof of nomination or all windows.
   * Profiled occurrences retain native ranks even when window detail is omitted or unavailable. */
  vector: Nomination["vector"];
  /** The native lexical nomination has no row/window byte bounds. */
  lexical_window: null;
  retained_occurrences: readonly SourceSemanticNominationOccurrence[] | null;
  occurrence_evidence: "full_retained" | "displayed_prefix" | "unavailable";
  vector_state: NonNullable<SourceSemanticAcquisitionPhase["result"]>["vector"]["state"];
  limitations: readonly string[];
  /** Per-attempt producer facts. Null means unobserved, not successful zero. */
  attempts: readonly Readonly<{
    disposition: "admitted" | "duplicate" | "nomination_limit" | "scope_denied"
      | "stale" | "native_unknown" | "resource_refused" | "rejected";
    admission: Readonly<{ status: string; reason: string; phase?: string }> | null;
    /** Valid producer-owned refusal, not native admission. Null has no valid refusal fact;
     * a matching diagnostic issue distinguishes malformed-present metadata from no recorded refusal. */
    resource_refusal: ResourceRefusal | null;
    reference: EventReference;
    merge_target: SourceEvidenceTarget | null;
  }>[] | null;
}>;
export type ObservationRouteFact = Readonly<{
  route: string; eligibility: ObservationStageStatus; nomination: ObservationStageStatus;
  access_read: ObservationReadStatus; package: ObservationStageStatus; delivery: ObservationStageStatus;
  native: ObservationNativeRoute | null;
  /** Native positions are zero-based. Access order is the policy's ordered pool, not read chronology. */
  access_positions: readonly number[]; union_positions: readonly number[];
  event_references: readonly EventReference[];
  /** Decoder faults remain independent of causal stage unknowns and valid native facts. */
  diagnostic_issues: readonly ObservationDiagnosticIssue[];
  /** Returned body bytes only; metadata, requests and later accounting cannot create these. */
  read_intervals: readonly ObservationReadInterval[];
  /** Retained/analyzed prefixes and verified reuse, not another physical read. */
  coverage_intervals: readonly ObservationReadInterval[];
  first_failure: ObservationStagePosition | null; first_unknown: ObservationStagePosition | null;
  unknowns: readonly ObservationStagePosition[];
}>;
export type ObservationPackageFacts = Readonly<{
  candidates: readonly Readonly<{ target: SourceEvidenceTarget; access_position: number | null;
    proof_count: number | null; payload_support: string | null; event: EventReference }>[];
  selected: readonly Readonly<{ target: SourceEvidenceTarget; page_position: number | null; slot_position: number; event: EventReference }>[];
  /** Codec observations, not admitted consumer visibility. Actual preview validation remains with the shared scorer. */
  encoded: readonly Readonly<{ target: SourceEvidenceTarget; offset: number | null;
    preview_bytes: number | null; within_budget: boolean | null; event: EventReference }>[];
}>;
export type ObservationMessageFacts = Readonly<{
  session_index: number; message_index: number; source_id: string; target: SourceGoldUnit;
  admission: "admitted" | "not_admitted" | "unknown"; matched_record_id: string | null;
  /** Per-message index/window proof, distinct from the parent's snapshot root map. */
  eligibility: ObservationStageStatus; index_qualification: ObservationIndexEligibility;
  candidate: "present" | "absent" | "unknown"; read: ObservationReadStatus;
  finite_union: Readonly<{ pool_id: string | null; origin: NonNullable<ReturnType<typeof observedFiniteUnion>["pool"]>["origin"];
    capture: "complete" | "overflow" | "unknown"; source_count: number | null; member_positions: readonly number[];
    source_discovery_open: boolean | null; interpretation_discovery_open: boolean | null; full_universe: "not_established" }>;
  access_positions: readonly number[]; read_intervals: readonly ObservationReadInterval[];
  coverage_intervals: readonly ObservationReadInterval[]; packages: ObservationPackageFacts;
  routes: readonly ObservationRouteFact[];
  /** Route-scoped decoder faults do not move this message's first causal blockage. */
  diagnostic_issues: readonly (ObservationDiagnosticIssue & Readonly<{ route: string }>)[];
  /** Shared scorer evidence for this exact mapped gold message. A missing or repeated scorer row
   * stays unknown; aggregate any/all never substitutes for a per-message fact. */
  visibility: Readonly<{
    delivery: "passed" | "failed" | "unknown";
    /** Shared scorer reason; null only for a determinate hit or miss. */
    reason: string | null;
    /** Caller-admitted delivered intervals for this exact identity and span, never clamped. */
    visible_intervals: readonly ConsumerVisibilityInterval[];
  }>;
  first_failure: ObservationStagePosition | null; first_unknown: ObservationStagePosition | null;
  unknowns: readonly ObservationStagePosition[];
}>;
type MutableRoute = {
  -readonly [Key in keyof Omit<ObservationRouteFact, "first_failure" | "first_unknown" | "unknowns" | "diagnostic_issues">]: ObservationRouteFact[Key];
} & { unknowns: ObservationStagePosition[]; diagnostic_issues: ObservationDiagnosticIssue[] };
const STAGES: readonly ObservationStage[] = ["eligibility", "nomination", "access_read", "package", "delivery"];

/** Parse the actual producer envelope: hint phases live under original.supplemental. */
function nativePhases(events: Events): NativePhaseFact[] {
  return events.filter(event => event.kind === "source_index_routes").flatMap(event => {
    const data = recordOf(event.data);
    if (data !== null && Object.hasOwn(data, "candidate_phase")) {
      const parsed = SourceSemanticProfiledAcquisitionPhaseSchema.safeParse(data.candidate_phase);
      const retained = Object.hasOwn(data, "retained_occurrences")
        ? SourceSemanticRetainedNominationWitnessSchema.safeParse(data.retained_occurrences) : undefined;
      const validRetained = parsed.success && retained?.success && sourceSemanticRetainedWitnessMatchesPhase(retained.data, parsed.data);
      return (["original", "hint"] as const).map((invocation, invocation_position): NativePhaseFact => ({
        family: "profiled", invocation, invocation_position, phase: parsed.success ? parsed.data : null, position: eventReference(event),
        call_bound: event.call_bound,
        retained: validRetained ? retained.data : null, retained_issue: retained !== undefined && !validRetained
      }));
    }
    const parsed = SourceSemanticAcquisitionPhaseSchema.safeParse(data?.original);
    const original = parsed.success ? parsed.data : null;
    return [{ family: "legacy" as const, invocation: "original" as const, phase: original, position: eventReference(event),
      invocation_position: 0, call_bound: event.call_bound },
      ...(original?.supplemental ?? []).map((phase, index) => ({ family: "legacy" as const, invocation: "hint" as const, phase,
        position: eventReference(event), invocation_position: index + 1, call_bound: event.call_bound }))];
  });
}

/** One gold message's observation facts. Delivery comes from the shared scorer row for this exact
 * mapped identity and span; an absent, repeated or unknown row stays unknown. */
export function observationMessageFacts(span: AnswerTurnSpan, input: ObservationAttributionInput,
  joined: ObservationAncestry, finite: ReturnType<typeof observedFiniteUnion>): ObservationMessageFacts {
  const events = joined.events.filter(event => event.call_bound), complete = joined.progress_complete, poolClosed = finite.complete;
  const qualification = observationIndexEligibility(span, input.call, joined, input.frozen_index);
  const admitted = joined.snapshot_bound ? findAdmitted(input.admitted_roots, input.call, span)
    : { state: "unknown" as const, root: null };
  const visibility = messageDelivery(span, input.visibility, input.k);
  const admission = admitted.state === "not_admitted" && !input.admitted_roots_complete ? "unknown" : admitted.state;
  const memberPositions = finite.pool?.union.members.flatMap((member, position) => span.target.workspace_id === input.call.workspace_id
    && member.source_id === span.source_id && member.source_version === span.target.source_version
    && member.content_digest === span.target.content_digest && member.record_id === (admitted.root?.record_id ?? span.target.root_id) ? [position] : []) ?? [];
  const member = memberPositions.length === 1 ? finite.pool!.union.members[memberPositions[0]!]! : null;
  // A full native pool identity can bind a bare read event even when the optional snapshot map
  // was not captured. This does not promote pool membership into index or snapshot admission.
  const readIdentity = admitted.root ?? (member !== null && member.source_id !== null && member.root_kind !== "evidence_capsule"
    && joined.snapshot_bound && input.call.snapshot_id !== null ? {
    record_id: member.record_id, source_id: member.source_id, snapshot_id: input.call.snapshot_id, identity: span.target } : null);
  const matches = (value: unknown) => span.target.workspace_id === input.call.workspace_id && eventMatches(value, readIdentity, span);
  const routes = indexRoutes(joined, span, qualification);
  const snapshot = route("snapshot_admission");
  snapshot.eligibility = "not_run";
  snapshot.nomination = "not_run";
  routes.unshift(snapshot);
  for (const name of new Set(["cursor", ...events.filter(event => event.kind === "union_admission")
    .flatMap(event => typeof recordOf(event.data)?.route === "string" ? [recordOf(event.data)!.route as string] : [])])) {
    const fact = route(`union:${name}`);
    const matching = events.filter(event => event.kind === "union_admission"
      && recordOf(event.data)?.route === name && matches(event.data));
    fact.nomination = matching.length > 0 ? "passed" : complete && poolClosed ? "failed" : "unknown";
    fact.union_positions = matching.flatMap(event => positions(recordOf(event.data)?.position));
    fact.event_references = matching.map(eventReference);
    routes.push(fact);
  }
  const readRoutes = observedReadRoutes(events, matches, span, complete);
  routes.push(...readRoutes);
  const finiteRoute = route("union:finite_pool");
  finiteRoute.nomination = memberPositions.length > 0 ? "passed" : finite.complete ? "failed" : "unknown";
  finiteRoute.union_positions = memberPositions;
  routes.push(finiteRoute);
  const packages = packageFacts(events, span.target);
  routes.push(...packageRoutes(events, packages, complete, visibility.delivery));
  const finished = routes.map(finalizeRoute);
  const readIntervals = readRoutes.flatMap(fact => fact.read_intervals);
  const coverage = readRoutes.flatMap(fact => fact.coverage_intervals);
  const read = readCoverage([...readIntervals, ...coverage], span,
    readRoutes.some(fact => fact.access_read === "unknown") || !complete,
    readRoutes.some(fact => fact.access_read === "attempted"));
  const unionMember = memberPositions.length > 0;
  const witnessed = routes.some(fact => !fact.route.startsWith("index:") && fact.nomination === "passed");
  const candidate = unionMember ? "present" : poolClosed ? witnessed ? "unknown" : "absent" : witnessed ? "present" : "unknown";
  const eligibility = qualification.status;
  // Failed alternative routes remain on those routes. They cannot move the joined message's
  // first blockage back before progress that another route actually achieved.
  const failures: ObservationStagePosition[] = [];
  if (read === "whole") {
    if (visibility.delivery === "failed") failures.push({ stage: "delivery", reason: "whole_message_read_not_visible" });
  } else if (candidate === "present") {
    if (read !== "unknown") failures.push({ stage: "access_read", reason: `gold_message_read_${read}` });
  } else if (candidate === "absent" && eligibility === "passed") {
    failures.push({ stage: "nomination", reason: "eligible_message_absent_from_finite_pool" });
  } else if (eligibility === "failed") failures.push({ stage: "eligibility", reason: qualification.reason });
  // Count-only vector inspection omission stays on its route. It cannot manufacture
  // a message-level nomination unknown after rank, read or delivery were observed.
  const unknowns = finished.flatMap(fact => fact.unknowns.filter(position =>
    position.reason !== VECTOR_INSPECTION_DETAIL_UNAVAILABLE));
  if (candidate === "unknown") unknowns.push({ stage: "nomination", reason: poolClosed && witnessed
    ? "finite_union_conflicts_with_observed_progress" : "finite_pool_membership_unavailable" });
  if (read === "unknown") unknowns.push({ stage: "access_read", reason: complete ? "read_extent_unavailable" : "causal_observation_incomplete" });
  if (eligibility === "unknown") unknowns.push({ stage: "eligibility", reason: "per_message_index_eligibility_unavailable" });
  return { session_index: span.session_index, message_index: span.message_index, source_id: span.source_id,
    target: span.target, admission, eligibility, index_qualification: qualification, matched_record_id: readIdentity?.record_id ?? null,
    candidate, read, finite_union: { pool_id: finite.pool?.pool_id ?? null, origin: finite.pool?.origin ?? null,
      capture: finite.pool?.union.capture ?? "unknown", source_count: finite.pool?.union.source_count ?? null, member_positions: memberPositions,
      source_discovery_open: finite.pool?.union.source_discovery_open ?? null,
      interpretation_discovery_open: finite.pool?.union.interpretation_discovery_open ?? null, full_universe: "not_established" },
    access_positions: readRoutes.flatMap(fact => fact.access_positions), read_intervals: readIntervals,
    coverage_intervals: coverage, packages, routes: finished,
    diagnostic_issues: finished.flatMap(fact => fact.diagnostic_issues.map(issue => ({ route: fact.route, ...issue }))),
    visibility, first_failure: earliestPosition(failures),
    first_unknown: earliestPosition(unknowns), unknowns };
}

/** Match a gold message to its shared-scorer row by full mapped identity and span, never by array
 * position. A missing or repeated row stays unknown; aggregate any/all never fills this in. */
function messageDelivery(span: AnswerTurnSpan, score: ConsumerVisibilityScore,
  k: 5 | 10): ObservationMessageFacts["visibility"] {
  const matches = score.messages.filter(message => message.session_index === span.session_index
    && message.message_index === span.message_index && message.source_id === span.source_id
    && message.start === span.start && message.end === span.end
    && sourceTargetJoinsGold({ rank: 0, object_kind: "source_evidence", target: sourceRecallTarget({
      ...message.target, evidence_object_id: null }) }, span.target));
  if (matches.length !== 1) return { delivery: "unknown", visible_intervals: [],
    reason: matches.length === 0 ? "consumer_visibility_message_missing"
      : "consumer_visibility_message_ambiguous" };
  const metric = k === 5 ? matches[0]!.at_5 : matches[0]!.at_10;
  return { delivery: metric.status === "hit" ? "passed" : metric.status === "miss" ? "failed" : "unknown",
    reason: metric.reason, visible_intervals: matches[0]!.visible_intervals };
}

function indexRoutes(joined: ObservationAncestry, span: AnswerTurnSpan,
  qualification: ObservationIndexEligibility): MutableRoute[] {
  const events = joined.events, complete = joined.progress_complete;
  const observed = nativePhases(events);
  const captures = events.flatMap(event => {
    if (event.kind !== "source_index_acquisition") return [];
    const data = recordOf(event.data);
    const invocation = data?.invocation === "hint" ? "hint" as const
      : data?.invocation === "original" ? "original" as const : null;
    return invocation === null || data === null ? [] : [{ invocation, data, position: eventReference(event), call_bound: event.call_bound }];
  });
  const phases = (["original", "hint"] as const).flatMap<NativePhaseFact>(invocation => {
    const matching = observed.filter(row => row.invocation === invocation);
    return matching.length > 0 ? matching : [{ family: "legacy", invocation, phase: null, position: null, invocation_position: 0, call_bound: false }];
  });
  return phases.flatMap(({ family, invocation, phase: capturedPhase, position, invocation_position,
    retained: capturedRetained, retained_issue, call_bound }) => {
    // Schema consistency does not admit a native call. Keep decoding faults below even when
    // ancestry admission withholds the phase, retained proof and optional attempt/rank facts.
    const phase = call_bound ? capturedPhase : null, retained = call_bound ? capturedRetained : null;
    const result = phase?.result;
    const prefix = result !== null && result !== undefined && "occurrence_prefix" in result ? result.occurrence_prefix : null;
    const occurrences = (retained ?? prefix)?.filter(row => row.view === invocation && targetMatches(row.source.target, span.target)) ?? null;
    const nomination = phaseNomination(phase, span, occurrences);
    const candidate = family === "profiled";
    const routeCaptures = captures.filter(row => row.invocation === invocation);
    return (["lexical", "vector"] as const).map(channel => {
      const fact = route(`index:${invocation}:${channel}`);
      const lane = phase !== null && "declared_allowance" in phase
        ? phase.result?.lanes.find(row => row.view === invocation && row.route === channel) : undefined;
      const routeOccurrences = occurrences?.filter(row => row.route.kind === channel) ?? null;
      const native = candidate && invocation === "hint" ? undefined : result?.[channel];
      const matching = routeCaptures.filter(row => targetMatches(row.data.target, span.target));
      const attempts = matching.filter(row => row.data.kind === "nomination_attempt" && row.data.channel === channel);
      const dispositions = attempts.filter(row => row.call_bound).map(row => row.data.disposition);
      const nominated = channel === "lexical" ? (nomination?.lexical.length ?? 0) > 0 : nomination?.vector != null;
      // Profiled participation comes only from nativePhases' validated witness/prefix, independently
      // of window availability. Optional attempt diagnostics cannot override that authority.
      const nominatedOnRoute = candidate ? (routeOccurrences?.length ?? 0) > 0
        : nominated || dispositions.some(value => value === "admitted" || value === "duplicate");
      const rejected = !candidate && dispositions.some(value => value === "nomination_limit" || value === "scope_denied"
        || value === "stale" || value === "native_unknown" || value === "resource_refused" || value === "rejected");
      // Attempt facts can fail a route without inventing nomination_limit for an unobserved remainder.
      fact.nomination = nominatedOnRoute ? "passed" : rejected ? "failed"
        : phase?.status === "not_run" || native?.completion === "not_run" || lane?.availability.status === "absent" || lane?.availability.status === "disabled" ? "not_run" : "unknown";
      fact.eligibility = qualification[channel];
      const rankEvents = matching.filter(row => channel === "lexical" ? row.data.kind === "lexical_candidate"
        : row.data.kind === "vector_ranked" || row.data.kind === "vector_inspected");
      fact.event_references = [...(position === null ? [] : [position]),
        ...attempts.map(row => row.position), ...rankEvents.map(row => row.position)];
      if (retained_issue && position !== null) fact.diagnostic_issues.push({ field: "retained_occurrences", reference: position });
      const lexicalRanks: Nomination["lexical"][number][] = [];
      let vectorRank: Nomination["vector"] = null;
      // Validate every captured rank, even after a valid event or receipt already supplied proof.
      for (const row of rankEvents) {
        if (row.data.kind === "lexical_candidate") {
          const parsed = lexicalRankFrom(row.data);
          if (!parsed.success) fact.diagnostic_issues.push({ field: "lexical_rank", reference: row.position });
          else if (row.call_bound) lexicalRanks.push(parsed.data);
        } else if (row.data.kind === "vector_ranked") {
          const parsed = vectorRankFrom(row.data);
          if (!parsed.success) fact.diagnostic_issues.push({ field: "vector_rank", reference: row.position });
          else if (row.call_bound) vectorRank ??= parsed.data;
        }
      }
      const receiptLexical = channel === "lexical" && (nomination?.lexical.length ?? 0) > 0 ? nomination!.lexical : null;
      const omittedLexical = channel === "lexical" && joined.frames.some(row =>
        (row.observation.diagnostics?.omitted_counts?.[`source_index_${invocation}_lexical_candidate`] ?? 0) > 0);
      fact.native = { invocation, channel, position, invocation_position, acquisition_status: phase?.status ?? null,
        completion: native?.completion ?? (lane?.availability.status === "measured_empty" ? "complete" : null), reason: native?.reason
          ?? (lane?.availability.status === "unavailable" ? lane.availability.reason : undefined) ?? phase?.reason
          ?? (phase === null ? position !== null && !call_bound ? "native_call_binding_unavailable" : "native_route_not_observed_or_invalid" : null),
        navigation_digest: result?.navigation_digest ?? null,
        lexical_ranks: channel === "lexical" ? mergeLexicalRanks(candidate ? [] : lexicalRanks, receiptLexical) : null,
        vector: channel === "vector" ? nomination?.vector ?? (candidate ? null : vectorRank) : null, lexical_window: null,
        retained_occurrences: routeOccurrences,
        occurrence_evidence: retained !== undefined && retained !== null ? "full_retained" : prefix !== null ? "displayed_prefix" : "unavailable",
        vector_state: channel === "vector" && (!candidate || invocation === "original") ? result?.vector.state ?? null : null,
        limitations: [...(result?.limitations ?? []), ...(channel === "lexical" && (!candidate || invocation === "original") ? result?.lexical.limitations ?? [] : [])],
        attempts: nominationAttempts(attempts, fact.diagnostic_issues) };
      const ranksAvailable = (routeOccurrences?.length ?? 0) > 0
        || (channel === "lexical" ? (fact.native.lexical_ranks?.length ?? 0) > 0 : fact.native.vector != null);
      if (!nominatedOnRoute && !ranksAvailable) {
        fact.unknowns.push({ stage: "nomination", reason: `${channel}_rank_unavailable` });
      }
      if (omittedLexical) {
        fact.unknowns.push({ stage: "nomination", reason: "lexical_candidate_detail_unavailable" });
      }
      if (channel === "vector" && joined.frames.some(row =>
        (row.observation.diagnostics?.omitted_counts?.[`source_index_${invocation}_vector_inspected`] ?? 0) > 0)) {
        fact.unknowns.push({ stage: "nomination", reason: VECTOR_INSPECTION_DETAIL_UNAVAILABLE });
      }
      if (qualification[channel] === "unknown") fact.unknowns.push({ stage: "eligibility", reason: qualification.reason });
      if (position !== null && !call_bound) fact.unknowns.push({ stage: "nomination", reason: "native_call_binding_unavailable" });
      if (!complete) fact.unknowns.push({ stage: "nomination", reason: "observation_incomplete" });
      return fact;
    });
  });
}
function phaseNomination(phase: NativePhaseFact["phase"], span: AnswerTurnSpan,
  rows: readonly SourceSemanticNominationOccurrence[] | null): Nomination | undefined {
  const result = phase?.result;
  if (result === null || result === undefined) return undefined;
  if ("nominations" in result) return result.nominations.find(row => targetMatches(row.source.target, span.target));
  if (rows === null || rows.length === 0) return undefined;
  return { source: rows[0]!.source, lexical: rows.flatMap(row => row.route.kind === "lexical"
    ? [{ rank: row.route.native_rank, lane: row.route.lane, lane_rank: row.route.lane_rank, bm25: row.route.bm25 }] : []),
  vector: rows.flatMap(row => row.route.kind === "vector" && row.route.window?.status === "available"
    ? [{ rank: row.route.native_rank, cosine: row.route.cosine, window: row.route.window.window }] : [])[0] ?? null };
}
function nominationAttempts(rows: readonly { data: Record<string, unknown>; position: EventReference; call_bound: boolean }[],
  issues: ObservationDiagnosticIssue[]): ObservationNativeRoute["attempts"] {
  const facts: NonNullable<ObservationNativeRoute["attempts"]>[number][] = [];
  for (const row of rows) {
    const value = row.data.disposition;
    if (value !== "admitted" && value !== "duplicate" && value !== "nomination_limit" && value !== "scope_denied"
      && value !== "stale" && value !== "native_unknown" && value !== "resource_refused" && value !== "rejected") {
      continue;
    }
    const admission = recordOf(row.data.admission);
    const status = admission?.status, reason = admission?.reason;
    const captured = admission !== null && typeof status === "string" && typeof reason === "string"
      && (status === "resource_limited" || status === "stale" || status === "partial" || status === "unbound")
      ? { status, reason, ...(status === "resource_limited" && typeof admission.phase === "string"
        ? { phase: admission.phase } : {}) } : null;
    const parsed = SourceEvidenceTargetSchema.safeParse(row.data.merge_target);
    const refusal = resourceRefusalFrom(row.data);
    if (refusal !== null && !refusal.success) issues.push({ field: "resource_refusal", reference: row.position });
    if (!row.call_bound) continue;
    facts.push({ disposition: value, admission: captured, resource_refusal: refusal?.success ? refusal.data : null,
      reference: row.position, merge_target: parsed.success ? parsed.data : null });
  }
  return facts.length === 0 ? null : facts;
}
/** Event ranks and receipt ranks are independent observations. Dedup only identical facts. */
function mergeLexicalRanks(events: Nomination["lexical"], receipt: Nomination["lexical"] | null):
  Nomination["lexical"] | null {
  const ranks: Nomination["lexical"][number][] = [];
  const seen = new Set<string>();
  for (const row of [...events, ...(receipt ?? [])]) {
    const key = `${row.lane}:${row.rank}:${row.lane_rank}:${row.bm25}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ranks.push(row);
  }
  return ranks.length > 0 ? ranks : null;
}
function resourceRefusalFrom(data: Record<string, unknown>) {
  // Missing/null is the producer's legitimate no-refusal representation, not a parse failure.
  return data.resource_refusal == null ? null : resourceRefusalSchema.safeParse(data.resource_refusal);
}
function lexicalRankFrom(data: Record<string, unknown>) {
  return lexicalRankSchema.safeParse({ rank: data.rank, lane: data.lane, lane_rank: data.lane_rank, bm25: data.bm25 });
}
function vectorRankFrom(data: Record<string, unknown>) {
  return vectorRankSchema.safeParse({ rank: data.rank, cosine: data.cosine, window: data.window });
}

/** Returned extents are captured before retention/scoring may fail. Completion and policy-order
 * rows instead certify analyzed prefixes; verified reuse certifies existing bytes, not fresh I/O. */
function observedReadRoutes(events: Events, matches: (value: unknown) => boolean,
  span: AnswerTurnSpan, complete: boolean): MutableRoute[] {
  const routes = new Map<string, MutableRoute>();
  for (const event of events) {
    const data = recordOf(event.data);
    const name = event.kind === "source_read" || event.kind === "source_read_attempt"
      ? typeof data?.purpose === "string" ? `read:${data.purpose}` : "read:unknown_purpose"
      : event.kind === "observation_read_complete" ? "read:observation"
        : event.kind === "verification_reuse" ? "read:verification_reuse" : event.kind === "access_order" ? "access_order" : null;
    if (name === null) continue;
    const fact = routes.get(name) ?? route(name);
    routes.set(name, fact);
    if (event.kind === "access_order") {
      for (const row of Array.isArray(data?.sources) ? data.sources : []) {
        if (!matches(row)) continue;
        fact.nomination = "passed";
        fact.event_references = [...fact.event_references, eventReference(event)];
        const value = recordOf(row);
        fact.access_positions = [...fact.access_positions, ...positions(value?.position)];
        if (value !== null && nonnegative(value.read_bytes)
          && (!nonnegative(value.body_bytes) || value.read_bytes <= value.body_bytes)) {
          if (value.read_bytes > 0) fact.coverage_intervals = [...fact.coverage_intervals,
            { start: 0, end: value.read_bytes, ...eventReference(event), provenance: "access_order" }];
        } else fact.unknowns.push({ stage: "access_read", reason: "analyzed_prefix_unavailable" });
      }
      continue;
    }
    if (!matches(event.data)) continue;
    fact.nomination = "passed";
    fact.event_references = [...fact.event_references, eventReference(event)];
    if (event.kind === "source_read_attempt" || data?.purpose === "observation_metadata" || data?.available === false) {
      fact.access_read = "attempted";
      continue;
    }
    const range = rangeOf(data);
    if (range === null || data !== null && nonnegative(data.body_bytes) && range.end > data.body_bytes) {
      fact.unknowns.push({ stage: "access_read", reason: "actual_read_interval_unavailable" }); continue;
    }
    if (range.end === range.start) continue;
    const interval = { ...range, ...eventReference(event),
      provenance: event.kind as ObservationReadInterval["provenance"] };
    if (event.kind === "source_read") fact.read_intervals = [...fact.read_intervals, interval];
    else fact.coverage_intervals = [...fact.coverage_intervals, interval];
  }
  return [...routes.values()].map(fact => ({ ...fact,
    access_read: readCoverage([...fact.read_intervals, ...fact.coverage_intervals], span,
      fact.unknowns.some(value => value.stage === "access_read") || !complete,
      fact.access_read === "attempted") }));
}

function readCoverage(intervals: readonly MessageByteInterval[], span: AnswerTurnSpan, unresolved: boolean,
  attempted: boolean): ObservationReadStatus {
  if (byteIntervalsCoverSpan(intervals, span)) return "whole";
  // Partial known bytes do not prove that missing bytes were not read in an unobserved extent.
  if (unresolved) return "unknown";
  if (intervals.some(interval => interval.start < span.end && interval.end > span.start)) return "partial";
  return attempted ? "attempted" : "none";
}

function packageFacts(events: Events, target: SourceGoldUnit): ObservationPackageFacts {
  const candidates: ObservationPackageFacts["candidates"][number][] = [];
  const selected: ObservationPackageFacts["selected"][number][] = [];
  const encoded: ObservationPackageFacts["encoded"][number][] = [];
  for (const event of events) {
    const data = recordOf(event.data);
    if (event.kind === "package_candidates") for (const value of Array.isArray(data?.packages) ? data.packages : []) {
      const row = recordOf(value), parsed = SourceEvidenceTargetSchema.safeParse(row?.target);
      if (parsed.success && targetMatches(parsed.data, target)) candidates.push({ target: parsed.data,
        access_position: positionOf(row?.access_position), proof_count: positionOf(row?.proof_count),
        payload_support: typeof row?.payload_support === "string" ? row.payload_support : null, event: eventReference(event) });
    }
    if (event.kind === "frozen_membership") for (const value of Array.isArray(data?.pages) ? data.pages : []) {
      const page = recordOf(value);
      for (const [position, value] of (Array.isArray(page?.targets) ? page.targets : []).entries()) {
        const parsed = SourceEvidenceTargetSchema.safeParse(value);
        if (parsed.success && targetMatches(parsed.data, target)) selected.push({ target: parsed.data,
          page_position: positionOf(page?.position), slot_position: position, event: eventReference(event) });
      }
    }
    if (event.kind === "encoded_membership") for (const value of Array.isArray(data?.results) ? data.results : []) {
      const row = recordOf(value), parsed = SourceEvidenceTargetSchema.safeParse(row?.target);
      if (parsed.success && targetMatches(parsed.data, target)) encoded.push({ target: parsed.data,
        offset: positionOf(data?.offset), preview_bytes: positionOf(row?.preview_bytes),
        within_budget: typeof row?.within_budget === "boolean" ? row.within_budget : null, event: eventReference(event) });
    }
  }
  return { candidates, selected, encoded };
}

function packageRoutes(events: Events, facts: ObservationPackageFacts, complete: boolean,
  delivery: "passed" | "failed" | "unknown"): MutableRoute[] {
  const result: MutableRoute[] = [];
  for (const [kind, name, matching] of [["package_candidates", "package_candidates", facts.candidates],
    ["frozen_membership", "package", facts.selected], ["encoded_membership", "delivery", facts.encoded]] as const) {
    const observed = events.filter(event => event.kind === kind);
    if (observed.length === 0) continue;
    const fact = route(name);
    fact.event_references = observed.map(eventReference);
    const closed = complete && observed.every(event => kind === "encoded_membership"
      ? Array.isArray(recordOf(event.data)?.results) : recordOf(event.data)?.incomplete === false);
    fact.nomination = matching.length > 0 ? "passed" : closed ? "failed" : "unknown";
    if (kind === "frozen_membership") fact.package = fact.nomination;
    // Never equate observer membership (including successful encoding) with consumer-visible messages.
    if (kind === "encoded_membership") fact.delivery = delivery;
    result.push(fact);
  }
  return result;
}

function route(name: string): MutableRoute {
  return { route: name, eligibility: "not_run", nomination: "unknown", access_read: "unknown", package: "not_run",
    delivery: "not_run", native: null, access_positions: [], union_positions: [], event_references: [],
    read_intervals: [], coverage_intervals: [], unknowns: [], diagnostic_issues: [] };
}
function finalizeRoute(value: MutableRoute): ObservationRouteFact {
  const readReached = value.nomination === "passed" && (value.route.startsWith("read:") || value.route === "access_order");
  const failures = STAGES.filter(stage => stage === "access_read"
    ? readReached && ["partial", "attempted", "none"].includes(value.access_read) : value[stage] === "failed")
    .map(stage => ({ stage, reason: stage === "access_read" ? `read_${value.access_read}` : `${stage}_${value[stage]}` }));
  const unknowns = [...value.unknowns, ...STAGES.filter(stage => stage === "access_read"
    ? readReached && value.access_read === "unknown" : value[stage] === "unknown")
    .map(stage => ({ stage, reason: stage === "access_read" ? "read_unknown" : `${stage}_unknown` }))];
  return { ...value, first_failure: earliestPosition(failures), first_unknown: earliestPosition(unknowns), unknowns };
}
function earliestPosition(positions: readonly ObservationStagePosition[]): ObservationStagePosition | null {
  for (const stage of STAGES) {
    const matching = positions.filter(position => position.stage === stage);
    if (matching.length === 0) continue;
    // Count-only inspection omission stays when it is the only unknown at this stage.
    // Causal progress unknown and any other same-stage fact outrank it in the summary.
    return matching.find(position => position.reason !== VECTOR_INSPECTION_DETAIL_UNAVAILABLE) ?? matching[0]!;
  }
  return null;
}
function findAdmitted(map: ReadonlyMap<string, ObservationAdmittedRoot>, call: ObservationCallScope,
  span: AnswerTurnSpan): Readonly<{ state: "admitted" | "not_admitted" | "unknown"; root: ObservationAdmittedRoot | null }> {
  if (call.snapshot_id === null || span.target.workspace_id !== call.workspace_id) return { state: "unknown", root: null };
  const matches = [...map].filter(([key, root]) => key === root.record_id && root.snapshot_id === call.snapshot_id
    && root.source_id === span.source_id && sourceTargetJoinsGold({ rank: 0, object_kind: "source_evidence",
      target: sourceRecallTarget({ ...root.identity, evidence_object_id: null }) }, span.target)).map(([, root]) => root);
  return matches.length === 1 ? { state: "admitted", root: matches[0]! }
    : { state: matches.length === 0 ? "not_admitted" : "unknown", root: null };
}
function eventMatches(value: unknown, admitted: ObservationAdmittedRoot | null, span: AnswerTurnSpan): boolean {
  const data = recordOf(value), target = span.target;
  if (data === null || data.source_id !== undefined && data.source_id !== span.source_id
    || data.source_version !== undefined && data.source_version !== target.source_version
    || data.content_digest !== undefined && data.content_digest !== target.content_digest
    || data.workspace_id !== undefined && data.workspace_id !== target.workspace_id) return false;
  if (data.target !== undefined) return targetMatches(data.target, target)
    && (data.record_id === undefined || data.record_id === (admitted?.record_id ?? target.root_id));
  if (admitted === null) return false;
  if (data.record_id !== undefined) return data.record_id === admitted.record_id;
  return data.source_id === admitted.source_id && data.source_version === target.source_version
    && data.content_digest === target.content_digest;
}
function targetMatches(value: unknown, target: SourceGoldUnit): boolean {
  const parsed = SourceEvidenceTargetSchema.safeParse(value);
  return parsed.success && sourceTargetJoinsGold({ rank: 0, object_kind: "source_evidence", target: parsed.data }, target);
}
function eventReference(event: ObservationEvent): EventReference {
  return { session_id: event.session_id, request_id: event.request_id, call_kind: event.call_kind, event_position: event.event_position };
}
function rangeOf(data: Record<string, unknown> | null): MessageByteInterval | null {
  return data !== null && nonnegative(data.start) && nonnegative(data.end) && data.end >= data.start
    ? { start: data.start, end: data.end } : null;
}
function nonnegative(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value >= 0; }
function positionOf(value: unknown): number | null { return nonnegative(value) ? value : null; }
function positions(value: unknown): number[] { return nonnegative(value) ? [value] : []; }
function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
