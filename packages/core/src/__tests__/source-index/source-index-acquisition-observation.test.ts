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
  return { facts, observer: (capture: () => SourceIndexAcquisitionFact) => { facts.push(capture()); } };
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
    for (const fact of facts) {
      if (fact.kind === "vector_inspected") expect("rank" in fact).toBe(false);
      if (fact.kind === "vector_ranked") expect(fact.rank).toBeGreaterThan(0);
    }
    expectMetadataOnly(on, AXIS_ROOTS.map(root => root.body));
  });

  it("does not construct payloads unless capture runs, and observer failure cannot change output", () => {
    const environment = setup();
    publishIndex(environment);
    const input = queryInput();
    const off = query(environment, input, admitScope);
    let constructed = 0;
    const skipped = query(environment, input, admitScope, capture => { expect(typeof capture).toBe("function"); });
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
      expect({ ...admitted.target, root_id: "mutated" }.root_id).toBe("mutated");
      expect(on.nominations[0]?.source.target.root_id).not.toBe("mutated");
    }
  });
});
