import { SourceEvidenceTargetSchema, SourceSemanticAcquisitionPhaseSchema, sourceRecallTarget,
  type SourceEvidenceTarget, type SourceSemanticAcquisitionPhase } from "@do-soul/alaya-protocol";
import { sourceTargetJoinsGold, type SourceGoldUnit } from "../measurement/source-gold-join.js";
import type { SourceSemanticObservation } from "../../../../core-daemon/src/runtime/recall-read-worker/source-semantic-observation.js";
import type { AnswerTurnSpan } from "./answer-spans.js";
import { byteIntervalsCoverSpan, type MessageByteInterval } from "./message-visibility.js";
import type { ObservationAdmittedRoot, ObservationAttributionInput, ObservationCallScope } from "./observation-attribution.js";

export type ObservationStage = "eligibility" | "nomination" | "access_read" | "package" | "delivery";
export type ObservationStageStatus = "passed" | "failed" | "unknown" | "not_run";
export type ObservationReadStatus = "whole" | "partial" | "attempted" | "none" | "unknown";
export type ObservationStagePosition = Readonly<{ stage: ObservationStage; reason: string }>;
type Events = SourceSemanticObservation["events"];
type Nomination = NonNullable<SourceSemanticAcquisitionPhase["result"]>["nominations"][number];
type NativePhaseFact = Readonly<{ invocation: "original" | "hint"; phase: SourceSemanticAcquisitionPhase | null }>;

export type ObservationReadInterval = MessageByteInterval & Readonly<{
  provenance: "source_read" | "observation_read_complete" | "verification_reuse" | "access_order";
  /** Zero-based position in this request's frozen event stream, not an access rank. */
  event_position: number;
}>;
export type ObservationNativeRoute = Readonly<{
  invocation: "original" | "hint"; channel: "lexical" | "vector";
  acquisition_status: SourceSemanticAcquisitionPhase["status"] | null;
  completion: string | null; reason: string | null; navigation_digest: string | null;
  lexical_ranks: Nomination["lexical"] | null; vector: Nomination["vector"];
  /** The native lexical nomination has no row/window byte bounds. */
  lexical_window: null;
  vector_state: NonNullable<SourceSemanticAcquisitionPhase["result"]>["vector"]["state"];
  limitations: readonly string[];
}>;
export type ObservationRouteFact = Readonly<{
  route: string; eligibility: ObservationStageStatus; nomination: ObservationStageStatus;
  access_read: ObservationReadStatus; package: ObservationStageStatus; delivery: ObservationStageStatus;
  native: ObservationNativeRoute | null;
  /** Native positions are zero-based. Access order is the policy's ordered pool, not read chronology. */
  access_positions: readonly number[]; union_positions: readonly number[];
  /** Returned body bytes only; metadata, requests and later accounting cannot create these. */
  read_intervals: readonly ObservationReadInterval[];
  /** Retained/analyzed prefixes and verified reuse, not another physical read. */
  coverage_intervals: readonly ObservationReadInterval[];
  first_failure: ObservationStagePosition | null; first_unknown: ObservationStagePosition | null;
  unknowns: readonly ObservationStagePosition[];
}>;
export type ObservationPackageFacts = Readonly<{
  candidates: readonly Readonly<{ target: SourceEvidenceTarget; access_position: number | null;
    proof_count: number | null; payload_support: string | null }>[];
  selected: readonly Readonly<{ target: SourceEvidenceTarget; page_position: number | null; slot_position: number }>[];
  /** Codec observations, not admitted consumer visibility. Actual preview validation remains with the shared scorer. */
  encoded: readonly Readonly<{ target: SourceEvidenceTarget; offset: number | null;
    preview_bytes: number | null; within_budget: boolean | null }>[];
}>;
export type ObservationMessageFacts = Readonly<{
  session_index: number; message_index: number; source_id: string; target: SourceGoldUnit;
  admission: "admitted" | "not_admitted" | "unknown"; matched_record_id: string | null;
  /** Per-message index/window proof, distinct from the parent's snapshot root map. */
  eligibility: ObservationStageStatus;
  candidate: "present" | "absent" | "unknown"; read: ObservationReadStatus;
  access_positions: readonly number[]; read_intervals: readonly ObservationReadInterval[];
  coverage_intervals: readonly ObservationReadInterval[]; packages: ObservationPackageFacts;
  routes: readonly ObservationRouteFact[];
  first_failure: ObservationStagePosition | null; first_unknown: ObservationStagePosition | null;
  unknowns: readonly ObservationStagePosition[];
}>;
type MutableRoute = {
  -readonly [Key in keyof Omit<ObservationRouteFact, "first_failure" | "first_unknown" | "unknowns">]: ObservationRouteFact[Key];
} & { unknowns: ObservationStagePosition[] };
const STAGES: readonly ObservationStage[] = ["eligibility", "nomination", "access_read", "package", "delivery"];

