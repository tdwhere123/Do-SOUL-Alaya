import { describe, expect, it } from "vitest";
import { sourceIndexTarget, type SourceSemanticAcquisitionPhase } from "@do-soul/alaya-protocol";
import type { SourceSemanticObservation } from "../../../../../core-daemon/src/runtime/recall-read-worker/source-semantic-observation.js";
import type { SourceSemanticNativeFacts } from "../../../../../core-daemon/src/runtime/recall-read-worker/source-semantic-provenance.js";
import type { SourceGoldUnit } from "../../../runs/measurement/source-gold-join.js";
import type { AnswerTurnGold, AnswerTurnSpan } from "../../../runs/longmemeval-semantic/answer-spans.js";
import { scoreConsumerMessageVisibility, type ConsumerVisibilityMetric, type ConsumerVisibilityPage,
  type ConsumerVisibilityScore } from "../../../runs/longmemeval-semantic/message-visibility.js";
import { attributeObservation, summarizeObservationAttribution, type ObservationAdmittedRoot, type ObservationAttributionInput,
  type ObservationCallScope, type ObservationCapturedFrame, type ObservationFrozenIndex } from "../../../runs/longmemeval-semantic/observation-attribution.js";

const DIGEST = `sha256:${"ab".repeat(32)}`;
const SNAPSHOT = `sha256:${"cd".repeat(32)}`;
const unit = (root = "root-a", version = "1"): SourceGoldUnit => ({ workspace_id: "ws", root_kind: "source_record",
  root_id: root, source_version: version, content_digest: DIGEST });
const target = (value: SourceGoldUnit) => ({ kind: "source_evidence" as const, ...value, evidence_object_id: null });
const span = (value = unit(), index = 0): AnswerTurnSpan => ({ session_index: 0, message_index: index,
  source_id: `source-${value.root_id}`, target: value, start: 10, end: 20 });
const gold = (spans: readonly AnswerTurnSpan[] = [span()]): AnswerTurnGold => ({ unit: "published_body_utf8_bytes",
  annotated_turns: spans.length, spans, complete: true });
const metric = (status: "hit" | "miss" | "unknown"): ConsumerVisibilityMetric => ({ status,
  reason: status === "unknown" ? "fixture_unknown" : null });
const visibility = (answer: AnswerTurnGold, status: "hit" | "miss" | "unknown" = "miss"): ConsumerVisibilityScore => ({
  contract: "consumer-message-visibility-v1", any_at_5: metric(status), any_at_10: metric(status),
  all_at_5: metric(status), all_at_10: metric(status),
  gold_messages: { annotated: answer.annotated_turns, mapped: answer.spans.length, complete: answer.complete },
  messages: answer.spans.map(value => ({ ...value, at_5: metric(status), at_10: metric(status), visible_intervals: [] })),
  observation: { observed_pages: 1, observed_through: 10, continuation: "none" } });
const call: ObservationCallScope = { kind: "recall", request_id: 7, session_id: "session", query_key: "q",
  snapshot_id: SNAPSHOT, workspace_id: "ws", as_of: "2026-10-20T00:00:00Z" };
const index: NonNullable<NonNullable<SourceSemanticNativeFacts["binding"]>["index"]> = {
  workspace_id: "ws", source_epoch: 1, selection: null, generation: null,
  query_state: { status: "unbound", reason: "no_active_generation" } };
const origin = (request_id: number, object_id: string) => ({ session_id: "session", request_id, object_id });
const facts = (scope = call, overrides: Partial<SourceSemanticNativeFacts> = {}): SourceSemanticNativeFacts => ({
  binding: { session_id: scope.session_id!, request_id: scope.request_id!, operation: scope.kind === "continuation" ? "recall" : scope.kind,
    workspace_id: scope.workspace_id, as_of: scope.as_of, snapshot_revision: "1:0", preparation: null, index },
  pool: { pool_id: "pool-label", use: "created", origin: origin(scope.request_id!, "pool-object"), union: {
    capture: "complete", source_count: 0, members: [], source_discovery_open: true, interpretation_discovery_open: true,
    full_universe: "not_established" } }, lease_reads: [], lease_issues: [], operations: [], encodings: [], complete: true, issues: [], ...overrides });
