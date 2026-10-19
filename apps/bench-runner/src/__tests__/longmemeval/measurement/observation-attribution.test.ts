import { describe, expect, it } from "vitest";
import { sourceIndexTarget, type SourceSemanticAcquisitionPhase } from "@do-soul/alaya-protocol";
import type { SourceGoldUnit } from "../../../runs/measurement/source-gold-join.js";
import type { AnswerTurnGold, AnswerTurnSpan } from "../../../runs/longmemeval-semantic/answer-spans.js";
import type { ConsumerVisibilityMetric, ConsumerVisibilityScore } from "../../../runs/longmemeval-semantic/message-visibility.js";
import { attributeObservation, summarizeObservationAttribution, type ObservationAdmittedRoot,
  type ObservationCallScope } from "../../../runs/longmemeval-semantic/observation-attribution.js";
import type { SourceSemanticObservation } from "../../../../../core-daemon/src/runtime/recall-read-worker/source-semantic-observation.js";

const DIGEST = `sha256:${"ab".repeat(32)}`;
const unit = (root: string, version = "1"): SourceGoldUnit => ({ workspace_id: "ws", root_kind: "source_record",
  root_id: root, source_version: version, content_digest: DIGEST });
const target = (value: SourceGoldUnit) => ({ kind: "source_evidence" as const, workspace_id: value.workspace_id,
  root_kind: value.root_kind, root_id: value.root_id, source_version: value.source_version,
  content_digest: value.content_digest, evidence_object_id: null });
const span = (value: SourceGoldUnit, index: number): AnswerTurnSpan => ({ session_index: 0, message_index: index,
  source_id: `source-${value.root_id}`, target: value, start: 0, end: 10 });
const gold = (units: readonly SourceGoldUnit[]): AnswerTurnGold => ({ unit: "published_body_utf8_bytes",
  annotated_turns: units.length, spans: units.map(span), complete: true });
const metric = (status: "hit" | "miss" | "unknown"): ConsumerVisibilityMetric => ({ status,
  reason: status === "unknown" ? "fixture_unknown" : null });
const visibility = (status: "hit" | "miss" | "unknown", complete = status): ConsumerVisibilityScore => ({
  contract: "consumer-message-visibility-v1", any_at_5: metric(status), any_at_10: metric(status),
  all_at_5: metric(complete), all_at_10: metric(complete), gold_messages: { annotated: 1, mapped: 1, complete: true },
  observation: { observed_pages: 1, observed_through: 10, continuation: "none" } });
const call: ObservationCallScope = { kind: "recall", request_id: 7, query_key: "q", snapshot_id: "snap-1",
  index_generation: "generation-1" };
const admitted = (units: readonly SourceGoldUnit[]): ReadonlyMap<string, ObservationAdmittedRoot> => new Map(
  units.map((value, index) => { const record_id = `rec-${index}`; return [record_id,
    { record_id, source_id: `source-${value.root_id}`, snapshot_id: call.snapshot_id,
      index_generation: call.index_generation, identity: value }]; }));
const frame = (events: SourceSemanticObservation["events"], status: SourceSemanticObservation["status"] = "observed"):
  SourceSemanticObservation => ({ version: 1, request_id: 7, status, execution: "success", events, costs: [],
    meters: [], totals: { debit_work: 0, debit_bytes: 0, absorb_work: 0, absorb_bytes: 0 }, dropped_events: 0,
    aggregates_complete: status === "observed",
    overhead: { capture_ms: 1, event_json_bytes: 0, ipc_bytes: null, ipc_time: "not_measured",
      physical_peak_memory: "not_measured", physical_sql_work: "not_measured" },
    issues: status === "observed" ? [] : ["fixture_partial"] });
const indexRoutes = (units: readonly SourceGoldUnit[], completion: "complete" | "partial" = "complete") => {
  const phase = nativePhase(units[0] ?? unit("root-a"));
  return { kind: "source_index_routes", phase: "observation", data: {
    original: { ...phase, result: { ...phase.result!, completion,
      nominations: units.map(value => nativePhase(value).result!.nominations[0]!) } },
    beyond_observed_prefix: "unknown_not_nomination_limit" } };
};
const read = (recordId: string, complete: boolean, end = complete ? 100 : 10) => ({ kind: "observation_read_complete",
  phase: "observation", data: { record_id: recordId, source_id: "source-root-a", start: 0, end, body_bytes: 100,
    complete, resource_limited: !complete, stop: complete ? "complete" : "budget" } });

