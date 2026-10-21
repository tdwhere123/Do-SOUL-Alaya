import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => { isolation.restore(); });
import { sourceIndexTarget, SourceSemanticProfiledAcquisitionPhaseSchema,
  SourceSemanticRetainedNominationWitnessSchema, sourceSemanticRetainedWitnessMatchesPhase,
  type SourceSemanticNominationOccurrence, type SourceSemanticProfiledAcquisitionPhase } from "@do-soul/alaya-protocol";
import type { SourceSemanticObservation } from "../../../../../core-daemon/src/runtime/recall-read-worker/source-semantic-observation.js";
import { attributeObservation, type ObservationCallScope, type ObservationCapturedFrame } from "../../../runs/longmemeval-semantic/observation-attribution.js";
import { scoreConsumerMessageVisibility } from "../../../runs/longmemeval-semantic/message-visibility.js";

const DIGEST = `sha256:${"ab".repeat(32)}`;
const identity = (index: number) => ({ workspace_id: "ws", root_kind: "source_record" as const,
  root_id: `sha256:${index.toString(16).padStart(64, "0")}`, source_version: "1", content_digest: DIGEST });
const source = (index: number) => sourceIndexTarget({ kind: "source_evidence", ...identity(index), evidence_object_id: null }, `source-${index}`, 128);
const window = (start: number) => ({ window_id: DIGEST, content_digest: DIGEST, start_byte: start, end_byte: start + 20 });
const views = ["original", "hint"] as const, channels = ["lexical", "vector"] as const;
const call: ObservationCallScope = { kind: "prepare_query", request_id: 7, session_id: "session", query_key: "synthetic",
  snapshot_id: DIGEST, workspace_id: "ws", as_of: "2026-10-20T00:00:00Z" };
const nativeFacts: NonNullable<SourceSemanticObservation["facts"]> = {
  binding: { session_id: "session", request_id: 7, operation: "prepare_query", workspace_id: "ws",
    as_of: call.as_of, snapshot_revision: "1:0", preparation: null, index: null },
  pool: null, lease_reads: [], lease_issues: [], operations: [], encodings: [], complete: true, issues: [] };