/** Parse the actual producer envelope: hint phases live under original.supplemental. */
function nativePhases(events: Events): NativePhaseFact[] {
  return events.filter(event => event.kind === "source_index_routes").flatMap(event => {
    const parsed = SourceSemanticAcquisitionPhaseSchema.safeParse(recordOf(event.data)?.original);
    const original = parsed.success ? parsed.data : null;
    return [{ invocation: "original" as const, phase: original }, ...(original?.supplemental ?? [])
      .map(phase => ({ invocation: "hint" as const, phase }))];
  });
}

/** A bounded acquisition receipt alone never closes the legal union or proves per-root eligibility. */
export function candidatePoolClosed(events: Events): boolean {
  const phases = nativePhases(events);
  if (phases.length === 0 || phases.some(({ phase }) => phase?.status !== "executed"
    || phase.accounting !== "complete" || phase.result?.completion !== "complete")) return false;
  const orders = events.filter(event => event.kind === "access_order");
  return orders.length > 0 && orders.every(event => {
    const data = recordOf(event.data);
    return Array.isArray(data?.sources) && Array.isArray(data.stopping_reasons) && data.stopping_reasons.length === 0;
  }) && !events.some(event => (event.kind === "package_candidates" || event.kind === "frozen_membership")
    && recordOf(event.data)?.incomplete === true);
}

export function observationMessageFacts(span: AnswerTurnSpan, input: ObservationAttributionInput,
  events: Events, complete: boolean, poolClosed: boolean,
  delivery: "passed" | "failed" | "unknown"): ObservationMessageFacts {
  const admitted = findAdmitted(input.admitted_roots, input.call, span.target);
  const admission = admitted.state === "not_admitted" && !input.admitted_roots_complete ? "unknown" : admitted.state;
  const matches = (value: unknown) => eventMatches(value, admitted.root, span.target);
  const routes = indexRoutes(events, span, complete);
  const snapshot = route("snapshot_admission");
  snapshot.eligibility = admission === "admitted" ? "not_run" : admission === "not_admitted" ? "failed" : "unknown";
  snapshot.nomination = "not_run";
  routes.unshift(snapshot);
  for (const name of new Set(["cursor", ...events.filter(event => event.kind === "union_admission")
    .flatMap(event => typeof recordOf(event.data)?.route === "string" ? [recordOf(event.data)!.route as string] : [])])) {
    const fact = route(`union:${name}`);
    const matching = events.filter(event => event.kind === "union_admission"
      && recordOf(event.data)?.route === name && matches(event.data));
    fact.nomination = matching.length > 0 ? "passed" : poolClosed ? "failed" : "unknown";
    fact.union_positions = matching.flatMap(event => positions(recordOf(event.data)?.position));
    routes.push(fact);
  }
  const readRoutes = observedReadRoutes(events, matches, span, complete);
  routes.push(...readRoutes);
  const packages = packageFacts(events, span.target);
  routes.push(...packageRoutes(events, packages, complete, delivery));
  const finished = routes.map(finalizeRoute);
  const readIntervals = readRoutes.flatMap(fact => fact.read_intervals);
  const coverage = readRoutes.flatMap(fact => fact.coverage_intervals);
  const read = readCoverage([...readIntervals, ...coverage], span,
    readRoutes.some(fact => fact.access_read === "unknown") || !complete,
    readRoutes.some(fact => fact.access_read === "attempted"));
  const candidate = routes.some(fact => !fact.route.startsWith("index:") && fact.nomination === "passed")
    ? "present" : complete && poolClosed ? "absent" : "unknown";
  const eligibility = admission === "not_admitted" ? "failed"
    : routes.some(fact => fact.route.startsWith("index:") && fact.eligibility === "passed") ? "passed" : "unknown";
  const failures = finished.flatMap(fact => fact.first_failure === null ? [] : [fact.first_failure]);
  if (read === "whole" && delivery === "failed") failures.push({ stage: "delivery", reason: "whole_message_read_not_visible" });
  const unknowns = finished.flatMap(fact => fact.unknowns);
  if (eligibility === "unknown") unknowns.push({ stage: "eligibility", reason: "per_message_index_eligibility_unavailable" });
  return { session_index: span.session_index, message_index: span.message_index, source_id: span.source_id,
    target: span.target, admission, eligibility, matched_record_id: admitted.root?.record_id ?? null,
    candidate, read, access_positions: readRoutes.flatMap(fact => fact.access_positions), read_intervals: readIntervals,
    coverage_intervals: coverage, packages, routes: finished, first_failure: earliestPosition(failures),
    first_unknown: earliestPosition(unknowns), unknowns };
}