const pool = (units: readonly SourceGoldUnit[], requestId = 7): NonNullable<SourceSemanticNativeFacts["pool"]> => ({
  pool_id: "pool-label", use: "created", origin: origin(requestId, "pool-object"), union: {
    capture: "complete", source_count: units.length, members: units.map(value => ({ record_id: value.root_id,
      source_id: `source-${value.root_id}`, source_version: value.source_version, content_digest: value.content_digest })),
    source_discovery_open: true, interpretation_discovery_open: true, full_universe: "not_established" } });
const captured = (events: SourceSemanticObservation["events"] = [], scope = call,
  native = facts(scope), extra: Partial<SourceSemanticObservation> = {}): ObservationCapturedFrame => ({ call: scope,
  observation: { version: 1, request_id: scope.request_id!, status: "observed", execution: "success", events, facts: native,
    costs: [], meters: [], totals: { debit_work: 0, debit_bytes: 0, absorb_work: 0, absorb_bytes: 0 },
    dropped_events: 0, aggregates_complete: true,
    overhead: { capture_ms: 1, event_json_bytes: 0, ipc_bytes: null, ipc_time: "not_measured",
      physical_peak_memory: "not_measured", physical_sql_work: "not_measured" }, issues: [], ...extra } });
const admitted = (units: readonly SourceGoldUnit[] = [unit()]): ReadonlyMap<string, ObservationAdmittedRoot> => new Map(
  units.map(value => [value.root_id, { record_id: value.root_id, source_id: `source-${value.root_id}`, snapshot_id: SNAPSHOT,
    identity: value }]));
const frozen = (value = unit(), eligible = true): ObservationFrozenIndex => ({
  header: { snapshot_identity: SNAPSHOT, workspace_id: "ws", index_identity: DIGEST, index,
    roots: 1, pages: 1, source_census: "complete", reason: null, native_sql_work: "unknown" },
  pages: [{ snapshot_identity: SNAPSHOT, index_identity: DIGEST, qualification: {
    source_id: `source-${value.root_id}`, source: sourceIndexTarget(target(value), `source-${value.root_id}`, 100),
    status: eligible ? "ready" : "not_indexed", currentness: "ready", reason: null,
    lexical: eligible ? { status: "ready", start_byte: 0, end_byte: 100 } : { status: "not_indexed", start_byte: null, end_byte: null },
    vector: { status: "not_indexed", generation_member: false, expected_windows: null, coverage_complete: false,
      windows: [], capture: "complete", next_ordinal: null } } }] });
const returned = (start: number, end: number, purpose = "observation", extra = {}) => ({ kind: "source_read", phase: "observation",
  data: { record_id: "root-a", source_id: "source-root-a", start, end, body_bytes: 100, purpose, available: true, ...extra } });
function attributed(overrides: Partial<ObservationAttributionInput> = {}) {
  const answer = overrides.answer_gold ?? gold();
  return attributeObservation({ question_id: "q", k: 5, call, frames: [captured()], frozen_index: frozen(),
    admitted_roots: admitted(), admitted_roots_complete: true, answer_gold: answer, visibility: visibility(answer), ...overrides });
}
const nativePhase = (value = unit(), hint = false): SourceSemanticAcquisitionPhase => ({
  policy: "source-index-interleaved-prefix.v1", status: "executed", reason: null, accounting: "complete",
  allowance: { max_attempts: 16, max_roots: 8, max_vector_windows: 64 }, budget: { work_units: 1000, memory_bytes: 10000 }, result: {
    policy: "source-index-interleaved-prefix.v1", navigation_digest: DIGEST, completion: "complete",
    nominations: [{ source: sourceIndexTarget(target(value), `source-${value.root_id}`, 100),
      lexical: [{ rank: hint ? 7 : 2, lane: "unicode61", lane_rank: hint ? 4 : 1, bm25: -3.5 }],
      vector: { rank: hint ? 5 : 3, cosine: 0.8, window: { window_id: DIGEST, content_digest: DIGEST,
        start_byte: hint ? 40 : 0, end_byte: hint ? 60 : 20 } } }],
    accounting: { attempted: 2, admitted: 1, duplicate: 1, rejected: 0, scope_denied: 0, native_unknown: 0,
      resource_refused: 0, stale: 0, nomination_limit: 0 },
    resources: { work: 5, memory_bytes: 100, native_bytes: 20, sql_internal_work: "unknown" }, resource_refusals: [],
    lexical: { completion: "complete", index_coverage: "partial", reason: null, limitations: [], tokenization: null },
    vector: { completion: "complete", state: { status: "unbound", reason: "no_active_generation" }, reason: null,
      inspected_windows: 2, invalid_windows: 0, validation: "validated", ranking: "exact_over_inspected_subset",
      input: { status: "available", profile_id: DIGEST, input_digest: DIGEST } }, limitations: [] } });