// Authored synthetic evidence: twenty roots in four lanes, then four duplicate-root occurrences.
// Native ranks intentionally differ from array positions and from the other lanes' ranks.
function fixture() {
  const witness: SourceSemanticNominationOccurrence[] = [];
  for (let index = 0; index <= 20; index++) for (const [viewIndex, view] of views.entries()) for (const channel of channels) {
    const rank = (channel === "lexical" ? 100 : 300) + viewIndex * 100 + index + 1;
    witness.push({ reference: `${view}:${channel}:${rank}`, attempt: witness.length + 1, source: source(Math.min(index, 19)), view,
      route: channel === "lexical" ? { kind: channel, native_rank: rank, lane: index === 20 ? "trigram" : "unicode61",
        lane_rank: index === 20 ? 1 : index + 1, bm25: index === 20 ? -0.25 : -(index + 1) }
        : { kind: channel, native_rank: rank, cosine: 0.75,
          window: { status: "available", window: window(index === 20 ? 80 : viewIndex * 40) } } });
  }
  const phase: SourceSemanticProfiledAcquisitionPhase = {
    policy: "source-index-grouped-round-robin.v1", channels: "dual", status: "executed", reason: null, accounting: "complete",
    declared_allowance: { max_attempts: 128, max_roots: 20, max_vector_windows: 4096 },
    allowance: { max_attempts: 128, max_roots: 20, max_vector_windows: 4096 }, budget: { work_units: 100000, memory_bytes: 1000000 },
    result: { navigation_digest: DIGEST, completion: "complete", occurrence_prefix: witness.slice(0, 16),
      prefix_coverage: { kind: "retained_occurrence_prefix", omitted_occurrences: 68 },
      counts: { attempts: 84, retained_occurrences: 84, distinct_roots: 20, duplicate_occurrences: 64,
        denied: 0, unknown: 0, nomination_limit: 0, resource_refused_before_start: 0, resource_refused_after_start: 0 },
      lanes: views.flatMap((view, viewIndex) => channels.map(route => ({ view, route,
        availability: { status: "captured" as const, captured_occurrences: 21 }, consumed_occurrences: 21,
        remaining_captured_occurrences: 0, last_native_rank: (route === "lexical" ? 100 : 300) + viewIndex * 100 + 21 }))),
      resources: { work: 5, memory_bytes: 100, native_bytes: 20, sql_internal_work: "unknown" }, resource_refusals: [],
      lexical: { completion: "complete", index_coverage: "partial", reason: null, limitations: [], tokenization: null },
      vector: { completion: "complete", state: { status: "unbound", reason: "no_active_generation" }, reason: null,
        inspected_windows: 42, invalid_windows: 0, validation: "validated", ranking: "exact_over_inspected_subset",
        input: { status: "available", profile_id: DIGEST, input_digest: DIGEST } }, limitations: [] }
  };
  expect(SourceSemanticProfiledAcquisitionPhaseSchema.safeParse(phase).success).toBe(true);
  expect(SourceSemanticRetainedNominationWitnessSchema.safeParse(witness).success).toBe(true);
  expect(sourceSemanticRetainedWitnessMatchesPhase(witness, phase)).toBe(true);
  return { candidate_phase: phase, retained_occurrences: witness };
}
function project(data: unknown, index = 19, extra: Partial<SourceSemanticObservation> = {}, events: SourceSemanticObservation["events"] = [],
  capture: (frame: ObservationCapturedFrame) => readonly ObservationCapturedFrame[] = frame => [frame], scope = call) {
  const answer = { unit: "published_body_utf8_bytes" as const, annotated_turns: 1, complete: true,
    spans: [{ session_index: 0, message_index: 0, source_id: `source-${index}`, target: identity(index), start: 10, end: 20 }] };
  const observation: SourceSemanticObservation = { version: 1, request_id: 7, status: "observed", execution: "success",
    events: [{ kind: "source_index_routes", phase: "observation", data }, ...events],
    facts: nativeFacts,
    costs: [], meters: [], totals: { debit_work: 0, debit_bytes: 0, absorb_work: 0, absorb_bytes: 0 },
    dropped_events: 0, aggregates_complete: true, issues: [], overhead: { capture_ms: 0, event_json_bytes: 0,
      ipc_bytes: null, ipc_time: "not_measured", physical_peak_memory: "not_measured", physical_sql_work: "not_measured" }, ...extra };
  return attributeObservation({ question_id: "synthetic", k: 5, call: scope, frames: capture({ call: scope, observation }), frozen_index: null,
    admitted_roots: new Map(), admitted_roots_complete: false, answer_gold: answer,
    visibility: scoreConsumerMessageVisibility({ gold: answer, pages: [] }) });
}
function route(result: ReturnType<typeof project>, view: typeof views[number], channel: typeof channels[number]) {
  return result.messages[0]!.routes.find(row => row.route === `index:${view}:${channel}`)!;
}

