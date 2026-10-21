import { describe, expect, it } from "vitest";
import { createNativeRouteNomination, type NativeRouteLane,
  type NativeRouteOccurrence } from "../../../recall/runtime/native-route-opportunity.js";

function occurrence(reference: string, root_key: string, native_rank: number): NativeRouteOccurrence {
  return { reference, root_key, native_rank };
}
function lanes(rows: readonly (readonly NativeRouteOccurrence[])[]): NativeRouteLane[] {
  return ["original-lexical", "original-vector", "hint-lexical", "hint-vector"].map((lane, index) => ({
    lane: lane as NativeRouteLane["lane"], scope: index % 2 === 0 ? "fetched-lexical-page" : "exact-over-inspected-subset",
    ...(rows[index]?.length ? { state: "exact-captured", occurrences: rows[index]! } : { state: "measured-empty" })
  }));
}
const ADMITTED = { status: "admitted", started_phase: "scope_admission" } as const;

function drain(kernel: ReturnType<typeof createNativeRouteNomination>) {
  for (let next = kernel.next(); next !== null; next = kernel.next()) kernel.commit(next.ordinal, ADMITTED);
  return kernel.snapshot();
}

describe("captured native nomination opportunities", () => {
  it("uses all four lanes in the fixed cycle without renumbering sparse native ranks", () => {
    const kernel = createNativeRouteNomination({ max_attempts: 12, max_roots: 12, lanes: lanes([
      [occurrence("ol-a", "a", 2), occurrence("ol-e", "e", 19)],
      [occurrence("ov-b", "b", 11), occurrence("ov-f", "f", 70)],
      [occurrence("hl-c", "c", 8)], [occurrence("hv-d", "d", 42), occurrence("hv-g", "g", 90)]
    ]) });
    const result = drain(kernel);
    expect(result.trace.map(row => [row.pending.lane, row.pending.occurrence.reference, row.pending.occurrence.native_rank]))
      .toEqual([
        ["original-lexical", "ol-a", 2], ["original-vector", "ov-b", 11], ["hint-lexical", "hl-c", 8],
        ["hint-vector", "hv-d", 42], ["original-lexical", "ol-e", 19], ["original-vector", "ov-f", 70],
        ["hint-vector", "hv-g", 90]
      ]);
    expect(result.trace[1]!.pending.scope).toBe("exact-over-inspected-subset");
    expect(result.roots.map(root => root.root_key)).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
    expect(result.lanes.map(lane => [lane.consumed_occurrences, lane.last_native_rank])).toEqual([[2, 19], [2, 70], [1, 8], [2, 90]]);
    expect(result.stop).toBe("captured_pages_exhausted");
  });

  it("continues past the distinct-root ceiling and retains multiple duplicate-root hits", () => {
    const first: NativeRouteOccurrence = { ...occurrence("ol-a", "a", 3),
      hit: { status: "unavailable", reason: "lexical_byte_range_not_measured" } };
    const second: NativeRouteOccurrence = { ...occurrence("ov-a", "a", 27),
      window: { status: "captured", reference: "window-a", start: 504, end: 1008 } };
    const third: NativeRouteOccurrence = { ...occurrence("hv-a", "a", 61),
      window: { status: "captured", reference: "window-b", start: 1008, end: 1512 } };
    const result = drain(createNativeRouteNomination({ max_attempts: 9, max_roots: 1,
      lanes: lanes([[first], [second], [occurrence("hl-b", "b", 5)], [third]]) }));
    expect(result.trace.map(row => row.decision)).toEqual([
      "admitted_new_root", "admitted_duplicate", "nomination_limit", "admitted_duplicate"
    ]);
    expect(result.counts).toEqual({ attempts_consumed: 4, admitted_roots: 1, duplicate_occurrences: 2,
      denied: 0, nomination_limit: 1, unknown: 0, resource_refused_before_start: 0, resource_refused_after_start: 0 });
    expect(result.roots[0]!.occurrences.map(row => row.occurrence)).toEqual([first, second, third]);
    expect(result.stop).toBe("captured_pages_exhausted");
  });

  it("stops at the shared attempt ceiling without pulling the next captured occurrence", () => {
    const result = drain(createNativeRouteNomination({ max_attempts: 3, max_roots: 2, lanes: lanes([
      [occurrence("ol-a", "a", 2), occurrence("ol-unread", "z", 20)],
      [occurrence("ov-b", "b", 5)], [occurrence("hl-c", "c", 9)], [occurrence("hv-unread", "a", 40)]
    ]) }));
    expect(result.trace.map(row => row.pending.occurrence.reference)).toEqual(["ol-a", "ov-b", "hl-c"]);
    expect(result.trace.map(row => row.decision)).toEqual(["admitted_new_root", "admitted_new_root", "nomination_limit"]);
    expect(result.stop).toBe("attempt_limit");
    expect(result.lanes.map(lane => lane.remaining_captured_occurrences)).toEqual([1, 0, 0, 1]);
    expect(result.pending).toBeNull();
  });

  it("uses the same kernel at sixteen roots and at a caller-bounded larger ceiling", () => {
    const captured = lanes([Array.from({ length: 20 }, (_, index) => occurrence(`hit-${index}`, `root-${index}`, 2 * index + 1))]);
    const bounded = drain(createNativeRouteNomination({ lanes: captured, max_attempts: 20, max_roots: 16 }));
    const refill = drain(createNativeRouteNomination({ lanes: captured, max_attempts: 20, max_roots: 20 }));
    expect(bounded.roots.map(root => root.root_key)).toEqual([
      "root-0", "root-1", "root-2", "root-3", "root-4", "root-5", "root-6", "root-7",
      "root-8", "root-9", "root-10", "root-11", "root-12", "root-13", "root-14", "root-15"
    ]);
    expect(bounded.counts.nomination_limit).toBe(4);
    expect(refill.roots.map(root => root.root_key)).toEqual([
      "root-0", "root-1", "root-2", "root-3", "root-4", "root-5", "root-6", "root-7", "root-8", "root-9",
      "root-10", "root-11", "root-12", "root-13", "root-14", "root-15", "root-16", "root-17", "root-18", "root-19"
    ]);
    expect(bounded.counts.attempts_consumed).toBe(20);
    expect(refill.counts.attempts_consumed).toBe(20);
  });

  it("preserves absent, disabled, unavailable, measured-empty and exhausted capture distinctions", () => {
    const captured: NativeRouteLane[] = [
      { lane: "original-lexical", scope: "original", state: "absent" },
      { lane: "original-vector", scope: "original", state: "disabled" },
      { lane: "hint-lexical", scope: "hint", state: "unavailable", reason: "sql_failed" },
      { lane: "hint-vector", scope: "hint-subset", state: "measured-empty" }
    ];
    const result = drain(createNativeRouteNomination({ lanes: captured, max_attempts: 1, max_roots: 1 }));
    expect(result.lanes.map(row => row.state)).toEqual(["absent", "disabled", "unavailable", "measured-empty"]);
    expect(result.lanes[2]).toMatchObject({ reason: "sql_failed", consumed_occurrences: 0, last_native_rank: null });
    expect(result.trace).toEqual([]);
    expect(result.stop).toBe("captured_pages_exhausted");
    expect(result).not.toHaveProperty("corpus_exhausted");
  });

  it.each([
    [null, 0, "resource_refused_before_start", 0],
    ["native_admission", 1, "resource_refused_after_start", 1]
  ] as const)("records resource refusal at phase %s without inventing native debits", (phase, attempts, stop, consumed) => {
    const kernel = createNativeRouteNomination({ max_attempts: 2, max_roots: 2,
      lanes: lanes([[occurrence("first", "a", 7), occurrence("second", "b", 19)]]) });
    const next = kernel.next()!;
    expect(kernel.commit(next.ordinal, { status: "resource_refused", started_phase: phase, reason: "caller_budget" }))
      .toBe("resource_refused");
    expect(kernel.next()).toBeNull();
    const result = kernel.snapshot();
    expect(result.stop).toBe(stop);
    expect(result.counts.attempts_consumed).toBe(attempts);
    expect(result.lanes[0]!.consumed_occurrences).toBe(consumed);
    expect(result.trace[0]!.outcome).toEqual({ status: "resource_refused", started_phase: phase, reason: "caller_budget" });
    expect(result).not.toHaveProperty("resources");
    expect(result.roots).toEqual([]);
    expect(() => kernel.commit(next.ordinal, ADMITTED)).toThrow(/settled/u);
  });

  it("consumes denied opportunities and makes unknown admission terminal without hidden retry", () => {
    const kernel = createNativeRouteNomination({ max_attempts: 4, max_roots: 2, lanes: lanes([
      [occurrence("denied", "a", 3), occurrence("never-pulled", "c", 50)], [occurrence("unknown", "b", 8)]
    ]) });
    const denied = kernel.next()!;
    expect(kernel.commit(denied.ordinal, { status: "denied", started_phase: "scope_check", reason: "outside_scope" })).toBe("denied");
    const unknown = kernel.next()!;
    expect(unknown.occurrence.reference).toBe("unknown");
    expect(kernel.commit(unknown.ordinal, { status: "unknown", started_phase: "candidate_lookup", reason: "worker_lost" }))
      .toBe("admission_unknown");
    expect(kernel.next()).toBeNull();
    expect(kernel.next()).toBeNull();
    expect(kernel.snapshot()).toMatchObject({ stop: "admission_unknown", roots: [],
      counts: { attempts_consumed: 2, denied: 1, unknown: 1 } });
    expect(kernel.snapshot().trace.map(row => row.outcome.started_phase)).toEqual(["scope_check", "candidate_lookup"]);
  });

  it("keeps next idempotent and rejects stale, double and invalid commits without consuming pending work", () => {
    const kernel = createNativeRouteNomination({ max_attempts: 3, max_roots: 3,
      lanes: lanes([[occurrence("first", "a", 1)], [occurrence("second", "b", 4)]]) });
    const first = kernel.next()!;
    expect(kernel.next()).toBe(first);
    expect(() => kernel.commit(first.ordinal + 1, ADMITTED)).toThrow(/stale/u);
    expect(() => kernel.commit(first.ordinal, { status: "admitted", started_phase: "" })).toThrow(/phase/u);
    expect(kernel.next()).toBe(first);
    expect(kernel.snapshot().counts.attempts_consumed).toBe(0);
    kernel.commit(first.ordinal, ADMITTED);
    expect(() => kernel.commit(first.ordinal, ADMITTED)).toThrow(/settled/u);
    const second = kernel.next()!;
    expect(second.ordinal).toBe(2);
    expect(() => kernel.commit(first.ordinal, ADMITTED)).toThrow(/stale/u);
    expect(kernel.next()).toBe(second);
    kernel.commit(second.ordinal, ADMITTED);
    expect(kernel.next()).toBeNull();
  });

  it("copies before validation, isolates caller mutations and never freezes caller inputs", () => {
    const hit = { status: "captured" as const, reference: "byte-hit", start: 10, end: 20 };
    const row = { reference: "first", root_key: "a", native_rank: 7, hit };
    const captured = lanes([[row], [occurrence("second", "b", 15)]]);
    const input = { lanes: captured, max_attempts: 2, max_roots: 2 };
    const kernel = createNativeRouteNomination(input);
    row.reference = "changed"; row.root_key = "mutated"; row.native_rank = -1; hit.start = 999;
    input.max_attempts = 1; input.max_roots = 1; captured.reverse();
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(row)).toBe(false);
    expect(Object.isFrozen(hit)).toBe(false);
    const first = kernel.next()!;
    expect(first.occurrence).toEqual({ reference: "first", root_key: "a", native_rank: 7,
      hit: { status: "captured", reference: "byte-hit", start: 10, end: 20 } });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.occurrence.hit)).toBe(true);
    const admission: { status: "denied"; started_phase: string; reason: string } = {
      status: "denied", started_phase: "scope_check", reason: "outside_scope"
    };
    kernel.commit(first.ordinal, admission); admission.reason = "changed";
    const snapshot = kernel.snapshot(); snapshot.counts.attempts_consumed = 200;
    const result = drain(kernel);
    expect(result.trace[0]!.outcome).toEqual({ status: "denied", started_phase: "scope_check", reason: "outside_scope" });
    expect(result.counts.attempts_consumed).toBe(2);
    expect(result.roots.map(root => root.root_key)).toEqual(["b"]);
  });

  it.each([
    [0, 1], [2, 0], [2, 3], [2.5, 1], [Infinity, 1], [3, NaN], [Number.MAX_SAFE_INTEGER + 1, 1]
  ])("rejects invalid finite integer ceiling relationships %s/%s", (max_attempts, max_roots) => {
    expect(() => createNativeRouteNomination({ lanes: lanes([]), max_attempts, max_roots })).toThrow(/ceilings/u);
  });

  it("rejects falsely ordered, renumbered or ambiguous captures rather than repairing them", () => {
    const input = { max_attempts: 4, max_roots: 4, lanes: lanes([[occurrence("a", "a", 9), occurrence("b", "b", 3)]]) };
    expect(() => createNativeRouteNomination(input)).toThrow(/ranks/u);
    expect(() => createNativeRouteNomination({ ...input, lanes: lanes([[occurrence("same", "a", 2)], [occurrence("same", "b", 4)]]) }))
      .toThrow(/reference/u);
    expect(() => createNativeRouteNomination({ ...input, lanes: lanes([]).reverse() })).toThrow(/order/u);
    expect(() => createNativeRouteNomination({ ...input, lanes: lanes([[occurrence("zero", "a", 0)]]) })).toThrow(/ranks/u);
  });

  it("preserves non-tied decisions under opaque identity renaming", () => {
    const run = (a: string, b: string) => {
      const kernel = createNativeRouteNomination({ max_attempts: 4, max_roots: 1,
        lanes: lanes([[occurrence("one", a, 6), occurrence("three", a, 88)], [occurrence("two", b, 12)]]) });
      return drain(kernel).trace.map(row => [row.pending.lane, row.pending.occurrence.native_rank, row.decision]);
    };
    expect(run("z-root", "a-root")).toEqual([
      ["original-lexical", 6, "admitted_new_root"], ["original-vector", 12, "nomination_limit"],
      ["original-lexical", 88, "admitted_duplicate"]
    ]);
    expect(run("a-renamed", "z-renamed")).toEqual(run("z-root", "a-root"));
  });
});
