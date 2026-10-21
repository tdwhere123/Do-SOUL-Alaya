import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import(
    "../../../../../apps/bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => { isolation.restore(); });
import { SourceSemanticResourceExhausted, SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";
import type { SourceIndexAcquisitionFact } from "../../source-index/source-index-acquisition.js";
import { fixture, type Fixture } from "../../../../storage/src/__tests__/repos/source-index/source-index-fixture.js";
import {
  AXIS_ROOTS, admitScope, expectBounded, expectMetadataOnly, publishIndex, query, queryInput
} from "./source-index-acquisition-fixture.js";

const environments: Fixture[] = [];
afterEach(() => {
  expect(isolation.violations).toEqual([]);
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

  it("does not publish vector ranks when later rank retention refuses after at least one real meter charge", () => {
    const environment = setup();
    publishIndex(environment);
    const input = queryInput();
    const charge = SourceSemanticResourceLedger.prototype.charge;
    const spentAfterRetention: number[] = [];
    const spy = vi.spyOn(SourceSemanticResourceLedger.prototype, "charge").mockImplementation(
      function (this: SourceSemanticResourceLedger, work, bytes, phase) {
        charge.call(this, work, bytes, phase);
        if (phase === "source vector rank retention") spentAfterRetention.push(this.spentWork);
      });
    query(environment, input, admitScope);
    spy.mockRestore();
    expect(spentAfterRetention.length).toBeGreaterThanOrEqual(2);
    const limitedInput = { ...input, budget: { ...input.budget, work_units: spentAfterRetention[0]! } };
    const off = query(environment, limitedInput, admitScope);
    const { facts, observer } = collect();
    const on = query(environment, limitedInput, admitScope, observer);
    expect(on).toEqual(off);
    expect(on.resources).toEqual(off.resources);
    expect(facts.filter(fact => fact.kind === "vector_ranked")).toEqual([]);
    expect(on.vector.completion).toBe("partial");
    expect(on.resource_refusals.some(row => row.stage === "vector" && row.phase === "source vector rank retention")).toBe(true);
    expect(on.nominations.every(row => row.vector === null)).toBe(true);
    expectBounded(on, limitedInput);
    expectMetadataOnly(on, AXIS_ROOTS.map(root => root.body));
  });

  it("does not publish vector ranks when rank retention throws a non-resource error after the first charge", () => {
    const environment = setup();
    publishIndex(environment);
    const input = queryInput();
    const charge = SourceSemanticResourceLedger.prototype.charge;
    let retentions = 0;
    vi.spyOn(SourceSemanticResourceLedger.prototype, "charge").mockImplementation(
      function (this: SourceSemanticResourceLedger, work, bytes, phase) {
        if (phase === "source vector rank retention" && ++retentions > 1) {
          throw new Error("rank retention interrupted");
        }
        return charge.call(this, work, bytes, phase);
      });
    const off = query(environment, input, admitScope);
    retentions = 0;
    const { facts, observer } = collect();
    const on = query(environment, input, admitScope, observer);
    expect(on).toEqual(off);
    expect(facts.filter(fact => fact.kind === "vector_ranked")).toEqual([]);
    expect(on.resource_refusals).toEqual(expect.arrayContaining([
      { stage: "vector", phase: "acquisition_failed_unknown_additional_cost" }]));
    expect(on.nominations.every(row => row.vector === null)).toBe(true);
    expectBounded(on, input);
  });

  it("preserves native partial and unbound admission reasons on attempt facts without collapsing receipts", () => {
    const environment = setup();
    publishIndex(environment);
    const input = queryInput();
    const admit = environment.index.admitQueryCandidate.bind(environment.index);
    vi.spyOn(environment.index, "admitQueryCandidate").mockImplementation((source, binding, budget) => {
      if (binding !== null) {
        return admit(source, { ...binding, generation_id: `sha256:${"00".repeat(32)}` }, budget);
      }
      const native = admit(source, binding, budget);
      if (native.status !== "ready") return native;
      return { status: "partial", reason: "native_source_unavailable", resources: native.resources };
    });
    const off = query(environment, input, admitScope);
    const { facts, observer } = collect();
    const on = query(environment, input, admitScope, observer);
    expect(on).toEqual(off);
    expect(on.accounting.native_unknown).toBeGreaterThan(0);
    expect(on.accounting.stale).toBe(0);
    const attempts = facts.filter(fact => fact.kind === "nomination_attempt");
    expect(attempts.some(fact => fact.kind === "nomination_attempt" && fact.channel === "lexical"
      && fact.disposition === "native_unknown" && fact.admission?.status === "partial"
      && fact.admission.reason === "native_source_unavailable")).toBe(true);
    expect(attempts.some(fact => fact.kind === "nomination_attempt" && fact.channel === "vector"
      && fact.disposition === "native_unknown" && fact.admission?.status === "unbound")).toBe(true);
    expectBounded(on, input);
  });

  it("preserves stale and resource_limited native admission phases on successive attempt facts", () => {
    const environment = setup();
    publishIndex(environment);
    const input = queryInput();
    const admit = environment.index.admitQueryCandidate.bind(environment.index);
    let ready = 0;
    vi.spyOn(environment.index, "admitQueryCandidate").mockImplementation((source, binding, budget) => {
      const native = admit(source, binding, budget);
      if (native.status !== "ready") return native;
      ready++;
      if (ready === 1) return { status: "stale", reason: "target_identity", resources: native.resources };
      return { status: "resource_limited", reason: "read_budget", phase: "source currentness and erase guard",
        resources: native.resources };
    });
    const off = query(environment, input, admitScope);
    ready = 0;
    const { facts, observer } = collect();
    const on = query(environment, input, admitScope, observer);
    expect(on).toEqual(off);
    const attempts = facts.filter(fact => fact.kind === "nomination_attempt");
    expect(attempts.some(fact => fact.kind === "nomination_attempt" && fact.disposition === "stale"
      && fact.admission?.status === "stale" && fact.admission.reason === "target_identity"
      && !("phase" in fact.admission))).toBe(true);
    expect(attempts.some(fact => fact.kind === "nomination_attempt" && fact.disposition === "resource_refused"
      && fact.admission?.status === "resource_limited" && fact.admission.reason === "read_budget"
      && fact.admission.phase === "source currentness and erase guard"
      && fact.resource_refusal?.stage === "admission"
      && fact.resource_refusal.phase === "source currentness and erase guard")).toBe(true);
    expect(on.resource_refusals).toEqual([{ stage: "admission", phase: "source currentness and erase guard" }]);
    expect(attempts.filter(fact => fact.kind === "nomination_attempt" && fact.admission !== undefined))
      .toHaveLength(attempts.filter(fact => fact.kind === "nomination_attempt"
        && (fact.disposition === "stale" || fact.disposition === "resource_refused")).length);
    expectBounded(on, input);
  });

  it("does not invent native admission when the owner throws or is not called", () => {
    const environment = setup();
    publishIndex(environment);
    const input = queryInput();
    vi.spyOn(environment.index, "admitQueryCandidate").mockImplementation(() => {
      throw new SourceSemanticResourceExhausted("source currentness and erase guard");
    });
    const thrownOff = query(environment, input, admitScope);
    const thrown = collect();
    const thrownOn = query(environment, input, admitScope, thrown.observer);
    expect(thrownOn).toEqual(thrownOff);
    const thrownAttempts = thrown.facts.filter(fact => fact.kind === "nomination_attempt");
    expect(thrownAttempts.some(fact => fact.kind === "nomination_attempt" && fact.disposition === "resource_refused"
      && fact.admission === undefined && fact.resource_refusal?.stage === "admission"
      && fact.resource_refusal.phase === "source currentness and erase guard")).toBe(true);
    expect(thrownAttempts.every(fact => fact.kind !== "nomination_attempt" || fact.admission === undefined)).toBe(true);
    vi.restoreAllMocks();
    const charge = SourceSemanticResourceLedger.prototype.charge;
    vi.spyOn(SourceSemanticResourceLedger.prototype, "charge").mockImplementation(
      function (this: SourceSemanticResourceLedger, work, bytes, phase) {
        if (phase === "source nomination attempt") throw new SourceSemanticResourceExhausted(phase);
        return charge.call(this, work, bytes, phase);
      });
    const skippedOff = query(environment, input, admitScope);
    const skipped = collect();
    const skippedOn = query(environment, input, admitScope, skipped.observer);
    expect(skippedOn).toEqual(skippedOff);
    expect(skipped.facts.filter(fact => fact.kind === "nomination_attempt")).toEqual([]);
    expect(skippedOn.resource_refusals.some(row => row.stage === "nomination"
      && row.phase === "source nomination attempt")).toBe(true);
    expectBounded(skippedOn, input);
  });

  it("records the retained gold-root merge target on duplicate attempts without inventing admission", () => {
    const environment = setup();
    publishIndex(environment);
    const { facts, observer } = collect();
    const on = query(environment, queryInput(), admitScope, observer);
    const duplicates = facts.filter(fact => fact.kind === "nomination_attempt" && fact.disposition === "duplicate");
    expect(duplicates.length).toBeGreaterThan(0);
    for (const fact of duplicates) {
      expect(fact.kind).toBe("nomination_attempt");
      if (fact.kind !== "nomination_attempt") continue;
      expect(fact.merge_target).toEqual(fact.target);
      expect(fact.admission).toBeUndefined();
    }
    expect(facts.some(fact => fact.kind === "nomination_attempt" && fact.disposition === "admitted"
      && fact.merge_target === undefined)).toBe(true);
    expect(on.accounting.duplicate).toBe(duplicates.length);
  });
});