it.each(["facts_omitted", "binding_null"] as const)("withholds full and prefix authority with %s while retaining diagnostics", state => {
  const facts = state === "facts_omitted" ? undefined : { ...nativeFacts, binding: null };
  for (const index of [0, 19]) {
    const data = fixture();
    const result = project({ ...data, retained_occurrences: null }, index, { facts }, [
      { kind: "source_index_acquisition", phase: "observation", data: { invocation: "original", kind: "lexical_candidate",
        target: source(index).target, rank: -1, lane: "unicode61", lane_rank: 1, bm25: -2 } },
      { kind: "source_index_acquisition", phase: "observation", data: { invocation: "hint", kind: "vector_ranked",
        target: source(index).target, rank: 3, cosine: 0.5, window: { ...window(0), window_id: "invalid" } } },
      ...["admitted", "resource_refused"].map(disposition => ({ kind: "source_index_acquisition", phase: "observation",
        data: { invocation: "hint", kind: "nomination_attempt", channel: "vector", target: source(index).target, disposition,
          resource_refusal: { stage: "invalid", phase: "synthetic" } } }))
    ]);
    expect(result.observation).toMatchObject({ complete: false, progress_complete: false, snapshot_bound: false });
    expect(result.observation.issues).toContain("native_call_binding_unavailable");
    if (state === "facts_omitted") expect(result.observation.issues).toContain("native_ancestry_detail_incomplete");
    for (const view of views) for (const channel of channels) {
      expect(route(result, view, channel)).toMatchObject({ nomination: "unknown", first_failure: null, native: {
        acquisition_status: null, completion: null, navigation_digest: null, lexical_ranks: null, vector: null,
        retained_occurrences: null, occurrence_evidence: "unavailable", attempts: null } });
      expect(route(result, view, channel).diagnostic_issues).toContainEqual(expect.objectContaining({ field: "retained_occurrences" }));
    }
    expect(result.messages[0]?.diagnostic_issues.map(issue => issue.field)).toEqual([
      "retained_occurrences", "lexical_rank", "retained_occurrences", "retained_occurrences",
      "retained_occurrences", "vector_rank", "resource_refusal", "resource_refusal"]);
    expect(result.messages[0]?.first_unknown?.stage).toBe("eligibility");
    // An internally consistent full witness still lacks call authority.
    for (const view of views) for (const channel of channels) expect(route(project(data, index, { facts }), view, channel))
      .toMatchObject({ nomination: "unknown", native: { retained_occurrences: null, lexical_ranks: null, vector: null } });
  }
});

it.each([
  { session_id: "foreign" }, { request_id: 8 }, { operation: "recall" as const },
  { workspace_id: "foreign" }, { as_of: "2026-10-21T00:00:00Z" }
])("rejects a present mismatched binding %j", mismatch => {
  const result = project(fixture(), 19, { facts: { ...nativeFacts, binding: { ...nativeFacts.binding!, ...mismatch } } });
  expect(result.observation.issues).toEqual(["native_call_binding_mismatch"]);
  for (const view of views) for (const channel of channels) expect(route(result, view, channel))
    .toMatchObject({ nomination: "unknown", native: { lexical_ranks: null, vector: null } });
});

it("does not borrow a foreign or ambiguous frame's retained authority", () => {
  const data = fixture();
  const foreign = project(data, 19, { facts: undefined }, [], frame => [frame, {
    call: { ...call, query_key: "foreign", request_id: 8 }, observation: { ...frame.observation, request_id: 8,
      facts: { ...nativeFacts, binding: { ...nativeFacts.binding!, request_id: 8 } } } }]);
  for (const view of views) for (const channel of channels) expect(route(foreign, view, channel).nomination).toBe("unknown");
  for (const capture of [(frame: ObservationCapturedFrame) => [frame, frame],
    (frame: ObservationCapturedFrame) => [frame, { ...frame, call: { ...call, query_key: "foreign" } }]]) {
    const result = project(data, 19, {}, [], capture);
    expect(result.observation.status).toBe("ambiguous");
    for (const view of views) for (const channel of channels) expect(route(result, view, channel).nomination).toBe("unknown");
  }
});

