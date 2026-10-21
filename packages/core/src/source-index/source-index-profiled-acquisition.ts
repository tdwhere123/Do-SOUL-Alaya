import {
  SourceSemanticAccessProfileSchema, SourceSemanticNominationOccurrenceSchema, SourceSemanticProfiledAcquisitionPhaseSchema,
  SourceSemanticRetainedNominationWitnessSchema,
  SourceSemanticResourceLedger, SourceSemanticResourceExhausted,
  type FieldContractSha256, type SourceIndexQueryRepository, type SourceIndexQueryVector, type SourceIndexScopeAdmission,
  type SourceSemanticAccessProfile, type SourceSemanticNominationOccurrence,
  type SourceSemanticProfiledAcquisitionPhase
} from "@do-soul/alaya-protocol";
import { CoreError } from "../shared/errors.js";
import { createNativeRouteNomination, type NativeRouteLane, type NativeRouteAdmission } from "../recall/runtime/native-route-opportunity.js";
import { SourceIndexAcquisition, type SourceIndexAcquisitionObserver, type SourceIndexAcquisitionFact } from "./source-index-acquisition.js";

type Route = Readonly<{ navigation: string; vector: SourceIndexQueryVector }>;
type Capture = ReturnType<SourceIndexAcquisition["captureNative"]>;
type View = "original" | "hint";
type CapturedView = { view: View; capture: Capture };

/** Execution admission is stricter than a hashable schema-only profile. Shared with ingress before preparation. */
export function captureProfiledSourceIndexExecutionProfile(value: unknown): SourceSemanticAccessProfile {
  const profile = SourceSemanticAccessProfileSchema.parse(structuredClone(value));
  if (profile.declared_allowance.max_attempts < 1 || profile.declared_allowance.max_roots < 1 ||
      profile.acquisition_policy === "source-index-interleaved-prefix.v1" && profile.declared_allowance.max_roots > 16) {
    throw new CoreError("VALIDATION", "private acquisition requires an explicit funded root allowance within its policy ceiling");
  }
  return profile;
}

/** Temporary private comparison producer. The existing native acquisition owner captures
 * pages and validates vectors; the shared opportunity kernel alone schedules grouped work.
 * No diagnostic observer, provider, storage pagination or delivered-selection policy is used.
 */
export function acquireProfiledSourceIndex(input: Readonly<{
  repository: SourceIndexQueryRepository; sha256: FieldContractSha256; workspace: string;
  original: Route; hint?: Route; profile: SourceSemanticAccessProfile;
  budget: { work_units: number; memory_bytes: number }; admitScope: SourceIndexScopeAdmission;
  observe?: (view: View, capture: Parameters<SourceIndexAcquisitionObserver>[0], kind: SourceIndexAcquisitionFact["kind"]) => void;
}>) {
  const meter = new SourceSemanticResourceLedger(input.budget), resources = { native_bytes: 0 };
  try { return runProfiledAcquisition(input, meter, resources); }
  catch (error) {
    throw new CoreError(error instanceof SourceSemanticResourceExhausted ? "CONFLICT" : "VALIDATION",
      error instanceof Error ? error.message : "source acquisition failed with unknown additional native cost", {
        ...(error instanceof SourceSemanticResourceExhausted ? { subCode: "RETRYABLE_BACKPRESSURE" as const } : {}),
        details: { index_resources: { work: meter.spentWork, memory_bytes: meter.spentBytes,
          native_bytes: resources.native_bytes, sql_internal_work: "unknown" }, native_accounting: "partial" }
      });
  }
}