const routeEvent = { kind: "source_index_routes", phase: "observation",
  data: { original: { ...nativePhase(), supplemental: [nativePhase(unit(), true)] } } };

function chain() {
  const prepare: ObservationCallScope = { ...call, kind: "prepare_query", request_id: 3 };
  const continuation: ObservationCallScope = { ...call, kind: "continuation", request_id: 8 };
  const queryLease = { handle_digest: "query-handle", kind: "query", origin: origin(3, "query-lease"),
    pool_origin: origin(3, "pool-object"), plan_origin: null };
  const libraryLease = { handle_digest: "continuation-handle", kind: "library", origin: origin(7, "library-lease"),
    pool_origin: origin(3, "pool-object"), plan_origin: origin(7, "plan-object") };
  const created = pool([unit()], 3);
  const prepared = captured([routeEvent, returned(0, 30), { kind: "union_admission", phase: "observation",
    data: { route: "cursor", record_id: "root-a", position: 4 } }, { kind: "access_order", phase: "observation",
    data: { sources: [{ record_id: "root-a", position: 2, read_bytes: 30, body_bytes: 100 }], stopping_reasons: [] } }],
  prepare, facts(prepare, { pool: created, lease_issues: [queryLease] }));
  const recalled = captured([], call, facts(call, { pool: { ...created, use: "reused" },
    lease_reads: [queryLease], lease_issues: [libraryLease] }));
  const continued = captured([], continuation, facts(continuation, { pool: null, lease_reads: [libraryLease] }));
  return { prepare, continuation, prepared, recalled, continued };
}

