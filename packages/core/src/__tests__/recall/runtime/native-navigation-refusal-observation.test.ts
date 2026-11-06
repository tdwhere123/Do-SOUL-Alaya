import { expect, it } from "vitest";
import { SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";
import { createConditionalField } from "../../../recall/conditional-field/engine/field-engine.js";
import { compileConditionalFieldQuery } from "../../../recall/conditional-field/query/compile-query.js";
import { nativeNavigationProjection, type NativeNavigationObservation } from "../../../recall/runtime/native-navigation-projection.js";
import { defaultBudget } from "../conditional-field/reference/deployment.fixture.js";
import { NOW } from "../conditional-field/vertical/source-slice.js";

function emptyField() {
  const budget = defaultBudget({ work_units: 10_000, memory_bytes: 1_000_000 });
  const interpretation = compileConditionalFieldQuery({ source: "ordinary", text: "needle", budget,
    snapshot_id: `sha256:${"a".repeat(64)}`, interpretation_clock: NOW, authorized_scopes: null });
  return createConditionalField({ interpretation, budget, authorized_scopes: null });
}

const refusals = [
  { resource: "work", budget: { work_units: 3, memory_bytes: 1_000 },
    constraints: { work: { required: 4, available: 3 } } },
  { resource: "memory", budget: { work_units: 100, memory_bytes: 128 },
    constraints: { memory: { required: 640, available: 128 } } },
  { resource: "work and memory", budget: { work_units: 3, memory_bytes: 128 },
    constraints: { work: { required: 4, available: 3 }, memory: { required: 640, available: 128 } } }
];

it.each(refusals.flatMap(row => [false, true].map(throws => ({ ...row, throws }))))(
  "preserves $resource refusal when its diagnostic payload is mutated (throws=$throws)",
  ({ budget, constraints, throws }) => {
    const state = emptyField(), baselineMeter = new SourceSemanticResourceLedger(budget);
    const baseline = nativeNavigationProjection(state, [], baselineMeter);
    expect(baseline).toMatchObject({ status: "resource_refused", constraints });
    const meter = new SourceSemanticResourceLedger(budget);
    const captures: NativeNavigationObservation[] = [], mutations: boolean[] = [];
    let calls = 0;
    const diagnostic = nativeNavigationProjection(state, [], meter, capture => {
      calls++;
      const frame = capture();
      captures.push(frame);
      for (const constraint of Object.values(frame.navigation_refusal!.constraints!)) {
        mutations.push(Reflect.set(constraint, "required", 999_999), Reflect.set(constraint, "available", -1));
      }
      captures.push(capture());
      if (throws) throw new Error("diagnostic observer failed after mutation");
    });
    // Assertions stay outside the callback: diagnostic exceptions are intentionally caught.
    expect(calls).toBe(1);
    expect(mutations).toEqual(Array(Object.keys(constraints).length * 2).fill(true));
    expect(diagnostic.status).toBe("resource_refused");
    if (diagnostic.status !== "resource_refused") throw new Error("Expected navigation refusal");
    expect(diagnostic.constraints).toEqual(constraints);
    expect(diagnostic.values.size).toBe(0);
    expect(diagnostic.values.at(0)).toBeUndefined();
    expect(captures[1]?.navigation_refusal).toEqual({ phase: "field navigation frames", constraints });
    expect({ work: meter.work, bytes: meter.bytes, spentWork: meter.spentWork, spentBytes: meter.spentBytes })
      .toEqual({ work: baselineMeter.work, bytes: baselineMeter.bytes,
        spentWork: baselineMeter.spentWork, spentBytes: baselineMeter.spentBytes });
  }
);

it("propagates a non-resource navigation error without calling the refusal observer", () => {
  const failure = new Error("native navigation failed");
  class FailingLedger extends SourceSemanticResourceLedger {
    override charge(): void { throw failure; }
  }
  let observed = false, caught: unknown;
  try {
    nativeNavigationProjection(emptyField(), [], new FailingLedger({ work_units: 100, memory_bytes: 1_000 }),
      () => { observed = true; throw new Error("diagnostic observer failed"); });
  } catch (error) { caught = error; }
  expect(caught).toBe(failure);
  expect(observed).toBe(false);
});
