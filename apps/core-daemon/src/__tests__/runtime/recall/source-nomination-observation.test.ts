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
  return { roots: Array.from({ length: 16 }, (_, i) => `root-${i}`), statements: 2,
    coverage: Array.from({ length: 16 }, (_, i) => i === 3 ? [null, null] : [0.5, i / 16]), decision: { refused: null, applied: false } };
}
function roundTrip(observer: SourceSemanticObserver) {
  return readSourceSemanticObservation(JSON.parse(JSON.stringify(observer.finish("success"))), 1);
}

it("records the retained evidence coverage as a bounded nomination fact without mutating navigation state", () => {
  const retained = association();
  const value: NativeSourceNomination = { result: null, witness: [], association: retained,
    question_time_order: ["root-2", "root-1"], admitted_roots: [] };
  const before = structuredClone(value);
  const observer = new SourceSemanticObserver(1, limits);
  observer.nomination(value);
  expect(value).toEqual(before);
  retained.decision.applied = true;
  const frame = roundTrip(observer);
  expect(frame).toMatchObject({ status: "observed", dropped_events: 0 });
  expect(frame.events).toEqual([{ kind: "field_nomination", phase: "observe", data: {
    result: null, witness: [], admitted_roots: [], question_time_order: ["root-2", "root-1"],
    beyond_observed_prefix: "unknown_not_nomination_limit",
    association: { representation: "retained-evidence-coverage.v1", roots: before.association!.roots,
      statements: 2, coverage: before.association!.coverage, decision: { refused: null, applied: false } }
  } }]);
  expect(frame.overhead.event_json_bytes).toBeLessThan(4096);
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

it("still refuses oversized required nomination facts", () => {
  for (const constrained of [limits, { max_events: 0, max_bytes: 0 }]) {
    const bounded = new SourceSemanticObserver(1, constrained);
    bounded.nomination({ result: null, witness: [], question_time_order: Array(9000).fill("root") });
    expect(roundTrip(bounded)).toMatchObject({ status: "overflow", dropped_events: 1, events: [] });
  }
});