it.each(["native_detail", "event_overflow", "snapshot_unsealed"] as const)("preserves bound partial proof with %s", state => {
  const result = project(fixture(), 19, state === "native_detail" ? {
    facts: { ...nativeFacts, complete: false, issues: ["synthetic_detail_omitted"] } }
    : state === "event_overflow" ? { status: "overflow", dropped_events: 1, issues: ["synthetic_event_overflow"] } : {}, [],
  frame => [frame], { ...call, snapshot_id: state === "snapshot_unsealed" ? null : call.snapshot_id });
  for (const [viewIndex, view] of views.entries()) for (const channel of channels) {
    expect(route(result, view, channel)).toMatchObject({ nomination: "passed", native: { occurrence_evidence: "full_retained" } });
    expect(route(result, view, channel).native?.retained_occurrences).toHaveLength(2);
    if (channel === "lexical") expect(route(result, view, channel).native?.lexical_ranks?.map(row => row.rank))
      .toEqual([120 + viewIndex * 100, 121 + viewIndex * 100]);
    else expect(route(result, view, channel).native?.vector?.rank).toBe(320 + viewIndex * 100);
  }
  expect(result.observation).toMatchObject({ complete: false, progress_complete: false });
  expect(result.messages[0]?.first_unknown?.stage).toBe("eligibility");
  if (state === "native_detail") expect(result.observation.issues).toContain("native_fact:synthetic_detail_omitted");
});

it.each(["absent", "omitted"] as const)("projects all retained lanes beyond the prefix with optional diagnostics %s", detail => {
  const data = fixture();
  const diagnostics = detail === "omitted" ? { status: "overflow" as const, compacted_events: 0, omitted_events: 6,
    counts: { source_index_original_lexical_candidate: 1, source_index_hint_lexical_candidate: 1,
      source_index_original_vector_ranked: 1, source_index_hint_vector_ranked: 1,
      source_index_original_vector_inspected: 1, source_index_hint_vector_inspected: 1 },
    omitted_counts: { source_index_original_lexical_candidate: 1, source_index_hint_lexical_candidate: 1,
      source_index_original_vector_ranked: 1, source_index_hint_vector_ranked: 1,
      source_index_original_vector_inspected: 1, source_index_hint_vector_inspected: 1 } } : undefined;
  const result = project(data, 19, { diagnostics });
  for (const [viewIndex, view] of views.entries()) for (const channel of channels) {
    const fact = route(result, view, channel);
    expect(fact).toMatchObject({ nomination: "passed", eligibility: "unknown", access_read: "unknown",
      package: "not_run", delivery: "not_run", diagnostic_issues: [], native: { occurrence_evidence: "full_retained", attempts: null } });
    expect(fact.native?.retained_occurrences).toHaveLength(2);
    expect(fact.unknowns).not.toContainEqual({ stage: "nomination", reason: `${channel}_rank_unavailable` });
    expect(fact.first_unknown?.stage).toBe("eligibility");
    if (channel === "lexical") {
      expect(fact.native?.lexical_ranks).toEqual([
        { rank: 120 + viewIndex * 100, lane: "unicode61", lane_rank: 20, bm25: -20 },
        { rank: 121 + viewIndex * 100, lane: "trigram", lane_rank: 1, bm25: -0.25 }]);
      expect(fact.native?.lexical_window).toBeNull();
      if (detail === "omitted") expect(fact.unknowns).toContainEqual({ stage: "nomination", reason: "lexical_candidate_detail_unavailable" });
    } else {
      expect(fact.native?.vector).toEqual({ rank: 320 + viewIndex * 100, cosine: 0.75, window: window(viewIndex * 40) });
      expect(fact.native?.retained_occurrences?.map(row => row.route)).toEqual([
        { kind: "vector", native_rank: 320 + viewIndex * 100, cosine: 0.75, window: { status: "available", window: window(viewIndex * 40) } },
        { kind: "vector", native_rank: 321 + viewIndex * 100, cosine: 0.75, window: { status: "available", window: window(80) } }]);
      if (detail === "omitted") expect(fact.unknowns).toContainEqual({ stage: "nomination", reason: "vector_inspection_detail_unavailable" });
    }
  }
  expect(result.messages[0]).toMatchObject({ eligibility: "unknown", candidate: "unknown", read: "none",
    read_intervals: [], coverage_intervals: [], first_unknown: { stage: "eligibility" },
    finite_union: { full_universe: "not_established" }, visibility: { delivery: "unknown", visible_intervals: [] } });
});