function runProfiledAcquisition(input: Parameters<typeof acquireProfiledSourceIndex>[0], meter: SourceSemanticResourceLedger,
  resources: { native_bytes: number }) {
  const profile = captureProfiledSourceIndexExecutionProfile(input.profile);
  const allowance = profile.declared_allowance;
  const views: CapturedView[] = [];
  const grouped = profile.acquisition_policy === "source-index-grouped-round-robin.v1";
  const witness: SourceSemanticNominationOccurrence[] = [];
  const acquisition = new SourceIndexAcquisition(input.repository, input.sha256);
  let attempts = 0, windows = 0, roots = 0;
  for (const [view, route] of [["original", input.original], ["hint", input.hint]] as const) {
    if (route === undefined || view === "hint" && route.navigation === input.original.navigation) continue;
    const remaining = { max_attempts: allowance.max_attempts - attempts, max_roots: allowance.max_roots - roots,
      max_vector_windows: allowance.max_vector_windows - windows };
    if (!grouped && (remaining.max_attempts === 0 || remaining.max_roots === 0)) continue;
    const captured = acquisition.captureNative({ workspace_id: input.workspace, navigation_text: route.navigation,
      vector: route.vector, allowance: remaining, budget: meter.remaining() }, input.admitScope, view, grouped, profile.channels,
      input.observe === undefined ? undefined : (capture, kind) => input.observe!(view, capture, kind));
    meter.charge(captured.result.resources.work, captured.result.resources.memory_bytes, "source native captured acquisition");
    resources.native_bytes += captured.result.resources.native_bytes;
    views.push({ view, capture: captured });
    windows += captured.result.vector.inspected_windows;
    if (!grouped) {
      for (const occurrence of captured.retained) witness.push({ ...occurrence, attempt: occurrence.attempt + attempts });
      attempts += captured.result.accounting.attempted;
      roots += captured.result.nominations.length;
    }
  }
  const lanes = capturedLanes(views, profile.channels, input.hint !== undefined && input.hint.navigation !== input.original.navigation);
  const refusals = views.flatMap(row => row.capture.result.resource_refusals);
  const progress = grouped ? nominateGrouped(input, profile, meter, lanes, views, witness, refusals.length > 0, resources) : undefined;
  const retainedRoots = new Set(witness.map(row => row.source.root_key));
  const counts = progress === undefined ? legacyCounts(views, witness, retainedRoots.size) : {
    attempts: progress.counts.attempts_consumed, retained_occurrences: witness.length,
    distinct_roots: progress.counts.admitted_roots, duplicate_occurrences: progress.counts.duplicate_occurrences,
    denied: progress.counts.denied, unknown: progress.counts.unknown, nomination_limit: progress.counts.nomination_limit,
    resource_refused_before_start: progress.counts.resource_refused_before_start,
    resource_refused_after_start: progress.counts.resource_refused_after_start
  };
  if (grouped && refusals.some(row => row.phase !== "acquisition_failed_unknown_additional_cost") && counts.attempts === 0) counts.resource_refused_before_start = 1;
  if (progress !== undefined) for (const row of progress.trace) {
    if (row.outcome.status === "resource_refused") refusals.push({ stage: "admission", phase: row.outcome.reason });
  }
  const original = views[0]!.capture.result;
  const nominations = [...new Map(witness.map(row => [row.source.root_key, row.source])).values()];
  const failed = views.some(row => row.capture.result.resource_refusals.some(refusal => refusal.phase === "acquisition_failed_unknown_additional_cost"));
  const phase: SourceSemanticProfiledAcquisitionPhase = {
    policy: profile.acquisition_policy, channels: profile.channels, declared_allowance: allowance,
    allowance, budget: { work_units: input.budget.work_units, memory_bytes: input.budget.memory_bytes }, status: failed ? "failed" : "executed", reason: failed ? "acquisition_failed" : null, accounting: failed ? "partial" : "complete",
    result: {
      navigation_digest: original.navigation_digest,
      completion: refusals.length > 0 || counts.unknown > 0 || counts.nomination_limit > 0 || progress?.stop === "attempt_limit" ||
        views.some(row => row.capture.result.completion !== "complete") ? "partial" : "complete",
      occurrence_prefix: witness.slice(0, 16), prefix_coverage: { kind: "retained_occurrence_prefix", omitted_occurrences: Math.max(0, witness.length - 16) },
      counts, lanes: laneProgress(lanes, views, progress), resources: {
        work: meter.spentWork, memory_bytes: meter.spentBytes,
        native_bytes: resources.native_bytes,
        sql_internal_work: "unknown"
      },
      resource_refusals: refusals, lexical: original.lexical,
      vector: { ...original.vector, inspected_windows: windows,
        invalid_windows: views.reduce((sum, row) => sum + row.capture.result.vector.invalid_windows, 0) },
      limitations: original.limitations
    }
  };
  // Charge validation, full retained witness, prefix framing and every extra reference.
  const retainedWitness = SourceSemanticResourceLedger.capture(witness, value => SourceSemanticRetainedNominationWitnessSchema.parse(value),
    "source full retained occurrence witness", meter);
  meter.retain(phase, "source profiled acquisition receipt");
  const result = phase.result!;
  const charged = { ...phase, result: { ...result, resources: { ...result.resources, work: meter.spentWork, memory_bytes: meter.spentBytes } } };
  return { phase: SourceSemanticProfiledAcquisitionPhaseSchema.parse(charged), witness: retainedWitness, nominations };
}

