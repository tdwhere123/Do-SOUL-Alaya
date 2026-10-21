import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => { isolation.restore(); });
import { SourceSemanticAcquisitionPhaseSchema } from "@do-soul/alaya-protocol";
import { SourceSemanticObserver, readSourceSemanticObservation }
  from "../../../../../core-daemon/src/runtime/recall-read-worker/source-semantic-observation.js";
import { attributeObservation } from "../../../runs/longmemeval-semantic/observation-attribution.js";
import { scoreConsumerMessageVisibility } from "../../../runs/longmemeval-semantic/message-visibility.js";
import type { SourceGoldUnit } from "../../../runs/measurement/source-gold-join.js";

const DIGEST = `sha256:${"ab".repeat(32)}`;
const SNAPSHOT = `sha256:${"cd".repeat(32)}`;
const INVALID_DIGEST = "sha256:not-a-digest";
const SHORT_DIGEST = `sha256:${"ab".repeat(31)}`;
const UPPER_DIGEST = `sha256:${"AB".repeat(32)}`;
const gold: SourceGoldUnit = { workspace_id: "ws", root_kind: "source_record", root_id: "root-a",
  source_version: "1", content_digest: DIGEST };
const target = { kind: "source_evidence" as const, ...gold, evidence_object_id: null };
const window = { window_id: DIGEST, content_digest: DIGEST, start_byte: 8, end_byte: 16 };
const lexical = { rank: 4, lane: "unicode61" as const, lane_rank: 2, bm25: 1.5 };
const vector = { rank: 9, cosine: 0.4, window };
const refusal = { stage: "nomination" as const, phase: "source nomination retention" };
const acquisition = SourceSemanticAcquisitionPhaseSchema.unwrap().shape.result.unwrap().unwrap();
const nomination = acquisition.shape.nominations.unwrap().element.unwrap().shape;
const lexicalRankSchema = nomination.lexical.unwrap().element;
const vectorRankSchema = nomination.vector.unwrap();
const resourceRefusalSchema = acquisition.shape.resource_refusals.unwrap().element;
const answer = { unit: "published_body_utf8_bytes" as const, annotated_turns: 1, complete: true,
  spans: [{ session_index: 0, message_index: 0, source_id: "source-root-a", target: gold, start: 10, end: 20 }] };
const visibility = scoreConsumerMessageVisibility({ gold: answer, pages: [{ page: 1, status: "observed",
  reason: null, occupied_slots: 0, complete: true, continuation: "none", intervals: [],
  terminal_tail: { status: "unknown", reason: "native_access_or_computation_unresolved" } }] });

function admit(requestId: number, events: readonly { kind: string; data: () => unknown; diagnostic?:
  "source_index_original_vector_ranked" | "source_index_original_lexical_candidate" }[]) {
  const observer = new SourceSemanticObserver(requestId, { max_events: 512, max_bytes: 262144 });
  observer.meter(null, id => ({ id, parent: null, phase: "observation",
    initial: { work_units: 1, memory_bytes: 1 }, remaining: { work_units: 1, memory_bytes: 1 },
    spent: { work_units: 0, memory_bytes: 0 }, held: { work_units: 0, memory_bytes: 0 },
    capacity: { current: { work_units: 1, memory_bytes: 1 }, adjustment: { work_units: 0, memory_bytes: 0 },
      changes: 0 } }));
  for (const event of events) observer.event(event.kind, "observation", event.data, event.diagnostic);
  const finished = observer.finish("success");
  const admitted = readSourceSemanticObservation(JSON.parse(JSON.stringify(finished)), requestId);
  const call = { kind: "recall" as const, request_id: requestId, session_id: "session", query_key: "q",
    snapshot_id: SNAPSHOT, workspace_id: "ws", as_of: "2026-10-20T00:00:00Z" };
  return { finished, admitted, attribution: attributeObservation({ question_id: "index-metadata", k: 5, call,
    frames: [{ call, observation: admitted }], frozen_index: null, admitted_roots: new Map(),
    admitted_roots_complete: true, answer_gold: answer, visibility }) };
}
function route(attribution: ReturnType<typeof admit>["attribution"], name: string) {
  return attribution.messages[0]?.routes.find(row => row.route === name);
}
function capturedData(admitted: ReturnType<typeof admit>["admitted"]) {
  return admitted.events.map(event => event.data as Record<string, unknown>);
}