const nativePhase = (value: SourceGoldUnit, hint = false): SourceSemanticAcquisitionPhase => ({
  policy: "source-index-interleaved-prefix.v1", status: "executed", reason: null, accounting: "complete",
  allowance: { max_attempts: 16, max_roots: 8, max_vector_windows: 64 },
  budget: { work_units: 1000, memory_bytes: 10000 }, result: {
    policy: "source-index-interleaved-prefix.v1", navigation_digest: DIGEST, completion: "complete",
    nominations: [{ source: sourceIndexTarget(target(value), `source-${value.root_id}`, 100),
      lexical: [{ rank: hint ? 7 : 2, lane: "unicode61", lane_rank: hint ? 4 : 1, bm25: -3.5 }],
      vector: { rank: hint ? 5 : 3, cosine: 0.8, window: { window_id: DIGEST, content_digest: DIGEST,
        start_byte: hint ? 40 : 0, end_byte: hint ? 60 : 20 } } }],
    accounting: { attempted: 2, admitted: 1, duplicate: 1, rejected: 0, scope_denied: 0, native_unknown: 0,
      resource_refused: 0, stale: 0, nomination_limit: 0 },
    resources: { work: 5, memory_bytes: 100, native_bytes: 20, sql_internal_work: "unknown" }, resource_refusals: [],
    lexical: { completion: "complete", index_coverage: "partial", reason: null, limitations: [], tokenization: null },
    vector: { completion: "complete", state: { status: "ready", binding: { workspace_id: "ws", selection_revision: 1,
      config_id: DIGEST, profile_id: DIGEST, generation_id: DIGEST, source_epoch: 1, dimensions: 2 } }, reason: null,
      inspected_windows: 2, invalid_windows: 0, validation: "validated", ranking: "exact_over_inspected_subset",
      input: { status: "available", profile_id: DIGEST, input_digest: DIGEST } }, limitations: []
  }
});
const returnedRead = (start: number, end: number, purpose = "observation", extra = {}) => ({
  kind: "source_read", phase: "observation", data: { purpose, record_id: "rec-0", start, end,
    resource_limited: false, available: true, ...extra }
});
const attributed = (events: SourceSemanticObservation["events"], spans = [{ ...span(unit("root-a"), 0), start: 10, end: 20 }]) =>
  attributeObservation({ question_id: "q-range", k: 5, call, observations: [frame(events)],
    admitted_roots: admitted([unit("root-a")]), admitted_roots_complete: true,
    answer_gold: { unit: "published_body_utf8_bytes", annotated_turns: spans.length, complete: true, spans },
    visibility: visibility("miss") });

