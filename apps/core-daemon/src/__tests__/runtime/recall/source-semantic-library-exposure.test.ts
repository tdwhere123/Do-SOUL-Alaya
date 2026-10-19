import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => { isolation.restore(); });
import { fieldReceiptContractFields, hashSourceRecordId, sourceRecallTarget, SOURCE_SPAN_IDENTITY_OPERATOR_ID,
  SourceRecordIdentitySchema } from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { compareSourcePositionExposure, createSourcePositionExposureMeter, type ExposureSource } from "./source-semantic-library-exposure.test-support.js";

function published(body: string, source_id = "event-a", source_version = "1", workspace_id = "ws"): ExposureSource {
  const content_digest = `sha256:${fieldContractSha256(body)}`;
  const identity = hashSourceRecordId({ source_id, source_version, content_digest }, fieldContractSha256);
  return { body, record: SourceRecordIdentitySchema.parse({
    ...fieldReceiptContractFields({ identity, producer: SOURCE_SPAN_IDENTITY_OPERATOR_ID, consumer: "projection_generation" }),
    schema_version: 1, workspace_id, source_id, source_version, content_digest, evidence_object_id: null,
    recorded_at: "2026-09-18T00:00:00.000Z", event_time: null, valid_from: null, valid_to: null,
    scope_class: "project", operator_id: SOURCE_SPAN_IDENTITY_OPERATOR_ID }) };
}
function observation(source: ExposureSource, start: number, end: number, preview?: string) {
  const { record } = source;
  const target = sourceRecallTarget({ workspace_id: record.workspace_id, root_kind: "source_record", root_id: record.identity,
    source_version: record.source_version, content_digest: record.content_digest, evidence_object_id: record.evidence_object_id,
    span: { content_start: start, content_end: end, retained_extent: "body", content_complete: false, original_complete: true } });
  return { target, preview: preview ?? Buffer.from(source.body).subarray(start, end).toString("utf8"), withinBudget: true };
}

it("unions overlapping, duplicate and adjacent source positions without counting them twice", () => {
  const source = published("abcdefghij"), meter = createSourcePositionExposureMeter();
  expect(meter.observe([observation(source, 0, 5), observation(source, 3, 8)], [source])).toMatchObject({
    status: "complete", increment: 8, cumulative_known: 8, newly_verified_intervals: [{ start: 0, end: 8 }],
    cumulative_intervals: [{ intervals: [{ start: 0, end: 8 }] }] });
  expect(meter.observe([observation(source, 0, 5)], [source])).toMatchObject({ increment: 0, newly_verified_intervals: [] });
  expect(meter.observe([observation(source, 8, 10)], [source])).toMatchObject({ increment: 2, cumulative_known: 10,
    newly_verified_intervals: [{ start: 8, end: 10 }],
    cumulative_intervals: [{ intervals: [{ start: 0, end: 10 }] }] });
});

it("subtracts multiple previously observed islands from a covering interval", () => {
  const source = published("abcdefghij"), meter = createSourcePositionExposureMeter();
  expect(meter.observe([observation(source, 0, 2), observation(source, 4, 6), observation(source, 8, 10)], [source]).increment).toBe(6);
  expect(meter.observe([observation(source, 1, 9)], [source])).toMatchObject({ increment: 4, cumulative_known: 10,
    newly_verified_intervals: [{ start: 2, end: 4 }, { start: 6, end: 8 }], cumulative_intervals: [{ intervals: [{ start: 0, end: 10 }] }] });
});

it("compares verified unions and keeps an unresolved comparison unknown", () => {
  const source = published("abcdefghij");
  const before = createSourcePositionExposureMeter().observe([observation(source, 0, 4), observation(source, 6, 10)], [source]);
  const after = createSourcePositionExposureMeter().observe([observation(source, 2, 8)], [source]);
  expect(compareSourcePositionExposure(before, after)).toMatchObject([{ status: "lost", lost_bytes: 4 }]);
  const covering = createSourcePositionExposureMeter().observe([observation(source, 0, 10)], [source]);
  expect(compareSourcePositionExposure(before, covering)).toMatchObject([{ status: "retained", lost_bytes: 0 }]);
  const empty = createSourcePositionExposureMeter().observe([], [source]);
  expect(compareSourcePositionExposure(before, empty)).toMatchObject([{ status: "lost", lost_bytes: 8 }]);
  const unknown = createSourcePositionExposureMeter().observe([observation(source, 0, 4)], []);
  expect(compareSourcePositionExposure(before, unknown)).toEqual([{ root: null, status: "unknown", lost_bytes: null }]);
  expect(compareSourcePositionExposure(unknown, covering)).toEqual([{ root: null, status: "unknown", lost_bytes: null }]);
});

