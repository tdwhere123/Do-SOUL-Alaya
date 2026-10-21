import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceIndexAcquisitionFact } from "../../source-index/source-index-acquisition.js";
import { fixture, type Fixture } from "../../../../storage/src/__tests__/repos/source-index/source-index-fixture.js";
import {
  AXIS_ROOTS, admitScope, expectBounded, expectMetadataOnly, publishIndex, query, queryInput
} from "./source-index-acquisition-fixture.js";

const environments: Fixture[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const environment of environments.splice(0)) environment.database.close();
});
function setup() {
  const environment = fixture();
  environments.push(environment);
  return environment;
}
function collect() {
  const facts: SourceIndexAcquisitionFact[] = [];
  return { facts, observer: (capture: () => SourceIndexAcquisitionFact, kind: SourceIndexAcquisitionFact["kind"]) => {
    const fact = capture();
    expect(fact.kind).toBe(kind);
    facts.push(fact);
  } };
}

describe("source index acquisition observation through native SQLite", () => {
  it("preserves receipts and budget while emitting admitted, duplicate and nomination_limit facts before loss", () => {
    const environment = setup();
    publishIndex(environment);
    const input = queryInput();
    const off = query(environment, input, admitScope);
    expectBounded(off, input);
    const { facts, observer } = collect();
    const on = query(environment, input, admitScope, observer);
    expect(on).toEqual(off);
    expect(on.resources).toEqual(off.resources);
    expect(facts.some(fact => fact.kind === "nomination_attempt" && fact.disposition === "admitted")).toBe(true);
    expect(facts.some(fact => fact.kind === "nomination_attempt" && fact.disposition === "duplicate")).toBe(true);
    const limitedInput = { ...queryInput(), allowance: { max_attempts: 3, max_roots: 1, max_vector_windows: 64 } };
    const limitedOff = query(environment, limitedInput, admitScope);
    const limited = collect();
    const limitedOn = query(environment, limitedInput, admitScope, limited.observer);
    expect(limitedOn).toEqual(limitedOff);
    expect(limitedOn.accounting.nomination_limit).toBeGreaterThan(0);
    expect(limited.facts.some(fact => fact.kind === "nomination_attempt" && fact.disposition === "nomination_limit")).toBe(true);
    expect(limited.facts.some(fact => fact.kind === "lexical_candidate" && "start_byte" in fact)).toBe(false);
    expect(limited.facts.some(fact => "remaining" in fact || "global_rank" in fact || "fused_score" in fact)).toBe(false);
    expect(facts.filter(fact => fact.kind === "vector_inspected")).toHaveLength(7);
    const ranked = facts.filter(fact => fact.kind === "vector_ranked");
    expect(ranked).toHaveLength(5);
    expect(new Set(ranked.map(fact => fact.target.root_id)).size).toBe(5);
    expect(ranked[0]).toMatchObject({ cosine: 1, rank: 1, window: { start_byte: 0, end_byte: 8 } });
    for (const fact of facts) {
      if (fact.kind === "vector_inspected") expect("rank" in fact).toBe(false);
      if (fact.kind === "vector_ranked") expect(fact.rank).toBeGreaterThan(0);
    }
    expectMetadataOnly(on, AXIS_ROOTS.map(root => root.body));
  });

  it("counts inspected SQLite windows without constructing their discarded payloads", () => {
    const environment = setup();
    publishIndex(environment);
    const input = queryInput(), off = query(environment, input, admitScope);
    const clone = vi.spyOn(globalThis, "structuredClone");
    let inspected = 0;
    const on = query(environment, input, admitScope, (capture, kind) => {
      if (kind === "vector_inspected") inspected++;
      else capture();
    });
    expect(on).toEqual(off);
    expect(inspected).toBe(7);
    // Only the five finalized best-per-root windows are copied, not seven inspections.
    expect(clone.mock.calls.filter(([value]) => value !== null && typeof value === "object" && "window_id" in value))
      .toHaveLength(5);
  });

  it("does not construct payloads unless capture runs, and observer failure cannot change output", () => {
    const environment = setup();
    publishIndex(environment);
    const input = queryInput();
    const clone = vi.spyOn(globalThis, "structuredClone");
    const off = query(environment, input, admitScope);
    const observationClones = () => clone.mock.calls.filter(([value]) => value !== null && typeof value === "object"
      && ("kind" in value && value.kind === "source_evidence" || "window_id" in value));
    expect(observationClones()).toEqual([]);
    let constructed = 0;
    const skipped = query(environment, input, admitScope, capture => { expect(typeof capture).toBe("function"); });
    expect(observationClones()).toEqual([]);
    const counted = query(environment, input, admitScope, capture => { constructed++; capture(); });
    const failed = query(environment, input, admitScope, () => { throw new Error("observer must not affect acquisition"); });
    expect(skipped).toEqual(off);
    expect(counted).toEqual(off);
    expect(failed).toEqual(off);
    expect(constructed).toBeGreaterThan(0);
    const { facts, observer } = collect();
    const on = query(environment, input, admitScope, observer);
    const admitted = facts.find(fact => fact.kind === "nomination_attempt" && fact.disposition === "admitted");
    expect(admitted?.kind).toBe("nomination_attempt");
    if (admitted?.kind === "nomination_attempt") {
      expect(admitted.target).not.toBe(on.nominations[0]?.source.target);
      Object.assign(admitted.target, { root_id: "mutated" });
      expect(admitted.target.root_id).toBe("mutated");
      expect(on.nominations[0]?.source.target.root_id).not.toBe("mutated");
    }
  });
});