describe("observation attribution", () => {
  it("proves a full gold message inside a partial root prefix but not a later message", () => {
    const first = { ...span(unit("root-a"), 0), start: 10, end: 20 };
    const later = { ...span(unit("root-a"), 1), start: 60, end: 80 };
    const result = attributed([returnedRead(0, 40), read("rec-0", false, 40)], [first, later]);
    expect(result.layer).toBe("L4");
    expect(result.messages.map(message => message.read)).toEqual(["whole", "none"]);
    expect(result.messages[0]?.read_intervals).toEqual([
      expect.objectContaining({ start: 0, end: 40, provenance: "source_read" })]);
  });

  it("joins actual chunks across routes only when their byte union covers the whole message", () => {
    const joined = attributed([returnedRead(10, 15), returnedRead(15, 20, "package_hydration")]);
    expect(joined.layer).toBe("L4");
    expect(joined.messages[0]?.read).toBe("whole");
    expect(joined.messages[0]?.routes.find(route => route.route === "read:observation")?.access_read).toBe("partial");
    const gapped = attributed([returnedRead(10, 15), returnedRead(16, 20, "package_hydration")]);
    expect(gapped.layer).toBe("L3");
    expect(gapped.messages[0]?.read).toBe("partial");
  });

  it("retains bytes returned before resource refusal without fabricating unavailable bodies", () => {
    const limited = attributed([returnedRead(0, 30, "observation", { resource_limited: true }), read("rec-0", false, 0)]);
    expect(limited.layer).toBe("L4");
    expect(limited.messages[0]?.coverage_intervals).toEqual([]);
    const unavailable = attributed([returnedRead(0, 30, "observation", { available: false }),
      { kind: "source_read_attempt", phase: "observation", data: { purpose: "observation", record_id: "rec-0",
        start: 0, requested_end: 100 } }]);
    expect(unavailable.layer).toBe("L3");
    expect(unavailable.messages[0]?.read_intervals).toEqual([]);
    expect(unavailable.messages[0]?.read).toBe("attempted");
    const noBody = attributed([returnedRead(0, 30, "observation", { body_bytes: 0 })]);
    expect(noBody.messages[0]?.read_intervals).toEqual([]);
    expect(noBody.layer).toBe("U");
  });

  it("keeps analyzed prefix and verified reuse separate from physically returned intervals", () => {
    const prefix = attributed([read("rec-0", false, 30)]);
    expect(prefix.layer).toBe("L4");
    expect(prefix.messages[0]?.read_intervals).toEqual([]);
    expect(prefix.messages[0]?.coverage_intervals).toEqual([
      expect.objectContaining({ start: 0, end: 30, provenance: "observation_read_complete" })]);
    const reused = attributed([{ kind: "verification_reuse", phase: "observation", data: {
      record_id: "rec-0", start: 0, end: 100, body_bytes: 100 } }]);
    expect(reused.layer).toBe("L4");
    expect(reused.messages[0]?.read_intervals).toEqual([]);
    expect(reused.messages[0]?.coverage_intervals[0]?.provenance).toBe("verification_reuse");
  });

  it("preserves native lexical/vector ranks and nested hint windows separately from cursor access", () => {
    const value = unit("root-a");
    const original = { ...nativePhase(value), supplemental: [nativePhase(value, true)] };
    const result = attributed([{ kind: "source_index_routes", phase: "observation", data: { original } },
      { kind: "union_admission", phase: "observation", data: { route: "cursor", record_id: "rec-0", position: 4 } },
      { kind: "access_order", phase: "observation", data: { sources: [{ record_id: "rec-0", position: 2,
        read_bytes: 0, body_bytes: 100, complete: false }], stopping_reasons: [] } }]);
    const routes = result.messages[0]!.routes;
    expect(routes.find(route => route.route === "index:original:lexical")?.native?.lexical_ranks)
      .toEqual([{ rank: 2, lane: "unicode61", lane_rank: 1, bm25: -3.5 }]);
    expect(routes.find(route => route.route === "index:hint:vector")?.native?.vector)
      .toMatchObject({ rank: 5, window: { start_byte: 40, end_byte: 60 } });
    expect(routes.find(route => route.route === "index:hint:vector")?.eligibility).toBe("unknown");
    expect(routes.find(route => route.route === "union:cursor")?.union_positions).toEqual([4]);
    expect(result.messages[0]?.access_positions).toEqual([2]);
    expect(routes.find(route => route.route === "access_order")?.read_intervals).toEqual([]);
  });

  it("does not equate snapshot admission with per-root index eligibility or native nomination with union admission", () => {
    const value = unit("root-a");
    const phase = nativePhase(value);
    const absent = attributed([{ kind: "source_index_routes", phase: "observation", data: {
      original: { ...phase, result: { ...phase.result!, nominations: [] } } } },
      { kind: "access_order", phase: "observation", data: { sources: [], stopping_reasons: [] } }]);
    expect(absent.messages[0]).toMatchObject({ admission: "admitted", eligibility: "unknown", candidate: "absent" });
    expect(absent.layer).toBe("U");
    const eligible = attributed([{ kind: "source_index_routes", phase: "observation", data: { original: phase } },
      { kind: "access_order", phase: "observation", data: { sources: [], stopping_reasons: [] } }]);
    expect(eligible.messages[0]).toMatchObject({ eligibility: "passed", candidate: "absent" });
    expect(eligible.layer).toBe("L2");
  });

  it("retains package selection and encoded facts without promoting observer membership to final visibility", () => {
    const selected = { ...target(unit("root-a")), span: { content_start: 0, content_end: 30,
      retained_extent: "body", content_complete: false, original_complete: false } };
    const result = attributed([returnedRead(0, 30),
      { kind: "package_candidates", phase: "selection", data: { incomplete: false,
        packages: [{ target: selected, access_position: 3, proof_count: 0, payload_support: "not_applicable" }] } },
      { kind: "frozen_membership", phase: "selection", data: { incomplete: false,
        pages: [{ position: 0, targets: [selected] }] } },
      { kind: "encoded_membership", phase: "final_delivery", data: { offset: 0,
        results: [{ target: selected, preview_bytes: 15, within_budget: true }] } }]);
    expect(result.layer).toBe("L4");
    expect(result.messages[0]?.packages).toMatchObject({ candidates: [{ access_position: 3 }],
      selected: [{ page_position: 0, slot_position: 0 }], encoded: [{ preview_bytes: 15, within_budget: true }] });
    expect(result.messages[0]?.routes.find(route => route.route === "delivery")?.delivery).toBe("failed");
  });
  it("attributes nested progress across multiple gold messages without choosing one arbitrarily", () => {
    const first = unit("root-a"), second = unit("root-b");
    const result = attributeObservation({ question_id: "q-multi", k: 5, call,
      observations: [frame([indexRoutes([first, second]), read("rec-0", false, 5)])],
      admitted_roots: admitted([first, second]), admitted_roots_complete: true, answer_gold: gold([first, second]),
      visibility: visibility("miss") });
    expect(result.layer).toBe("L3");
    expect(result.opportunities).toMatchObject({ L2: false, L3: true, L4: false });
    expect(result.messages[0]).toMatchObject({ admission: "admitted", candidate: "present", read: "partial" });
    expect(result.messages[1]).toMatchObject({ admission: "admitted", candidate: "unknown", read: "none" });
    expect(result.messages[0]?.routes.find(route => route.route === "index:original:lexical")?.nomination).toBe("passed");
    expect(result.messages[1]?.routes.find(route => route.route === "index:original:lexical")?.nomination).toBe("passed");
    expect(summarizeObservationAttribution([result])).toMatchObject({ denominator: 1, L3: 1, conserved: true });
  });

  it("classifies a proven whole read plus final nonvisibility as L4", () => {
    const value = unit("root-a");
    const result = attributeObservation({ question_id: "q-read", k: 5, call,
      observations: [frame([indexRoutes([value]), read("rec-0", true)])],
      admitted_roots: admitted([value]), admitted_roots_complete: true, answer_gold: gold([value]),
      visibility: visibility("miss") });
    expect(result.layer).toBe("L4");
    expect(result.messages[0]?.read).toBe("whole");
    expect(result.messages[0]?.first_failure).toMatchObject({ stage: "delivery" });
    expect(result.opportunities.L4).toBe(true);
  });

  it("does not join a bare record ID across source versions", () => {
    const older = unit("root-a", "1"), newer = unit("root-a", "2");
    const result = attributeObservation({ question_id: "q-version", k: 5, call,
      observations: [frame([read("rec-0", true)])], admitted_roots: admitted([older]),
      admitted_roots_complete: true, answer_gold: gold([newer]), visibility: visibility("miss") });
    expect(result.messages[0]).toMatchObject({ admission: "not_admitted", matched_record_id: null, read: "none" });
    expect(result.layer).toBe("L1");
    expect(result.messages[0]?.routes.find(route => route.route === "snapshot_admission")?.eligibility).toBe("failed");
  });

  it("attributes index-eligible gold absent from the closed legal union as L2", () => {
    const value = unit("root-a");
    const result = attributeObservation({ question_id: "q-pool", k: 5, call,
      observations: [frame([indexRoutes([value]), { kind: "access_order", phase: "observation",
        data: { sources: [], stopping_reasons: [] } }])], admitted_roots: admitted([value]),
      admitted_roots_complete: true, answer_gold: gold([value]), visibility: visibility("miss") });
    expect(result.layer).toBe("L2");
    expect(result.messages[0]).toMatchObject({ admission: "admitted", candidate: "absent" });
    expect(result.opportunities.L2).toBe(true);
  });

  it("does not turn metadata reads or read attempts into whole-message visibility", () => {
    const value = unit("root-a");
    const result = attributeObservation({ question_id: "q-attempt", k: 5, call,
      observations: [frame([indexRoutes([value]),
        { kind: "source_read", phase: "observation", data: { purpose: "observation_metadata",
          record_id: "rec-0", source_id: "source-root-a", start: 0, end: 20, body_bytes: 20 } },
        { kind: "source_read_attempt", phase: "observation", data: { purpose: "observation",
          record_id: "rec-0", source_id: "source-root-a", start: 0, requested_end: 20 } }])],
      admitted_roots: admitted([value]), admitted_roots_complete: true, answer_gold: gold([value]),
      visibility: visibility("miss") });
    expect(result.messages[0]?.read).toBe("attempted");
    expect(result.layer).toBe("L3");
    expect(result.opportunities.L4).toBe(false);
  });

  it("keeps bounded route-prefix absence unknown rather than claiming a nomination loss", () => {
    const value = unit("root-a");
    const result = attributeObservation({ question_id: "q-prefix", k: 5, call,
      observations: [frame([indexRoutes([], "partial")])], admitted_roots: admitted([value]),
      admitted_roots_complete: true, answer_gold: gold([value]), visibility: visibility("miss") });
    expect(result.layer).toBe("U");
    expect(result.opportunities.L2).toBe(false);
    expect(result.messages[0]).toMatchObject({ admission: "admitted", candidate: "unknown", read: "none" });
    expect(result.messages[0]?.routes.find(route => route.route === "index:original:lexical")?.nomination).toBe("unknown");
  });

  it("rejects explicit source identity conflicts even when the record key matches the root map", () => {
    for (const conflict of [{ source_id: "source-root-b" }, { source_version: "other" },
      { content_digest: `sha256:${"cd".repeat(32)}` }, { workspace_id: "other" }]) {
      const result = attributed([returnedRead(0, 30, "observation", conflict)]);
      expect(result.messages[0]?.read).toBe("none");
      expect(result.messages[0]?.read_intervals).toEqual([]);
      expect(result.layer).toBe("U");
    }
    const invalidPrefix = attributed([{ kind: "access_order", phase: "observation", data: { sources: [
      { record_id: "rec-0", position: 0, read_bytes: 30, body_bytes: 0, complete: true }
    ], stopping_reasons: [] } }]);
    expect(invalidPrefix.messages[0]?.coverage_intervals).toEqual([]);
    expect(invalidPrefix.messages[0]?.read).toBe("unknown");
    expect(invalidPrefix.layer).toBe("U");
  });

  it("keeps unavailable native routes/ranks/windows explicit without inventing an individual cap", () => {
    const result = attributed([]);
    for (const name of ["index:original:lexical", "index:original:vector", "index:hint:lexical", "index:hint:vector"]) {
      expect(result.messages[0]?.routes.find(route => route.route === name)).toMatchObject({
        nomination: "unknown", eligibility: "unknown", native: { lexical_ranks: null, vector: null,
          completion: null, lexical_window: null, reason: "native_route_not_observed_or_invalid" } });
    }
    expect(result.messages[0]?.routes.find(route => route.route === "union:cursor")?.nomination).toBe("unknown");
    expect(result.messages[0]?.unknowns).toContainEqual({ stage: "nomination",
      reason: "vector_rank_unavailable_not_individual_nomination_limit" });
    expect(result.layer).toBe("U");
  });

  it("does not attribute a shallow loss while another gold's deeper read extent is unknown", () => {
    const first = unit("root-a"), second = unit("root-b");
    const result = attributeObservation({ question_id: "q-unknown-read", k: 5, call,
      observations: [frame([indexRoutes([first, second]), read("rec-0", false, 5),
        { kind: "access_order", phase: "observation", data: { sources: [
          { record_id: "rec-1", position: 1, complete: true, body_bytes: 100 }
        ], stopping_reasons: [] } }])], admitted_roots: admitted([first, second]), admitted_roots_complete: true,
      answer_gold: gold([first, second]), visibility: visibility("miss") });
    expect(result.messages.map(message => message.read)).toEqual(["partial", "unknown"]);
    expect(result.layer).toBe("U");
    expect(result.reason).toBe("gold_progress_unknown");
  });

  it("conserves one question per partition across hit, losses and unknown", () => {
    const value = unit("root-a");
    const base = { question_id: "q-partition", k: 5 as const, call, admitted_roots: admitted([value]),
      admitted_roots_complete: true, answer_gold: gold([value]), visibility: visibility("miss") };
    const rows = [
      attributeObservation({ ...base, observations: [], visibility: visibility("hit") }),
      attributeObservation({ ...base, observations: [frame([])], admitted_roots: new Map() }),
      attributeObservation({ ...base, observations: [frame([indexRoutes([value]), {
        kind: "access_order", phase: "observation", data: { sources: [], stopping_reasons: [] } }])] }),
      attributeObservation({ ...base, observations: [frame([read("rec-0", false, 5)])] }),
      attributeObservation({ ...base, observations: [frame([read("rec-0", true)])] }),
      attributeObservation({ ...base, observations: [] })
    ];
    expect(rows.map(row => row.layer)).toEqual(["H", "L1", "L2", "L3", "L4", "U"]);
    expect(summarizeObservationAttribution(rows)).toMatchObject({ denominator: 6,
      H: 1, L1: 1, L2: 1, L3: 1, L4: 1, U: 1, conserved: true });
  });

  it("keeps malformed or partial observations unknown", () => {
    const value = unit("root-a");
    const result = attributeObservation({ question_id: "q-partial", k: 5, call,
      observations: [frame([{ kind: "union_admission", phase: "selection", data: "malformed" }], "partial")],
      admitted_roots: admitted([value]), admitted_roots_complete: true, answer_gold: gold([value]),
      visibility: visibility("miss") });
    expect(result.layer).toBe("U");
    expect(result.reason).toBe("observation_incomplete_deeper_read_unknown");
    expect(result.observation).toMatchObject({ status: "partial", complete: false });
  });
});