it("counts equal text at disjoint offsets and in independent events separately", () => {
  const first = published("echo echo"), second = published("echo echo", "event-b"), meter = createSourcePositionExposureMeter();
  expect(meter.observe([observation(first, 0, 4)], [first]).increment).toBe(4);
  expect(meter.observe([observation(first, 5, 9), observation(second, 0, 4)], [first, second])).toMatchObject({
    increment: 8, cumulative_known: 12 });
});

it("never merges versions, digests or workspaces even when the exposed text matches", () => {
  const sources = [published("echo one"), published("echo one", "event-a", "2"), published("echo two"),
    published("echo one", "event-a", "1", "another-workspace")];
  // Hold the root coordinate fixed to independently exercise every other identity field.
  const mapped = sources.map(source => ({ ...source, record: { ...source.record, identity: sources[0]!.record.identity } }));
  const meter = createSourcePositionExposureMeter();
  expect(mapped.map(source => meter.observe([observation(source, 0, 4)], mapped).increment)).toEqual([4, 4, 4, 4]);
  expect(meter.observe([], mapped).cumulative_known).toBe(16);
});

it("uses UTF-8 positions rather than UTF-16 lengths and refuses split-scalar addresses", () => {
  const source = published("é猫🙂x"), meter = createSourcePositionExposureMeter();
  expect(meter.observe([observation(source, 0, 5)], [source]).increment).toBe(5);
  expect(meter.observe([observation(source, 2, 9)], [source])).toMatchObject({ increment: 4, cumulative_known: 9 });
  expect(meter.observe([observation(source, 1, 2)], [source])).toMatchObject({
    status: "unknown", increment: null, known_increment: 0, cumulative_known: 9 });
});

it.each(["missing_source", "ambiguous_source", "digest", "preview", "missing_span", "bounds", "omitted"] as const)(
  "keeps %s unknown and later verified positions separate from unresolved first exposure", failure => {
    const source = published("abcdefghij"), meter = createSourcePositionExposureMeter(), valid = observation(source, 0, 5);
    let sources = [source], observed = valid;
    if (failure === "missing_source") sources = [];
    if (failure === "ambiguous_source") sources = [source, source];
    if (failure === "digest") sources = [{ ...source, body: "xxxxxxxxxx" }];
    if (failure === "preview") observed = { ...valid, preview: "other" };
    if (failure === "missing_span") {
      const { span: _span, ...target } = valid.target;
      observed = { ...valid, target };
    }
    if (failure === "bounds") observed = observation(source, 0, 30, "abcde");
    if (failure === "omitted") observed = { ...valid, preview: "[payload omitted]", withinBudget: false };
    expect(meter.observe([observed], sources)).toMatchObject({ status: "unknown", increment: null, known_increment: 0, cumulative_known: 0 });
    expect(meter.observe([valid], [source])).toMatchObject({ status: "partial", increment: null, known_increment: 5,
      cumulative_known: 5, history_complete: false, issues: ["prior_observation_unresolved"] });
  });

it("records only the verified prefix of a truncated observation, not a fully observed interval", () => {
  const source = published("abcdefghij"), meter = createSourcePositionExposureMeter();
  expect(meter.observe([observation(source, 0, 10, "abcde")], [source])).toMatchObject({
    status: "partial", increment: null, known_increment: 5, cumulative_known: 5, issues: ["slot_0:preview_truncated"] });
  expect(meter.observe([observation(source, 0, 10)], [source])).toMatchObject({ status: "complete", increment: 5, cumulative_known: 10 });
});

it("distinguishes known empty delivery from missing observation and preserves mixed-page lower bounds", () => {
  const source = published("abcdefghij"), empty = published("", "empty"), meter = createSourcePositionExposureMeter();
  expect(meter.observe([observation(empty, 0, 0, "[empty source]")], [empty])).toMatchObject({ status: "complete", increment: 0 });
  expect(meter.observe([], [], ["delivery_observation_missing"])).toMatchObject({ status: "unknown", increment: null });
  const missing = observation(published("other", "missing"), 0, 5);
  expect(meter.observe([observation(source, 0, 5), missing], [source])).toMatchObject({
    status: "partial", increment: null, known_increment: 5, cumulative_known: 5 });
});