describe("observation attribution", () => {
  it("joins prepare, recall and continuation through actual same-session leases and pool objects", () => {
    const { continuation, prepared, recalled, continued } = chain();
    const result = attributed({ call: continuation, frames: [continued, prepared, recalled] });
    expect(result.layer).toBe("L4");
    expect(result.observation).toMatchObject({ complete: true, finite_union_complete: true,
      joined_requests: [{ request_id: 3 }, { request_id: 7 }, { request_id: 8 }] });
    expect(result.messages[0]).toMatchObject({ candidate: "present", read: "whole", access_positions: [2], first_failure: { stage: "delivery" },
      finite_union: { origin: origin(3, "pool-object"), member_positions: [0], capture: "complete", full_universe: "not_established" } });
    expect(attributed({ call: continuation, frames: [continued, prepared, recalled], admitted_roots: new Map(),
      admitted_roots_complete: false }).messages[0]).toMatchObject({ admission: "unknown", read: "whole" });
    expect(result.messages[0]?.read_intervals).toEqual([expect.objectContaining({ start: 0, end: 30,
      request_id: 3, session_id: "session", event_position: 1, call_kind: "prepare_query" })]);
    const routes = result.messages[0]!.routes;
    expect(routes.find(row => row.route === "index:original:lexical")?.native).toMatchObject({
      position: { request_id: 3, event_position: 0 }, lexical_ranks: [{ rank: 2, lane_rank: 1, bm25: -3.5 }] });
    expect(routes.find(row => row.route === "index:hint:vector")?.native).toMatchObject({ invocation_position: 1,
      vector: { rank: 5, window: { start_byte: 40, end_byte: 60 } } });
    expect(routes.find(row => row.route === "union:cursor")).toMatchObject({ union_positions: [4],
      event_references: [{ request_id: 3, event_position: 2 }] });
  });

  it("does not borrow reads from unrelated queries, sessions, snapshots or ambiguous ancestors", () => {
    const { continuation, prepared, recalled, continued } = chain();
    for (const changed of [{ query_key: "other" }, { session_id: "other" }, { snapshot_id: DIGEST }, { as_of: "other" }]) {
      const bad = { ...prepared, call: { ...prepared.call, ...changed } };
      const result = attributed({ call: continuation, frames: [bad, recalled, continued] });
      expect(result.layer).toBe("U");
      expect(result.messages[0]?.read_intervals).toEqual([]);
      expect(result.messages[0]?.read).toBe("unknown");
    }
    const ambiguous = attributed({ call: continuation, frames: [prepared, prepared, recalled, continued] });
    expect(ambiguous.layer).toBe("U");
    expect(ambiguous.observation.issues).toContain("native_ancestor_ambiguous");
    const foreign = captured([returned(0, 100)], { ...call, request_id: 90, query_key: "other" });
    expect(attributed({ frames: [captured(), foreign] }).messages[0]?.read).toBe("none");
  });

  it("keeps missing, historical and explicitly unknown ancestry unresolved", () => {
    const { continuation, recalled, continued } = chain();
    const missing = attributed({ call: continuation, frames: [recalled, continued] });
    expect(missing.layer).toBe("U");
    expect(missing.observation.issues).toContain("native_ancestor_missing");
    const unknown = captured([], call, facts(call, { pool: { ...pool([]), use: "reused", origin: null } }));
    expect(attributed({ frames: [unknown] }).observation.issues).toContain("native_origin_unknown");
    const historical = captured([], call, facts(), { facts: undefined });
    expect(attributed({ frames: [historical] }).messages[0]).toMatchObject({ candidate: "unknown", read: "unknown" });
    expect(attributed({ frames: [captured(), captured()] }).observation.status).toBe("ambiguous");
    const conflicting = captured([], call, facts({ ...call, session_id: "foreign" }));
    expect(attributed({ frames: [conflicting] }).observation.issues).toContain("native_call_binding_mismatch");
  });

  it("closes the finite union independently of open discovery and a partial corpus census", () => {
    const qualification = frozen();
    const result = attributed({ frames: [captured()], frozen_index: { ...qualification,
      header: { ...qualification.header, roots: 24699, pages: 24699, source_census: "partial" } } });
    expect(result.layer).toBe("L2");
    expect(result.messages[0]).toMatchObject({ eligibility: "passed", candidate: "absent" });
    expect(result.observation.finite_union_complete).toBe(true);
    expect(result.opportunities.L2).toBe(true);
    const overflowing = pool([]); overflowing.union.capture = "overflow";
    const partial = attributed({ frames: [captured([], call, facts(call, { pool: overflowing }))] });
    expect(partial.messages[0]?.candidate).toBe("unknown");
    expect(partial.layer).toBe("U");
    expect(partial.opportunities.bounds.L2).toEqual({ lower: 0, upper: 1, unknown: 1 });
  });

  it("requires exact frozen row/window eligibility rather than snapshot admission or a native nomination", () => {
    expect(attributed({ frozen_index: frozen(unit(), false) }).layer).toBe("L1");
    expect(attributed({ frozen_index: null }).layer).toBe("U");
    expect(attributed({ frozen_index: null, admitted_roots: new Map() }).layer).toBe("U");
    const newer = gold([span(unit("root-a", "2"))]);
    expect(attributed({ answer_gold: newer, frames: [captured([returned(0, 100)])] }).messages[0])
      .toMatchObject({ admission: "not_admitted", eligibility: "unknown", read: "none" });
    expect(attributed({ frozen_index: null, frames: [captured([routeEvent])] }).messages[0]?.eligibility).toBe("unknown");
    const wrongFile = { ...call, snapshot_id: DIGEST };
    expect(attributed({ call: wrongFile, frames: [captured([], wrongFile)] }).messages[0]?.eligibility).toBe("unknown");
    const badIndex = captured([], call, facts(call, { binding: { ...facts().binding!, index: { ...index, source_epoch: 2 } } }));
    expect(attributed({ frames: [badIndex] }).messages[0]?.eligibility).toBe("unknown");
    const wrongPages = frozen();
    expect(attributed({ frozen_index: { ...wrongPages, pages: wrongPages.pages.map(page => ({ ...page, snapshot_identity: DIGEST })) } })
      .messages[0]?.eligibility).toBe("unknown");
  });

  it("distinguishes exact vector-window coverage, paged absence and missing window pages", () => {
    const qualification = frozen(unit(), false), page = qualification.pages[0]!;
    const vector = { ...page.qualification.vector, status: "ready" as const, generation_member: true, expected_windows: 2,
      coverage_complete: true, capture: "partial" as const, next_ordinal: 0,
      windows: [{ window_id: "w0", ordinal: 0, start_byte: 0, end_byte: 15, content_digest: DIGEST, status: "ready" as const, reason: null }] };
    const first = { ...page, qualification: { ...page.qualification, vector } };
    const second = { ...page, qualification: { ...page.qualification, vector: { ...vector, capture: "complete" as const,
      next_ordinal: null, windows: [{ ...vector.windows[0]!, window_id: "w1", ordinal: 1, start_byte: 15, end_byte: 100 }] } } };
    const readyIndex = { ...index, query_state: { status: "ready" as const, binding: { workspace_id: "ws", selection_revision: 1,
      config_id: DIGEST, profile_id: DIGEST, generation_id: DIGEST, source_epoch: 1, dimensions: 2 } } };
    const header = { ...qualification.header, index: readyIndex, pages: 2 };
    const frames = [captured([], call, facts(call, { binding: { ...facts().binding!, index: readyIndex } }))];
    const missing = attributed({ frames, frozen_index: { header, pages: [first] } });
    expect(missing.messages[0]?.eligibility).toBe("unknown");
    // Two adjacent windows do not certify that one native window contains the whole message.
    expect(attributed({ frames, frozen_index: { header, pages: [first, second] } }).layer).toBe("L1");
    const covering = { ...second, qualification: { ...second.qualification, vector: { ...second.qualification.vector,
      windows: [{ ...second.qualification.vector.windows[0]!, start_byte: 10 }] } } };
    expect(attributed({ frames, frozen_index: { header, pages: [first, covering] } }).layer).toBe("L2");
    expect(attributed({ frames, frozen_index: { header, pages: [first, first, covering] } }).messages[0]?.index_qualification.vector).toBe("unknown");
  });

  it("joins returned chunks but keeps retained prefixes and verified reuse separate from physical reads", () => {
    const observed = (events: SourceSemanticObservation["events"]) => attributed({ frames: [captured(events, call, facts(call, { pool: pool([unit()]) }))] });
    const joined = observed([returned(10, 15), returned(15, 20, "package_hydration")]);
    expect(joined.layer).toBe("L4");
    expect(joined.messages[0]?.read).toBe("whole");
    const gapped = observed([returned(10, 15), returned(16, 20)]);
    expect(gapped.layer).toBe("L3");
    expect(gapped.messages[0]?.first_failure?.stage).toBe("access_read");
    const limited = observed([returned(0, 30, "observation", { resource_limited: true })]);
    expect(limited.layer).toBe("L4");
    expect(limited.messages[0]?.coverage_intervals).toEqual([]);
    const reused = observed([{ kind: "verification_reuse", phase: "observation", data: {
      record_id: "root-a", start: 0, end: 100, body_bytes: 100 } }]);
    expect(reused.messages[0]?.read_intervals).toEqual([]);
    expect(reused.messages[0]?.coverage_intervals[0]?.provenance).toBe("verification_reuse");
    expect(reused.layer).toBe("L4");
    expect(observed([returned(0, 30, "observation", { available: false })]).messages[0]?.read).toBe("attempted");
    expect(observed([returned(0, 30, "observation_metadata")]).messages[0]?.read).toBe("attempted");
  });

  it("rejects identity conflicts and does not fill missing reads from a bounded route prefix", () => {
    for (const conflict of [{ source_id: "other" }, { source_version: "2" }, { content_digest: SNAPSHOT }, { workspace_id: "other" }]) {
      expect(attributed({ frames: [captured([returned(0, 100, "observation", conflict)])] }).messages[0]?.read_intervals).toEqual([]);
    }
    const unseen = attributed({ frozen_index: null, frames: [captured([routeEvent], call, facts(call, { pool: null }))] });
    expect(unseen.messages[0]).toMatchObject({ eligibility: "unknown", candidate: "unknown", read: "none" });
    expect(unseen.layer).toBe("U");
    const partial = attributed({ frames: [captured([], call, facts(), { status: "overflow", dropped_events: 1 })] });
    expect(partial.layer).toBe("U");
    expect(partial.messages[0]?.read).toBe("unknown");
  });

  it("consumes producer acquisition facts for native ranks and cap rejection without inventing remainder ranks", () => {
    const goldTarget = target(unit());
    const lexical = { kind: "source_index_acquisition", phase: "observation", data: {
      invocation: "original" as const, kind: "lexical_candidate", target: goldTarget, lane: "unicode61" as const,
      rank: 4, lane_rank: 2, bm25: 1.5 } };
    const attempt = { kind: "source_index_acquisition", phase: "observation", data: {
      invocation: "original" as const, kind: "nomination_attempt", channel: "lexical" as const, target: goldTarget,
      disposition: "nomination_limit" } };
    const ranked = { kind: "source_index_acquisition", phase: "observation", data: {
      invocation: "original" as const, kind: "vector_ranked", target: goldTarget, cosine: 0.4, rank: 9,
      window: { window_id: DIGEST, content_digest: DIGEST, start_byte: 8, end_byte: 16 } } };
    const routes = attributed({ frames: [captured([lexical, attempt, ranked])] }).messages[0]!.routes;
    expect(routes.find(row => row.route === "index:original:lexical")).toMatchObject({
      nomination: "failed", native: { lexical_ranks: [{ rank: 4, lane: "unicode61", lane_rank: 2, bm25: 1.5 }],
        lexical_window: null } });
    expect(routes.find(row => row.route === "index:original:vector")?.native?.vector).toMatchObject({
      rank: 9, cosine: 0.4, window: { start_byte: 8, end_byte: 16 } });
    const overflowed = attributed({ frames: [captured([lexical], call, facts(), { status: "overflow", dropped_events: 1 })] });
    expect(overflowed.messages[0]?.routes.find(row => row.route === "index:original:lexical")).toMatchObject({
      nomination: "unknown", native: { lexical_ranks: [{ rank: 4 }] } });
  });

  it("scopes unavailable inspection detail to its vector route without closing the whole observation", () => {
    const diagnostic = { status: "overflow" as const, compacted_events: 0, omitted_events: 600,
      counts: { source_index_original_vector_inspected: 600 },
      omitted_counts: { source_index_original_vector_inspected: 600 } };
    const frame = captured([routeEvent, returned(0, 5)], call, facts(call, { pool: pool([unit()]) }),
      { diagnostics: diagnostic });
    const result = attributed({ frames: [frame] });
    expect(result.observation).toMatchObject({ complete: false, progress_complete: true });
    expect(result.layer).toBe("L3");
    expect(result.messages[0]).toMatchObject({ candidate: "present", read: "none", visibility: { delivery: "failed" } });
    const routes = result.messages[0]!.routes;
    expect(routes.find(row => row.route === "index:original:vector")).toMatchObject({ nomination: "passed",
      native: { vector: { rank: 3 } }, unknowns: [{ stage: "nomination", reason: "vector_inspection_detail_unavailable" }] });
    expect(routes.find(row => row.route === "index:hint:vector")?.unknowns).toEqual([]);
    expect(routes.find(row => row.route === "index:original:lexical")?.unknowns).toEqual([]);
    expect(routes.find(row => row.route === "read:observation")?.unknowns).toEqual([]);
    for (const extra of [{ status: "overflow" as const, dropped_events: 1 },
      { status: "failure" as const, issues: ["observer_capture_failed"] }]) {
      const incomplete = attributed({ frames: [{ ...frame, observation: { ...frame.observation, ...extra } }] });
      expect(incomplete.observation.progress_complete).toBe(false);
      expect(incomplete.layer).toBe("U");
      expect(incomplete.messages[0]?.read).toBe("unknown");
    }
  });

  it("marks omitted lexical candidate detail on the matching invocation without poisoning receipt ranks", () => {
    const diagnostic = { status: "overflow" as const, compacted_events: 0, omitted_events: 1,
      counts: { source_index_original_lexical_candidate: 3 },
      omitted_counts: { source_index_original_lexical_candidate: 1 } };
    const goldTarget = target(unit());
    const lexical = { kind: "source_index_acquisition", phase: "observation", data: {
      invocation: "original" as const, kind: "lexical_candidate", target: goldTarget, lane: "unicode61" as const,
      rank: 4, lane_rank: 2, bm25: 1.5 } };
    const eventOnly = attributed({ frames: [captured([lexical], call, facts(), { diagnostics: diagnostic })] });
    expect(eventOnly.observation).toMatchObject({ complete: false, progress_complete: true });
    expect(eventOnly.layer).not.toBe("U");
    expect(eventOnly.messages[0]?.routes.find(row => row.route === "index:original:lexical")).toMatchObject({
      native: { lexical_ranks: [{ rank: 4, lane: "unicode61", lane_rank: 2, bm25: 1.5 }] },
      unknowns: expect.arrayContaining([{ stage: "nomination", reason: "lexical_candidate_detail_unavailable" }]) });
    expect(eventOnly.messages[0]?.routes.find(row => row.route === "index:hint:lexical")?.unknowns
      .some(value => value.reason === "lexical_candidate_detail_unavailable")).toBe(false);
    expect(eventOnly.messages[0]?.routes.find(row => row.route === "index:original:vector")?.unknowns
      .some(value => value.reason === "lexical_candidate_detail_unavailable")).toBe(false);
    const receipt = attributed({ frames: [captured([routeEvent, lexical], call, facts(), { diagnostics: diagnostic })] });
    expect(receipt.messages[0]?.routes.find(row => row.route === "index:original:lexical")).toMatchObject({
      nomination: "passed", native: { lexical_ranks: [{ rank: 2, lane_rank: 1, bm25: -3.5 }] } });
    expect(receipt.messages[0]?.routes.find(row => row.route === "index:original:lexical")?.unknowns
      .some(value => value.reason === "lexical_candidate_detail_unavailable")).toBe(false);
    expect(attributed({ visibility: visibility(gold(), "hit"),
      frames: [captured([routeEvent, lexical], call, facts(), { diagnostics: diagnostic })] }).layer).toBe("H");
  });

  it("preserves a cap rejection when its rank diagnostic is unavailable", () => {
    const attempt = { kind: "source_index_acquisition", phase: "observation", data: {
      invocation: "original", kind: "nomination_attempt", channel: "vector", target: target(unit()),
      disposition: "nomination_limit" } };
    const result = attributed({ frames: [captured([attempt], call, facts(), { diagnostics: {
      status: "overflow", compacted_events: 0, omitted_events: 1,
      counts: { source_index_original_vector_ranked: 129 }, omitted_counts: { source_index_original_vector_ranked: 1 } } })] });
    expect(result.layer).toBe("L2");
    expect(result.observation).toMatchObject({ complete: false, progress_complete: true });
    expect(result.messages[0]?.routes.find(row => row.route === "index:original:vector")).toMatchObject({
      nomination: "failed", native: { vector: null },
      unknowns: [{ stage: "nomination", reason: "vector_rank_unavailable" }] });
  });

  it("treats a duplicate as retained route participation, not distinct admission or consumer visibility", () => {
    const duplicate = { kind: "source_index_acquisition", phase: "observation", data: {
      invocation: "original", kind: "nomination_attempt", channel: "vector", target: target(unit()), disposition: "duplicate" } };
    const result = attributed({ frames: [captured([duplicate])] });
    expect(result.layer).toBe("L2");
    expect(result.messages[0]).toMatchObject({ candidate: "absent", read: "none", visibility: { delivery: "failed" } });
    expect(result.messages[0]?.routes.find(row => row.route === "index:original:vector")).toMatchObject({ nomination: "passed" });
  });

  it("conserves the exclusive question partition while opportunity bounds overlap independently", () => {
    const rows = [attributed({ visibility: visibility(gold(), "hit"), frames: [] }),
      attributed({ frozen_index: frozen(unit(), false) }), attributed(),
      attributed({ frames: [captured([], call, facts(call, { pool: pool([unit()]) }))] }),
      attributed({ frames: [captured([returned(0, 30)], call, facts(call, { pool: pool([unit()]) }))] }),
      attributed({ frames: [] })];
    expect(rows.map(row => row.layer)).toEqual(["H", "L1", "L2", "L3", "L4", "U"]);
    expect(summarizeObservationAttribution(rows)).toMatchObject({ denominator: 6, H: 1, L1: 1, L2: 1,
      L3: 1, L4: 1, U: 1, conserved: true, opportunities: { L2: { lower: 1, upper: 2, unknown: 1 } } });
    const second = span(unit("root-b"), 1), answer = gold([span(), second]);
    const result = attributed({ answer_gold: answer, frames: [captured([returned(0, 30)], call, facts(call, { pool: pool([unit()]) }))],
      frozen_index: { ...frozen(), header: { ...frozen().header, roots: 2, pages: 2 },
        pages: [...frozen().pages, ...frozen(unit("root-b"), false).pages] } });
    expect(result.layer).toBe("L4");
    expect(result.opportunities).toMatchObject({ L1: true, L4: true });
    expect(result.opportunities.legal_delivery_bound).toBe("unknown_no_sufficient_evidence_sets");
  });

  it("preserves the shared scorer's per-message delivery, reasons and intervals without native admission gating", () => {
    const first = unit(), second = unit("root-b"), answer = gold([span(first), span(second, 1)]);
    const page: ConsumerVisibilityPage = { page: 1, status: "observed", reason: null, occupied_slots: 5,
      complete: true, continuation: "none", terminal_tail: { status: "unknown", reason: "native_access_or_computation_unresolved" },
      intervals: [{ rank: 2, target: first, start: 0, end: 30 }] };
    const score = scoreConsumerMessageVisibility({ gold: answer, pages: [page] });
    expect(score.messages.map(message => message.at_5.status)).toEqual(["hit", "miss"]);
    const observe = (value: ConsumerVisibilityScore) => attributed({ answer_gold: answer, visibility: value,
      frames: [captured([{ kind: "encoded_membership", phase: "final_delivery", data: { offset: 0,
        results: [first, second].map(value => ({ target: target(value), preview_bytes: 30, within_budget: true })) } }])] });
    const result = observe(score);
    expect(result.layer).toBe("H");
    expect(result.messages.map(message => [message.visibility.delivery, message.visibility.reason]))
      .toEqual([["passed", null], ["failed", null]]);
    expect(result.messages[0]?.visibility.visible_intervals).toEqual([{ rank: 2, target: first, start: 0, end: 30 }]);
    expect(result.messages.map(message => message.routes.find(route => route.route === "delivery")?.delivery)).toEqual(["passed", "failed"]);
    expect(observe({ ...score, messages: [...score.messages].reverse() }).messages.map(message => message.visibility.delivery))
      .toEqual(["passed", "failed"]);
    const unavailable = scoreConsumerMessageVisibility({ gold: answer, pages: [page], unavailableReason: "delivery_unadmitted" });
    expect(observe(unavailable).messages.every(message => message.visibility.reason === "delivery_unadmitted")).toBe(true);
    expect(observe({ ...score, messages: [score.messages[0]!] }).messages[1]?.visibility.reason).toBe("consumer_visibility_message_missing");
    expect(observe({ ...score, messages: [score.messages[0]!, score.messages[0]!] }).messages[0]?.visibility.reason)
      .toBe("consumer_visibility_message_ambiguous");
  });
});