function capturedLanes(views: readonly CapturedView[], channels: SourceSemanticAccessProfile["channels"], hintPresent: boolean): NativeRouteLane[] {
  return (["original", "hint"] as const).flatMap(view => (["lexical", "vector"] as const).map(route => {
    const capture = views.find(row => row.view === view)?.capture;
    const base = { lane: `${view}-${route}` as const, scope: "original" };
    if (channels !== "dual" && channels !== route) return { ...base, state: "disabled" as const };
    if (capture === undefined) return view === "hint" && hintPresent
      ? { ...base, state: "unavailable" as const, reason: "shared_nomination_allowance" }
      : { ...base, state: "absent" as const };
    const occurrences = route === "lexical" ? capture.lexical.map(row => ({ reference: `${view}:lexical:${row.lexical.rank}`,
      root_key: row.source.root_key, native_rank: row.lexical.rank })) : capture.vector.map(row => ({
      reference: `${view}:vector:${row.vector.rank}`, root_key: row.source.root_key, native_rank: row.vector.rank,
      window: { status: "captured" as const, reference: row.vector.window.window_id, start: row.vector.window.start_byte, end: row.vector.window.end_byte }
    }));
    if (occurrences.length > 0) return { ...base, state: "exact-captured" as const, occurrences };
    const evidence = capture.result[route];
    return evidence.completion === "complete" ? { ...base, state: "measured-empty" as const }
      : { ...base, state: "unavailable" as const, reason: evidence.reason ?? "native_page_unavailable" };
  }));
}