it("does not project schema-invalid index rank, window or refusal metadata as native evidence", () => {
  const malformed = [
    { label: "invalid window_id digest", kind: "vector_ranked" as const, data: { ...vector, window: { ...window, window_id: INVALID_DIGEST } } },
    { label: "short content_digest", kind: "vector_ranked" as const, data: { ...vector, window: { ...window, content_digest: SHORT_DIGEST } } },
    { label: "uppercase window digest", kind: "vector_ranked" as const, data: { ...vector, window: { ...window, window_id: UPPER_DIGEST } } },
    { label: "negative vector rank", kind: "vector_ranked" as const, data: { ...vector, rank: -1 } },
    { label: "fractional vector rank", kind: "vector_ranked" as const, data: { ...vector, rank: 1.5 } },
    { label: "negative window byte", kind: "vector_ranked" as const, data: { ...vector, window: { ...window, start_byte: -1 } } },
    { label: "fractional window byte", kind: "vector_ranked" as const, data: { ...vector, window: { ...window, end_byte: 16.2 } } },
    { label: "nonfinite cosine before JSON", kind: "vector_ranked" as const, data: { ...vector, cosine: Number.POSITIVE_INFINITY } },
    { label: "NaN cosine before JSON", kind: "vector_ranked" as const, data: { ...vector, cosine: Number.NaN } },
    { label: "unexpected window field", kind: "vector_ranked" as const, data: { ...vector, window: { ...window, extra: true } } },
    { label: "negative lexical rank", kind: "lexical_candidate" as const, data: { ...lexical, rank: -2 } },
    { label: "fractional lexical rank", kind: "lexical_candidate" as const, data: { ...lexical, rank: 0.5 } },
    { label: "invalid lexical lane", kind: "lexical_candidate" as const, data: { ...lexical, lane: "whitespace" } },
    { label: "nonfinite bm25 before JSON", kind: "lexical_candidate" as const, data: { ...lexical, bm25: Number.NaN } },
    { label: "invalid refusal stage", kind: "nomination_attempt" as const, data: { channel: "vector", disposition: "resource_refused",
      resource_refusal: { stage: "scoring", phase: "budget" } } },
    { label: "unexpected refusal field", kind: "nomination_attempt" as const, data: { channel: "vector", disposition: "resource_refused",
      resource_refusal: { ...refusal, extra: true } } }
  ];
  for (const [index, row] of malformed.entries()) {
    const diagnostic = row.kind === "vector_ranked" ? "source_index_original_vector_ranked" as const
      : row.kind === "lexical_candidate" ? "source_index_original_lexical_candidate" as const : undefined;
    const { admitted, attribution } = admit(40 + index, [{ kind: "source_index_acquisition", diagnostic, data: () => ({
      invocation: "original", kind: row.kind, target, ...row.data }) }]);
    expect(admitted.status, row.label).not.toBe("unavailable");
    expect(admitted.events, row.label).toHaveLength(1);
    const named = row.kind === "lexical_candidate" ? "index:original:lexical" : "index:original:vector";
    const fact = route(attribution, named), native = fact?.native;
    const payload = capturedData(admitted)[0] ?? {};
    const field = row.kind === "vector_ranked" ? "vector_rank"
      : row.kind === "lexical_candidate" ? "lexical_rank" : "resource_refusal";
    expect(fact, row.label).toMatchObject({ diagnostic_issues: [{ field,
      reference: { request_id: 40 + index, event_position: 0 } }] });
    expect(attribution.messages[0], row.label).toMatchObject({ diagnostic_issues: [{ route: named, field,
      reference: { request_id: 40 + index, event_position: 0 } }] });
    expect(native?.limitations, row.label).toEqual([]);
    if (row.kind === "vector_ranked") {
      expect(vectorRankSchema.safeParse({ rank: payload.rank, cosine: payload.cosine, window: payload.window }).success,
        row.label).toBe(false);
      expect(fact?.nomination, row.label).toBe("unknown");
      expect(native?.vector, row.label).toBeNull();
      expect(JSON.stringify(native?.vector), row.label).not.toContain(INVALID_DIGEST);
      expect(JSON.stringify(native?.vector), row.label).not.toContain(SHORT_DIGEST);
      expect(JSON.stringify(native?.vector), row.label).not.toContain("AB".repeat(8));
      expect(fact?.unknowns.some(value => value.reason === "vector_rank_unavailable"), row.label).toBe(true);
    } else if (row.kind === "lexical_candidate") {
      expect(lexicalRankSchema.safeParse({ rank: payload.rank, lane: payload.lane, lane_rank: payload.lane_rank,
        bm25: payload.bm25 }).success, row.label).toBe(false);
      expect(fact?.nomination, row.label).toBe("unknown");
      expect(native?.lexical_ranks, row.label).toBeNull();
      expect(fact?.unknowns.some(value => value.reason === "lexical_rank_unavailable"), row.label).toBe(true);
    } else {
      expect(resourceRefusalSchema.safeParse(payload.resource_refusal).success, row.label).toBe(false);
      expect(native?.attempts?.[0]?.resource_refusal, row.label).toBeNull();
      expect(JSON.stringify(native?.attempts), row.label).not.toContain("scoring");
      expect(JSON.stringify(native?.attempts), row.label).not.toContain("\"extra\"");
    }
    expect(attribution.layer, row.label).toBe("U");
    expect(attribution.layer, row.label).not.toBe("H");
  }
});

