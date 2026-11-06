import { afterAll, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => { expect(isolation.violations).toEqual([]); isolation.restore(); });
import type { NativeSourceNomination, StatementAssociation } from "@do-soul/alaya-core";
import { LibraryFieldObserver } from "../../../runtime/recall-read-worker/library-field-observation.js";
import { SourceSemanticObserver, readSourceSemanticObservation } from "../../../runtime/recall-read-worker/source-semantic-observation.js";

const limits = { max_events: 2048, max_bytes: 524288 };
function association(): StatementAssociation {
  // Independently authored runtime-sized vectors: enough to exceed the unchanged tree guard.
  return { roots: Array.from({ length: 16 }, (_, i) => `root-${i}`), question: Array(16).fill(0.5),
    keys: Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => ({
      embedding: Array(384).fill(0.125), norm: Math.sqrt(6) }))),
    link: Array.from({ length: 16 }, (_, i) => Array(i).fill(null)), refusal: { phase: null, swap_selected: false } };
}
function roundTrip(observer: SourceSemanticObserver) {
  return readSourceSemanticObservation(JSON.parse(JSON.stringify(observer.finish("success"))), 1);
}

it("keeps required nomination evidence within unchanged observation limits without serializing retained vectors", () => {
  const retained = association();
  const value: NativeSourceNomination = { result: null, witness: [], association: retained,
    question_time_order: ["root-2", "root-1"], admitted_roots: [] };
  const before = structuredClone(value);
  const raw = new SourceSemanticObserver(1, limits);
  raw.event("field_nomination", "observe", () => value);
  expect(roundTrip(raw)).toMatchObject({ status: "overflow", dropped_events: 1, events: [] });

  const observer = new SourceSemanticObserver(1, limits);
  observer.nomination(value);
  expect(value).toEqual(before); // Observation must not compute links or mutate native navigation state.
  retained.link[1]![0] = -1;
  retained.refusal.swap_selected = true;
  const frame = roundTrip(observer);
  expect(frame.status).toBe("observed");
  expect(frame.dropped_events).toBe(0);
  expect(frame.events).toEqual([{ kind: "field_nomination", phase: "observe", data: {
    result: null, witness: [], admitted_roots: [], question_time_order: ["root-2", "root-1"],
    beyond_observed_prefix: "unknown_not_nomination_limit",
    association: { representation: "retained-association-summary.v1", roots: before.association!.roots,
      question: before.association!.question, link: before.association!.link, refusal: before.association!.refusal,
      retained_key_counts: Array(16).fill(16), vectors: "not_captured_runtime_state" }
  } }]);
  expect(frame.overhead.event_json_bytes).toBeLessThan(4096);
  expect(JSON.stringify(frame.events)).not.toContain('"embedding"');
});

it("uses the same nomination representation for library capture and keeps absent association absent", () => {
  for (const retained of [undefined, association()]) {
    const value: NativeSourceNomination = { result: null, witness: [], ...(retained ? { association: retained } : {}) };
    const native = new SourceSemanticObserver(1, limits), library = new SourceSemanticObserver(1, limits);
    native.nomination(value);
    new LibraryFieldObserver(library, []).nomination(value, undefined, false);
    expect(roundTrip(library).events).toEqual(roundTrip(native).events);
    if (retained === undefined) expect(roundTrip(native).events[0]!.data).not.toHaveProperty("association");
  }
});

it("does not evaluate private vector data, and still refuses oversized required nomination facts", () => {
  const retained = association();
  const hostile = { ...retained, keys: [[{ norm: 1, get embedding(): readonly number[] {
    throw new Error("runtime vector data must not be observed");
  } }]] };
  const observer = new SourceSemanticObserver(1, limits);
  observer.nomination({ result: null, witness: [], association: hostile });
  expect(roundTrip(observer)).toMatchObject({ status: "observed", dropped_events: 0 });
  for (const constrained of [limits, { max_events: 0, max_bytes: 0 }]) {
    const bounded = new SourceSemanticObserver(1, constrained);
    bounded.nomination({ result: null, witness: [], question_time_order: Array(9000).fill("root") });
    expect(roundTrip(bounded)).toMatchObject({ status: "overflow", dropped_events: 1, events: [] });
  }
});