it.each(["missing", "unavailable", "mixed"] as const)("keeps vector nomination and native ranks independent of %s windows", state => {
  const data = fixture();
  data.retained_occurrences = data.retained_occurrences.map(row => row.source.source_id !== "source-19" || row.route.kind !== "vector"
    || state === "mixed" && row.attempt > 80 ? row : { ...row, route: { kind: "vector", native_rank: row.route.native_rank,
      cosine: row.route.cosine, ...(state === "missing" ? {} : { window: { status: "unavailable", reason: "synthetic_window_not_retained" } }) } });
  // Synthetic diagnostic claims cannot fill an omitted/unavailable retained window or replace its rank.
  const result = project(data, 19, {}, views.map(invocation => ({ kind: "source_index_acquisition", phase: "observation",
    data: { invocation, kind: "vector_ranked", target: source(19).target, rank: 3, cosine: 0.5, window: window(20) } })));
  for (const [viewIndex, view] of views.entries()) {
    const fact = route(result, view, "vector");
    expect(fact.nomination).toBe("passed");
    expect(fact.native?.occurrence_evidence).toBe("full_retained");
    expect(fact.native?.retained_occurrences?.map(row => row.route.native_rank)).toEqual([320 + viewIndex * 100, 321 + viewIndex * 100]);
    expect(fact.unknowns).not.toContainEqual({ stage: "nomination", reason: "vector_rank_unavailable" });
    if (state === "mixed") expect(fact.native?.vector).toEqual({ rank: 321 + viewIndex * 100, cosine: 0.75, window: window(80) });
    else expect(fact.native?.vector).toBeNull();
    const first = fact.native?.retained_occurrences?.[0]?.route;
    if (state === "missing") expect(first).not.toHaveProperty("window");
    else expect(first).toHaveProperty("window", { status: "unavailable", reason: "synthetic_window_not_retained" });
    expect(fact.access_read).toBe("unknown");
  }
});

it.each(["missing", "unavailable"] as const)("recognizes prefix participation with %s vector windows without a full witness", state => {
  const data = fixture();
  const prefix = data.candidate_phase.result!.occurrence_prefix.map(row => row.route.kind !== "vector" ? row : {
    ...row, route: { kind: "vector" as const, native_rank: row.route.native_rank, cosine: row.route.cosine,
      ...(state === "missing" ? {} : { window: { status: "unavailable" as const, reason: "synthetic_window_not_retained" } }) } });
  const result = project({ candidate_phase: { ...data.candidate_phase, result: { ...data.candidate_phase.result, occurrence_prefix: prefix } } }, 0);
  for (const view of views) expect(route(result, view, "vector")).toMatchObject({ nomination: "passed",
    native: { occurrence_evidence: "displayed_prefix", vector: null, retained_occurrences: [{ route: { kind: "vector" } }] } });
});

it("keeps valid-empty, unavailable, absent and disabled lane states distinct without claiming corpus exhaustion", () => {
  const data = fixture(), result = data.candidate_phase.result!;
  const empty = { ...data.candidate_phase, result: { ...result, occurrence_prefix: [],
    prefix_coverage: { kind: "retained_occurrence_prefix" as const, omitted_occurrences: 0 },
    counts: { attempts: 0, retained_occurrences: 0, distinct_roots: 0, duplicate_occurrences: 0,
      denied: 0, unknown: 0, nomination_limit: 0, resource_refused_before_start: 0, resource_refused_after_start: 0 },
    lanes: result.lanes.map((lane, index) => ({ ...lane, consumed_occurrences: 0, remaining_captured_occurrences: 0, last_native_rank: null,
      availability: [{ status: "measured_empty" }, { status: "unavailable", reason: "synthetic_unavailable" },
        { status: "absent" }, { status: "disabled" }][index] })), vector: { ...result.vector, inspected_windows: 0 } } };
  const phase = SourceSemanticProfiledAcquisitionPhaseSchema.parse(empty);
  expect(sourceSemanticRetainedWitnessMatchesPhase([], phase)).toBe(true);
  const projected = project({ candidate_phase: phase, retained_occurrences: [] });
  expect(route(projected, "original", "lexical")).toMatchObject({ nomination: "unknown", native: { completion: "complete" } });
  expect(route(projected, "original", "vector")).toMatchObject({ nomination: "unknown", native: { reason: "synthetic_unavailable" } });
  expect(route(projected, "hint", "lexical").nomination).toBe("not_run");
  expect(route(projected, "hint", "vector").nomination).toBe("not_run");
  for (const view of views) for (const channel of channels) expect(route(projected, view, channel)).toMatchObject({
    first_failure: null, native: { occurrence_evidence: "full_retained", retained_occurrences: [], vector: null, lexical_ranks: null } });
  expect(projected.messages[0]?.finite_union.full_universe).toBe("not_established");
  const unbound = project({ candidate_phase: phase, retained_occurrences: [] }, 19, { facts: undefined });
  for (const view of views) for (const channel of channels) expect(route(unbound, view, channel)).toMatchObject({
    nomination: "unknown", first_failure: null, native: { completion: null, acquisition_status: null,
      retained_occurrences: null, occurrence_evidence: "unavailable" } });
});