function indexRoutes(events: Events, span: AnswerTurnSpan, complete: boolean): MutableRoute[] {
  const observed = nativePhases(events);
  const phases = (["original", "hint"] as const).flatMap<NativePhaseFact>(invocation => {
    const matching = observed.filter(row => row.invocation === invocation);
    return matching.length > 0 ? matching : [{ invocation, phase: null }];
  });
  return phases.flatMap(({ invocation, phase }) => {
    const result = phase?.result;
    const nomination = result?.nominations.find(row => targetMatches(row.source.target, span.target));
    return (["lexical", "vector"] as const).map(channel => {
      const fact = route(`index:${invocation}:${channel}`);
      const native = result?.[channel];
      const nominated = channel === "lexical" ? (nomination?.lexical.length ?? 0) > 0 : nomination?.vector != null;
      // Even complete native query schedules cover a bounded subset; missing rank is not nomination_limit.
      fact.nomination = nominated ? "passed" : phase?.status === "not_run" || native?.completion === "not_run"
        ? "not_run" : "unknown";
      fact.eligibility = nominated && nomination !== undefined && (channel === "lexical"
        ? nomination.source.body_bytes >= span.end
        : nomination.vector !== null && byteIntervalsCoverSpan([{ start: nomination.vector.window.start_byte,
          end: nomination.vector.window.end_byte }], span)) ? "passed" : "unknown";
      fact.native = { invocation, channel, acquisition_status: phase?.status ?? null,
        completion: native?.completion ?? null, reason: native?.reason ?? phase?.reason
          ?? (phase === null ? "native_route_not_observed_or_invalid" : null),
        navigation_digest: result?.navigation_digest ?? null, lexical_ranks: channel === "lexical" ? nomination?.lexical ?? null : null,
        vector: channel === "vector" ? nomination?.vector ?? null : null, lexical_window: null,
        vector_state: channel === "vector" ? result?.vector.state ?? null : null,
        limitations: [...(result?.limitations ?? []), ...(channel === "lexical" ? result?.lexical.limitations ?? [] : [])] };
      if (!nominated) fact.unknowns.push({ stage: "nomination", reason: `${channel}_rank_unavailable_not_individual_nomination_limit` });
      if (channel === "lexical" || nomination?.vector == null) fact.unknowns.push({ stage: "eligibility",
        reason: `${channel}_window_bounds_unavailable` });
      if (!complete) fact.unknowns.push({ stage: "nomination", reason: "observation_incomplete" });
      return fact;
    });
  });
}

/** Returned extents are captured before retention/scoring may fail. Completion and policy-order
 * rows instead certify analyzed prefixes; verified reuse certifies existing bytes, not fresh I/O. */