it("keeps schema-valid lexical, vector window and refusal facts after observer JSON admission", () => {
  const { admitted, attribution } = admit(8, [
    { kind: "source_index_acquisition", diagnostic: "source_index_original_lexical_candidate", data: () => ({
      invocation: "original", kind: "lexical_candidate", target, ...lexical }) },
    { kind: "source_index_acquisition", diagnostic: "source_index_original_vector_ranked", data: () => ({
      invocation: "original", kind: "vector_ranked", target, ...vector }) },
    { kind: "source_index_acquisition", data: () => ({ invocation: "original", kind: "nomination_attempt",
      channel: "vector", target, disposition: "resource_refused", resource_refusal: refusal }) }
  ]);
  expect(admitted.status).toBe("observed");
  expect(vectorRankSchema.safeParse(vector).success).toBe(true);
  expect(lexicalRankSchema.safeParse(lexical).success).toBe(true);
  expect(resourceRefusalSchema.safeParse(refusal).success).toBe(true);
  expect(route(attribution, "index:original:lexical")?.native).toMatchObject({ lexical_ranks: [lexical] });
  expect(route(attribution, "index:original:vector")?.native).toMatchObject({
    vector, attempts: [{ disposition: "resource_refused", resource_refusal: refusal }] });
  expect(attribution.messages[0]).toMatchObject({ diagnostic_issues: [] });
  expect(attribution.messages[0]?.routes.every(row => row.diagnostic_issues.length === 0)).toBe(true);
  expect(attribution.layer).toBe("U");
});

it("keeps an independent valid vector when a malformed diagnostic is captured first", () => {
  const { admitted, attribution } = admit(9, [
    { kind: "source_index_acquisition", diagnostic: "source_index_original_vector_ranked", data: () => ({
      invocation: "original", kind: "vector_ranked", target, ...vector,
      window: { ...window, window_id: INVALID_DIGEST } }) },
    { kind: "source_index_acquisition", diagnostic: "source_index_original_vector_ranked", data: () => ({
      invocation: "original", kind: "vector_ranked", target, ...vector }) }
  ]);
  const events = capturedData(admitted);
  expect(events[0]?.window).toMatchObject({ window_id: INVALID_DIGEST });
  expect(vectorRankSchema.safeParse({ rank: events[0]?.rank, cosine: events[0]?.cosine, window: events[0]?.window }).success)
    .toBe(false);
  expect(vectorRankSchema.safeParse({ rank: events[1]?.rank, cosine: events[1]?.cosine, window: events[1]?.window }).success)
    .toBe(true);
  const fact = route(attribution, "index:original:vector");
  expect(fact?.native?.vector).toEqual(vector);
  expect(JSON.stringify(fact?.native?.vector)).not.toContain(INVALID_DIGEST);
  expect(fact).toMatchObject({ diagnostic_issues: [{ field: "vector_rank",
    reference: { request_id: 9, event_position: 0 } }] });
  expect(fact?.unknowns.some(value => value.reason === "vector_rank_unavailable")).toBe(false);
  expect(fact?.event_references.map(value => value.event_position)).toEqual([0, 1]);
  expect(attribution.messages[0]).toMatchObject({ diagnostic_issues: [{ route: "index:original:vector",
    field: "vector_rank", reference: { request_id: 9, event_position: 0 } }] });
  expect(attribution.layer).toBe("U");
});