function nominateGrouped(input: Parameters<typeof acquireProfiledSourceIndex>[0], profile: SourceSemanticAccessProfile, meter: SourceSemanticResourceLedger,
  lanes: readonly NativeRouteLane[], views: readonly CapturedView[], witness: SourceSemanticNominationOccurrence[], refused: boolean,
  resources: { native_bytes: number }) {
  meter.retain(lanes, "source grouped opportunity capture");
  const nomination = createNativeRouteNomination({ lanes, ...profile.declared_allowance });
  if (refused) return nomination.snapshot();
  for (let pending = nomination.next(); pending !== null; pending = nomination.next()) {
    const [view, channel] = pending.lane.split("-") as [View, "lexical" | "vector"];
    const capture = views.find(row => row.view === view)!.capture;
    const lexical = channel === "lexical" ? capture.lexical.find(row => row.lexical.rank === pending!.occurrence.native_rank) : undefined;
    const vector = channel === "vector" ? capture.vector.find(row => row.vector.rank === pending!.occurrence.native_rank) : undefined;
    const source = lexical?.source ?? vector!.source;
    let started: string | null = null;
    let native: Extract<SourceIndexAcquisitionFact, { kind: "nomination_attempt" }>["admission"];
    const commit = (outcome: NativeRouteAdmission) => {
      const decision = nomination.commit(pending!.ordinal, outcome);
      if (input.observe !== undefined) {
        try { input.observe(view, () => ({ kind: "nomination_attempt", channel, target: structuredClone(source.target),
          disposition: decision === "admitted_new_root" ? "admitted" : decision === "admitted_duplicate" ? "duplicate"
            : decision === "denied" ? native?.status === "stale" ? "stale" : "scope_denied" : decision === "admission_unknown" ? "native_unknown" : decision,
          ...(native === undefined ? {} : { admission: native }),
          ...(decision === "admitted_duplicate" ? { merge_target: structuredClone(source.target) } : {}),
          ...(outcome.status === "resource_refused" ? { resource_refusal: { stage: "admission", phase: outcome.reason } } : {})
        }), "nomination_attempt"); } catch { /* Diagnostic capture never controls acquisition. */ }
      }
      return decision;
    };
    try {
      meter.charge(1 + source.root_key.length, 0, "source nomination attempt"); started = "admission";
      const admission = input.repository.admitQueryCandidate(source, channel === "vector" ? capture.binding : null, meter.remaining());
      meter.charge(admission.resources.work, admission.resources.memory_bytes, "source native nomination admission");
      resources.native_bytes += admission.resources.native_bytes;
      if (admission.status !== "ready") native = admission.status === "resource_limited"
        ? { status: admission.status, reason: admission.reason, phase: admission.phase } : { status: admission.status, reason: admission.reason };
      if (admission.status === "resource_limited") {
        commit({ status: "resource_refused", started_phase: started, reason: admission.phase }); break;
      }
      if (admission.status !== "ready") {
        commit({ status: admission.status === "stale" ? "denied" : "unknown", started_phase: started, reason: admission.reason }); continue;
      }
      meter.charge(1 + (admission.scope_class?.length ?? 0), 0, "source scope admission");
      const scope = input.admitScope(admission.scope_class, source);
      if (scope === "denied") {
        commit({ status: "denied", started_phase: started, reason: "scope_denied" }); continue;
      }
      if (scope !== "admitted") throw new CoreError("VALIDATION", "invalid source scope admission result");
      const occurrence = SourceSemanticNominationOccurrenceSchema.parse({ reference: pending.occurrence.reference,
        attempt: pending.ordinal, source, view, route: lexical === undefined
          ? { kind: "vector", native_rank: vector!.vector.rank, cosine: vector!.vector.cosine,
            window: { status: "available", window: vector!.vector.window } }
          : { kind: "lexical", native_rank: lexical.lexical.rank, lane: lexical.lexical.lane,
            lane_rank: lexical.lexical.lane_rank, bm25: lexical.lexical.bm25 } });
      meter.retain(occurrence, "source retained nomination occurrence");
      const decision = commit({ status: "admitted", started_phase: started });
      if (decision === "admitted_new_root" || decision === "admitted_duplicate") witness.push(occurrence);
    } catch (error) {
      if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
      commit({ status: "resource_refused", started_phase: started, reason: error.phase }); break;
    }
  }
  const snapshot = nomination.snapshot();
  meter.retain(snapshot, "source grouped opportunity progress");
  return snapshot;
}

type Progress = ReturnType<typeof nominateGrouped>;
function laneProgress(lanes: readonly NativeRouteLane[], views: readonly CapturedView[], progress: Progress | undefined) {
  return lanes.map((lane, index) => {
    const [view, route] = lane.lane.split("-") as [View, "lexical" | "vector"];
    const occurrences = lane.state === "exact-captured" ? lane.occurrences : [];
    const consumed = progress?.lanes[index]?.consumed_occurrences ?? views.find(row => row.view === view)?.capture.progress[route] ?? 0;
    return { view, route, availability: lane.state === "exact-captured" ? { status: "captured" as const, captured_occurrences: occurrences.length }
      : lane.state === "unavailable" ? { status: "unavailable" as const, reason: lane.reason }
      : { status: lane.state === "measured-empty" ? "measured_empty" as const : lane.state },
    consumed_occurrences: consumed, remaining_captured_occurrences: occurrences.length - consumed,
    last_native_rank: consumed === 0 ? null : occurrences[consumed - 1]!.native_rank };
  });
}
function legacyCounts(views: readonly CapturedView[], witness: readonly SourceSemanticNominationOccurrence[], roots: number) {
  const sum = (key: keyof Capture["result"]["accounting"]) => views.reduce((n, row) => n + row.capture.result.accounting[key], 0);
  const attempts = sum("attempted"), unknown = sum("native_unknown"), after = sum("resource_refused");
  const nomination_limit = sum("nomination_limit");
  return { attempts, retained_occurrences: witness.length, distinct_roots: roots, duplicate_occurrences: witness.length - roots,
    denied: attempts - witness.length - unknown - after - nomination_limit, unknown, nomination_limit,
    resource_refused_before_start: after === 0 && views.some(row => row.capture.result.resource_refusals
      .some(refusal => refusal.phase !== "acquisition_failed_unknown_additional_cost")) ? 1 : 0,
    resource_refused_after_start: after };
}