it.each(["missing", "null", "invalid_rank", "invalid_window", "count_mismatch", "prefix_mismatch", "duplicate_reference"] as const)(
  "uses only the validated prefix when complete witness is %s", state => {
    const data = fixture();
    let retained: unknown = data.retained_occurrences;
    if (state === "null") retained = null;
    if (state === "count_mismatch") retained = data.retained_occurrences.slice(0, 80);
    if (state === "prefix_mismatch") retained = data.retained_occurrences.map((row, index) => index === 0 ? { ...row, reference: "different" } : row);
    if (state === "duplicate_reference") retained = data.retained_occurrences.map((row, index) => index === 83 ? { ...row, reference: data.retained_occurrences[0]!.reference } : row);
    if (state === "invalid_rank" || state === "invalid_window") retained = data.retained_occurrences.map((row, index) => index !== 83 ? row : {
      ...row, route: { ...row.route, ...(state === "invalid_rank" ? { native_rank: 0 }
        : { window: { status: "available", window: { ...window(80), window_id: "invalid" } } }) } });
    const envelope = { candidate_phase: data.candidate_phase, ...(state === "missing" ? {} : { retained_occurrences: retained }) };
    for (const index of [0, 19]) {
      const result = project(envelope, index);
      for (const view of views) for (const channel of channels) {
        const fact = route(result, view, channel);
        expect(fact.nomination).toBe(index === 0 ? "passed" : "unknown");
        expect(fact.native?.occurrence_evidence).toBe("displayed_prefix");
        expect(fact.native?.retained_occurrences).toHaveLength(index === 0 ? 1 : 0);
        expect(fact.diagnostic_issues.map(issue => issue.field)).toEqual(state === "missing" ? [] : ["retained_occurrences"]);
        if (index === 19) {
          expect(fact.native?.lexical_ranks).toBeNull();
          expect(fact.native?.vector).toBeNull();
          expect(fact.first_failure).toBeNull();
        }
      }
    }
  });

it("does not borrow the other view or route's occurrence, or use counts to manufacture an absent nomination", () => {
  const data = fixture();
  // Synthetic fault injection of an otherwise valid witness: this target participates only in original lexical.
  data.retained_occurrences = data.retained_occurrences.map(row => row.source.source_id === "source-19"
    && (row.view !== "original" || row.route.kind !== "lexical") ? { ...row, source: source(18) } : row);
  expect(sourceSemanticRetainedWitnessMatchesPhase(data.retained_occurrences, data.candidate_phase)).toBe(true);
  const result = project(data);
  expect(route(result, "original", "lexical").nomination).toBe("passed");
  for (const [view, channel] of [["original", "vector"], ["hint", "lexical"], ["hint", "vector"]] as const) {
    expect(route(result, view, channel)).toMatchObject({ nomination: "unknown", first_failure: null,
      native: { retained_occurrences: [], occurrence_evidence: "full_retained", lexical_ranks: null, vector: null } });
  }
});

