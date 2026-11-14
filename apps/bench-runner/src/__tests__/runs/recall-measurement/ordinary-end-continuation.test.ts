import { afterAll, beforeAll, expect, it, vi } from "vitest";

const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary();
});

import { rmSync } from "node:fs";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { canonicalJson, sourceRecallTarget } from "@do-soul/alaya-protocol";
import { executeOrdinaryRecallEntry } from "../../../runs/recall-measurement/ordinary/ordinary-entry-execution.js";
import { endContinuationReading } from "../../../runs/recall-measurement/ordinary/ordinary-end-continuation.js";
import {
  OrdinaryEndContinuationSchema, OrdinaryRecallSourceIntervalSchema
} from "../../../runs/recall-measurement/ordinary/ordinary-entry-contract.js";
import { ordinaryIndexedSnapshot, simulateIndexedQueryPreparation } from "./ordinary-indexed-snapshot.test-support.js";

const PROJECTS = ["Aster", "Birch", "Cedar", "Dock", "Elm", "Fir", "Gum", "Hickory", "Ivy", "Juniper", "Kapok", "Larch"] as const;

let base: Awaited<ReturnType<typeof ordinaryIndexedSnapshot>>;
let preparation: ReturnType<typeof simulateIndexedQueryPreparation>;
beforeAll(async () => {
  preparation = simulateIndexedQueryPreparation();
  base = await ordinaryIndexedSnapshot(PROJECTS.map(name =>
    `Project ${name} was mentioned. ${`${name} context continues here. `.repeat(120)}${name} closing line.`));
}, 120000);
afterAll(() => {
  preparation?.mockRestore();
  if (base !== undefined) rmSync(base.root, { recursive: true, force: true });
  isolation.restore(); expect(isolation.violations).toEqual([]);
});

function bodyBytes(rootId: string): number {
  const db = new BetterSqlite3(base.config.snapshot_path, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare("SELECT source_body FROM source_records WHERE workspace_id=? AND record_id=?")
      .get(base.config.workspace_id, rootId) as { source_body: string };
    return Buffer.byteLength(row.source_body);
  } finally { db.close(); }
}

it("reads every cut slot to its end after the same membership window the current reader sees", async () => {
  const query = base.queries[0]!;
  const queries = [{ query_key: query.query_key, original_query: query.original_query }];
  const current = await executeOrdinaryRecallEntry({ config: base.config, root: join(base.root, "current"), queries });
  const continued = await executeOrdinaryRecallEntry({
    config: base.config, root: join(base.root, "end-continuation"), queries, reader: "end_continuation"
  });
  expect(continued.input_identity).not.toBe(current.input_identity);
  const plain = current.rows[0]!, row = continued.rows[0]!;
  expect(plain.end_continuation).toBeUndefined();
  expect(row.status).toBe("complete");
  expect(row.stop_cause).toBe("observed_ten_slot_prefix");
  expect(canonicalJson(row.source_intervals)).toBe(canonicalJson(plain.source_intervals));

  const record = row.end_continuation!;
  const cut = row.source_intervals.filter(interval => interval.span !== null && !interval.span.content_complete);
  expect(cut.length).toBeGreaterThan(0);
  expect(record).toMatchObject({ cut_slots: cut.length, completed_slots: cut.length, issues: [] });
  expect(record.payload_calls).toBeGreaterThanOrEqual(cut.length);
  expect(record.payload_calls).toBeLessThanOrEqual(12 * cut.length);
  for (const interval of cut) {
    if (interval.target.kind !== "source_evidence") throw new Error("cut slot is not source evidence");
    const parts = record.continuations.filter(part => part.slot_index === interval.slot_index);
    expect(parts[0]!.span.content_start).toBeLessThanOrEqual(interval.span!.content_end);
    expect(parts.map(part => part.span.content_end)).toEqual([...parts.map(part => part.span.content_end)].sort((a, b) => a - b));
    expect(parts.at(-1)!.span).toMatchObject({ content_complete: true, content_end: bodyBytes(interval.target.root_id) });
  }

  // A round without host message ends re-reads from its start; the current slots are kept first.
  const reading = endContinuationReading(row.source_intervals, record, () => []);
  expect(reading.intervals.slice(0, row.source_intervals.length)).toEqual(row.source_intervals);
  expect(reading.intervals.slice(row.source_intervals.length).map(interval => [interval.slot_index, interval.span!.content_start]))
    .toEqual(cut.map(interval => [interval.slot_index, 0]));
  expect(reading).toMatchObject({ cut: cut.length, completed: cut.length });
}, 240000);