function observedReadRoutes(events: Events, matches: (value: unknown) => boolean,
  span: AnswerTurnSpan, complete: boolean): MutableRoute[] {
  const routes = new Map<string, MutableRoute>();
  for (const [position, event] of events.entries()) {
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
        const value = recordOf(row);
        fact.access_positions = [...fact.access_positions, ...positions(value?.position)];
        if (value !== null && nonnegative(value.read_bytes)
          && (!nonnegative(value.body_bytes) || value.read_bytes <= value.body_bytes)) {
          if (value.read_bytes > 0) fact.coverage_intervals = [...fact.coverage_intervals,
            { start: 0, end: value.read_bytes, event_position: position, provenance: "access_order" }];
        } else fact.unknowns.push({ stage: "access_read", reason: "analyzed_prefix_unavailable" });
      }
      continue;
    }
    if (!matches(event.data)) continue;
    fact.nomination = "passed";
    if (event.kind === "source_read_attempt" || data?.purpose === "observation_metadata" || data?.available === false) {
      fact.access_read = "attempted";
      continue;
    }
    const range = rangeOf(data);
    if (range === null || data !== null && nonnegative(data.body_bytes) && range.end > data.body_bytes) {
      fact.unknowns.push({ stage: "access_read", reason: "actual_read_interval_unavailable" }); continue;
    }
    if (range.end === range.start) continue;
    const interval = { ...range, event_position: position,
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
        payload_support: typeof row?.payload_support === "string" ? row.payload_support : null });
    }
    if (event.kind === "frozen_membership") for (const value of Array.isArray(data?.pages) ? data.pages : []) {
      const page = recordOf(value);
      for (const [position, value] of (Array.isArray(page?.targets) ? page.targets : []).entries()) {
        const parsed = SourceEvidenceTargetSchema.safeParse(value);
        if (parsed.success && targetMatches(parsed.data, target)) selected.push({ target: parsed.data,
          page_position: positionOf(page?.position), slot_position: position });
      }
    }
    if (event.kind === "encoded_membership") for (const value of Array.isArray(data?.results) ? data.results : []) {
      const row = recordOf(value), parsed = SourceEvidenceTargetSchema.safeParse(row?.target);
      if (parsed.success && targetMatches(parsed.data, target)) encoded.push({ target: parsed.data,
        offset: positionOf(data?.offset), preview_bytes: positionOf(row?.preview_bytes),
        within_budget: typeof row?.within_budget === "boolean" ? row.within_budget : null });
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
    delivery: "not_run", native: null, access_positions: [], union_positions: [], read_intervals: [], coverage_intervals: [], unknowns: [] };
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
  for (const stage of STAGES) { const found = positions.find(position => position.stage === stage); if (found !== undefined) return found; }
  return null;
}
function findAdmitted(map: ReadonlyMap<string, ObservationAdmittedRoot>, call: ObservationCallScope,
  target: SourceGoldUnit): Readonly<{ state: "admitted" | "not_admitted" | "unknown"; root: ObservationAdmittedRoot | null }> {
  const matches = [...map].filter(([key, root]) => key === root.record_id && root.snapshot_id === call.snapshot_id
    && root.index_generation === call.index_generation && sourceTargetJoinsGold({ rank: 0, object_kind: "source_evidence",
      target: sourceRecallTarget({ ...root.identity, evidence_object_id: null }) }, target)).map(([, root]) => root);
  return matches.length === 1 ? { state: "admitted", root: matches[0]! }
    : { state: matches.length === 0 ? "not_admitted" : "unknown", root: null };
}
function eventMatches(value: unknown, admitted: ObservationAdmittedRoot | null, target: SourceGoldUnit): boolean {
  const data = recordOf(value);
  if (data === null) return false;
  if (data.target !== undefined) return targetMatches(data.target, target);
  if (admitted === null || data.source_id !== undefined && data.source_id !== admitted.source_id
    || data.source_version !== undefined && data.source_version !== target.source_version
    || data.content_digest !== undefined && data.content_digest !== target.content_digest
    || data.workspace_id !== undefined && data.workspace_id !== target.workspace_id) return false;
  if (data.record_id !== undefined) return data.record_id === admitted.record_id;
  return data.source_id === admitted.source_id && data.source_version === target.source_version
    && data.content_digest === target.content_digest;
}
function targetMatches(value: unknown, target: SourceGoldUnit): boolean {
  const parsed = SourceEvidenceTargetSchema.safeParse(value);
  return parsed.success && sourceTargetJoinsGold({ rank: 0, object_kind: "source_evidence", target: parsed.data }, target);
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