it.each(["full", "prefix", "invalid_phase"] as const)("does not substitute optional diagnostics for %s candidate authority", authority => {
  const data = fixture();
  const envelope = { candidate_phase: authority === "invalid_phase" ? { ...data.candidate_phase, accounting: "not_run" } : data.candidate_phase,
    ...(authority === "full" ? { retained_occurrences: data.retained_occurrences } : {}) };
  const result = project(envelope, 21, {}, [
    { kind: "source_index_acquisition", phase: "observation", data: { invocation: "original", kind: "lexical_candidate",
      target: source(21).target, rank: 2, lane: "unicode61", lane_rank: 2, bm25: -2 } },
    { kind: "source_index_acquisition", phase: "observation", data: { invocation: "hint", kind: "vector_ranked",
      target: source(21).target, rank: 3, cosine: 0.5, window: window(0) } },
    ...["admitted", "resource_refused"].map(disposition => ({ kind: "source_index_acquisition", phase: "observation",
      data: { invocation: "hint", kind: "nomination_attempt", channel: "vector", target: source(21).target, disposition } }))
  ]);
  for (const view of views) for (const channel of channels) expect(route(result, view, channel)).toMatchObject({
    nomination: "unknown", first_failure: null, native: { lexical_ranks: null, vector: null } });
  expect(route(result, "hint", "vector").native?.attempts?.map(row => row.disposition)).toEqual(["admitted", "resource_refused"]);
});

it("preserves malformed optional detail diagnostics alongside authoritative retained proof", () => {
  const result = project(fixture(), 19, {}, [
    { kind: "source_index_acquisition", phase: "observation", data: { invocation: "original", kind: "lexical_candidate",
      target: source(19).target, rank: -1, lane: "unicode61", lane_rank: 1, bm25: -2 } },
    { kind: "source_index_acquisition", phase: "observation", data: { invocation: "hint", kind: "vector_ranked",
      target: source(19).target, rank: 3, cosine: 0.5, window: { ...window(0), window_id: "invalid" } } },
    { kind: "source_index_acquisition", phase: "observation", data: { invocation: "hint", kind: "nomination_attempt", channel: "vector",
      target: source(19).target, disposition: "resource_refused", resource_refusal: { stage: "invalid", phase: "synthetic" } } }
  ]);
  expect(route(result, "original", "lexical")).toMatchObject({ nomination: "passed", diagnostic_issues: [{ field: "lexical_rank" }],
    native: { lexical_ranks: [{ rank: 120 }, { rank: 121 }] } });
  expect(route(result, "hint", "vector")).toMatchObject({ nomination: "passed",
    diagnostic_issues: [{ field: "vector_rank" }, { field: "resource_refusal" }], native: { vector: { rank: 420 } } });
  expect(result.messages[0]?.diagnostic_issues).toHaveLength(3);
  expect(result.messages[0]?.first_unknown?.stage).toBe("eligibility");
});

it("rejects retained proof when its phase is invalid and retains observation-incomplete causal ordering", () => {
  const data = fixture();
  const invalid = project({ ...data, candidate_phase: { ...data.candidate_phase, accounting: "not_run" } });
  expect(route(invalid, "original", "lexical")).toMatchObject({ nomination: "unknown", native: {
    occurrence_evidence: "unavailable", retained_occurrences: null, lexical_ranks: null }, diagnostic_issues: [{ field: "retained_occurrences" }] });
  const partial = project(data, 19, { status: "overflow", dropped_events: 1 });
  expect(route(partial, "original", "vector").nomination).toBe("passed");
  expect(partial.messages[0]).toMatchObject({ read: "unknown", first_unknown: { stage: "eligibility" } });
  expect(route(partial, "original", "vector").unknowns).toContainEqual({ stage: "nomination", reason: "observation_incomplete" });
});