it("re-reads a continued slot from the last message end at or before its cut", () => {
  const span = (start: number, end: number, complete: boolean) => ({
    content_start: start, content_end: end, retained_extent: "body" as const, content_complete: complete, original_complete: complete
  });
  const at = (root: string, part: ReturnType<typeof span>) => sourceRecallTarget({ workspace_id: "w", root_kind: "source_record",
    root_id: root, source_version: "v", content_digest: `sha256:${"a".repeat(64)}`, evidence_object_id: null, span: part });
  const intervals = [
    { slot_index: 0, target: at("r", span(0, 40, false)), span: span(0, 40, false) },
    { slot_index: 1, target: at("s", span(0, 20, true)), span: span(0, 20, true) }
  ].map(interval => OrdinaryRecallSourceIntervalSchema.parse(interval));
  const record = OrdinaryEndContinuationSchema.parse({ cut_slots: 1, completed_slots: 1, payload_calls: 2, issues: [], latency_ms: 1,
    continuations: [
      { slot_index: 0, target: at("r", span(40, 70, false)), span: span(40, 70, false) },
      { slot_index: 0, target: at("r", span(70, 90, true)), span: span(70, 90, true) }
    ] });
  const reading = endContinuationReading(intervals, record, root => root === "r" ? [12, 40, 90] : []);
  expect(reading.intervals[2]).toMatchObject({ slot_index: 0, span: { content_start: 40, content_end: 90, content_complete: true } });
  const earlier = endContinuationReading(intervals, record, () => [12, 41, 90]);
  expect(earlier.intervals[2]!.span).toMatchObject({ content_start: 12, content_end: 90 });
  expect(earlier).toMatchObject({ cut: 1, completed: 1, initial_bytes: 60, continuation_bytes: 78 });
});

it("reads the prefix of a slot that opened mid-root after the rest of that root", () => {
  const span = (start: number, end: number, complete: boolean) => ({
    content_start: start, content_end: end, retained_extent: "body" as const, content_complete: complete, original_complete: complete
  });
  const at = (root: string, part: ReturnType<typeof span>) => sourceRecallTarget({ workspace_id: "w", root_kind: "source_record",
    root_id: root, source_version: "v", content_digest: `sha256:${"a".repeat(64)}`, evidence_object_id: null, span: part });
  const intervals = [
    { slot_index: 0, target: at("r", span(30, 50, false)), span: span(30, 50, false) },
    { slot_index: 1, target: at("s", span(10, 20, true)), span: span(10, 20, true) },
    { slot_index: 2, target: at("t", span(0, 20, true)), span: span(0, 20, true) }
  ].map(interval => OrdinaryRecallSourceIntervalSchema.parse(interval));
  const record = OrdinaryEndContinuationSchema.parse({ cut_slots: 2, completed_slots: 2, payload_calls: 4, issues: [], latency_ms: 1,
    continuations: [
      { slot_index: 0, target: at("r", span(50, 90, true)), span: span(50, 90, true) },
      { slot_index: 0, target: at("r", span(0, 12, false)), span: span(0, 12, false), part: "prefix" },
      { slot_index: 0, target: at("r", span(12, 30, false)), span: span(12, 30, false), part: "prefix" },
      { slot_index: 1, target: at("s", span(0, 10, false)), span: span(0, 10, false), part: "prefix" }
    ] });
  // Message ends before the opening never pull the forward re-read back into the prefix; a prefix
  // read in several calls is scored as one span, so a message across a call boundary is seen whole.
  const reading = endContinuationReading(intervals, record, root => root === "r" ? [12, 30, 50, 90] : [10, 20]);
  expect(reading.intervals.slice(3).map(interval => [interval.slot_index, interval.span!.content_start, interval.span!.content_end]))
    .toEqual([[0, 50, 90], [0, 0, 30], [1, 0, 10]]);
  expect(reading).toMatchObject({ cut: 1, completed: 1, initial_bytes: 50, continuation_bytes: 80 });
});

it("reads a cut opening on to its witness range before the next slot", () => {
  const span = (start: number, end: number, complete: boolean) => ({
    content_start: start, content_end: end, retained_extent: "body" as const, content_complete: complete, original_complete: complete
  });
  const at = (root: string, part: ReturnType<typeof span>) => sourceRecallTarget({ workspace_id: "w", root_kind: "source_record",
    root_id: root, source_version: "v", content_digest: `sha256:${"a".repeat(64)}`, evidence_object_id: null, span: part });
  const intervals = [
    { slot_index: 0, target: at("r", span(30, 50, false)), span: span(30, 50, false), opening_end: 70 },
    { slot_index: 1, target: at("s", span(0, 20, true)), span: span(0, 20, true) }
  ].map(interval => OrdinaryRecallSourceIntervalSchema.parse(interval));
  const record = OrdinaryEndContinuationSchema.parse({ cut_slots: 1, completed_slots: 1, payload_calls: 2, issues: [], latency_ms: 1,
    continuations: [
      { slot_index: 0, target: at("r", span(50, 90, true)), span: span(50, 90, true) },
      { slot_index: 0, target: at("r", span(0, 30, false)), span: span(0, 30, false), part: "prefix" }
    ] });
  const reading = endContinuationReading(intervals, record, root => root === "r" ? [30, 70, 90] : [20]);
  expect(reading.intervals.map(interval => [interval.slot_index, interval.span!.content_start, interval.span!.content_end]))
    .toEqual([[0, 30, 50], [0, 30, 70], [1, 0, 20], [0, 70, 90], [0, 0, 30]]);
  expect(reading).toMatchObject({ cut: 1, completed: 1, initial_bytes: 40, continuation_bytes: 90 });
  // Without an opening range the reader is unchanged.
  const plain = endContinuationReading(intervals.map(({ opening_end: _o, ...interval }) => interval), record, root => root === "r" ? [30, 70, 90] : [20]);
  expect(plain.intervals.map(interval => [interval.slot_index, interval.span!.content_start, interval.span!.content_end]))
    .toEqual([[0, 30, 50], [1, 0, 20], [0, 30, 90], [0, 0, 30]]);
});
