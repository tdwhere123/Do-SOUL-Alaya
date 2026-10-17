import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => { isolation.restore(); });
import { SourceSemanticResourceLedger, SourceSemanticResourceExhausted } from "@do-soul/alaya-protocol";
import { captureSourcePhaseFixture } from "../../../../../../packages/protocol/src/__tests__/garden/source-semantic-canonical.test-support.js";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { quoteAccessPoolIdentity, bindAccessPoolIdentity, sourceSemanticAccessReceiptValue }
  from "../../../runtime/recall-read-worker/source-semantic-access-receipts.js";
import * as receipts from "../../../runtime/recall-read-worker/source-semantic-access-receipts.js";
import { SourceSemanticUnionCompletion } from "../../../runtime/recall-read-worker/source-semantic-empty-population-budget.js";
import type { SourceSemanticReadRuntime } from "../../../runtime/recall-read-worker/runtime.js";

const AMPLE = { work_units: 1_000_000, memory_bytes: 4_000_000 };
const WIDE = "x".repeat(32), ID = `sha256:${"0".repeat(64)}`;
class Charges extends SourceSemanticReadBudget {
  readonly rows: { phase?: string; work: number; bytes: number }[] = [];
  override charge(work: number, bytes: number, phase?: string) {
    super.charge(work, bytes, phase); this.rows.push({ phase, work, bytes });
  }
  bytesFor(phase: string) { return this.rows.filter(row => row.phase === phase).reduce((sum, row) => sum + row.bytes, 0); }
}
function host() {
  let revision = 1;
  // No SQLite handle is opened. These are only the two identity-revision readers.
  const runtime = { database: { connection: {
    pragma: () => revision, prepare: () => ({ get: () => ({ n: revision }) })
  } } } as unknown as SourceSemanticReadRuntime;
  return { runtime, changeRevision() { revision++; } };
}
function identityCaptures(pair: ReturnType<typeof captureSourcePhaseFixture>) {
  return { borrowPreparation: pair.borrowPreparation, acquisitionCapture: pair.acquisition };
}
function receipt(pair: ReturnType<typeof captureSourcePhaseFixture>, wide = false,
  observation: readonly [number, number, number] = [1, 2, 3]) {
  return sourceSemanticAccessReceiptValue(new Charges(AMPLE), "query-conditioned-v1", ID,
    [{ source_id: "raw", record_id: `sha256:${"d".repeat(64)}`, read_bytes: wide ? WIDE : 27,
      body_bytes: wide ? WIDE : 27, complete: wide ? WIDE : true,
      signal: { source_text_score: wide ? WIDE : 0, interpretation_reading_score: wide ? WIDE : 0 } }], [],
    wide ? WIDE : false, wide ? WIDE : false, wide ? ["budget", "source_limit", "interpretation_limit", "unavailable", "source_tail"] : [],
    undefined, { preparation: pair.phases[1], acquisition: pair.phases[2], observation });
}

it("removes only the two phase expansions and repeated structure, preserving exact encoding/hash handoffs", () => {
  const pair = captureSourcePhaseFixture(new Charges(AMPLE)), { runtime } = host(), planning = new Charges(AMPLE);
  const quote = quoteAccessPoolIdentity(runtime, "workspace-1", ["project"], receipt(pair, true), planning, identityCaptures(pair));
  const ordinary = new Charges(AMPLE), actual = new Charges(AMPLE), value = receipt(pair);
  const expected = bindAccessPoolIdentity(runtime, "workspace-1", ["project"], value, ordinary);
  const bound = bindAccessPoolIdentity(runtime, "workspace-1", ["project"], value, actual, quote.prepared);
  expect(bound).toEqual(expected);
  expect(bound.phases[1]).toBe(pair.phases[1]); expect(bound.phases[2]).toBe(pair.phases[2]);
  expect(Array.isArray(bound.phases[1])).toBe(true);
  expect(ordinary.bytesFor("source phase preparation expansion traversal")).toBe(824);
  expect(ordinary.bytesFor("source phase expanded preparation allocation")).toBe(3144);
  expect(ordinary.bytesFor("source phase acquisition expansion traversal")).toBe(2432);
  expect(ordinary.bytesFor("source phase expanded acquisition allocation")).toBe(15008);
  for (const phase of ["source phase preparation expansion traversal", "source phase expanded preparation allocation",
    "source phase acquisition expansion traversal", "source phase expanded acquisition allocation"]) {
    expect(planning.bytesFor(phase)).toBe(0); expect(actual.bytesFor(phase)).toBe(0);
  }
  expect(ordinary.spentBytes - actual.spentBytes).toBe(21408 + 22592 - 128);
  expect(actual.bytesFor("canonical prepared replay frame")).toBe(128);
  expect(actual.bytesFor("canonical identity scalar encoding")).toBe(ordinary.bytesFor("canonical identity scalar encoding"));
  expect(actual.bytesFor("canonical identity hash handoff")).toBe(ordinary.bytesFor("canonical identity hash handoff"));
  expect(planning.bytesFor("canonical identity scalar encoding")).toBe(0);
  expect(planning.bytesFor("canonical identity hash handoff")).toBe(0);
  expect(actual.spentBytes).toBeLessThanOrEqual(quote.memory_bytes);
  expect(() => [...quote.prepared.chunks({}, actual)]).toThrow(/closed/u);
});

it("uses fresh observation accounting, rows and revision rather than freezing the quoted receipt", () => {
  const pair = captureSourcePhaseFixture(new Charges(AMPLE)), state = host();
  const quote = quoteAccessPoolIdentity(state.runtime, "workspace-1", ["project"], receipt(pair, true), new Charges(AMPLE), identityCaptures(pair));
  state.changeRevision();
  const value = receipt(pair, false, [11, 22, 33]);
  const expected = bindAccessPoolIdentity(state.runtime, "workspace-1", ["project"], value, new Charges(AMPLE));
  const actual = bindAccessPoolIdentity(state.runtime, "workspace-1", ["project"], value, new Charges(AMPLE), quote.prepared);
  expect(actual.pool_id).toBe(expected.pool_id);
  expect(actual.phases[3]).toEqual([11, 22, 33]);
  expect(actual.pool_id).not.toBe(bindAccessPoolIdentity(state.runtime, "workspace-1", ["project"], receipt(pair), new Charges(AMPLE)).pool_id);
});

it("spends exact prepared execution/hash prices and refuses adjacent work or bytes", () => {
  const pair = captureSourcePhaseFixture(new Charges(AMPLE)), { runtime } = host(), value = receipt(pair);
  const planning = new Charges(AMPLE), owners = identityCaptures(pair);
  const ample = quoteAccessPoolIdentity(runtime, "workspace-1", ["project"], value, planning, owners);
  const exact = { work_units: ample.work_units, memory_bytes: ample.memory_bytes }, actual = new Charges(exact);
  // A wrapper replacement after quotation cannot become a new capture/preimage.
  owners.acquisitionCapture = { ...pair.acquisition, reason: "not the captured tree" };
  const expected = bindAccessPoolIdentity(runtime, "workspace-1", ["project"], value, new Charges(AMPLE));
  expect(bindAccessPoolIdentity(runtime, "workspace-1", ["project"], value, actual, ample.prepared)).toEqual(expected);
  expect(actual.remaining()).toEqual({ work_units: 0, memory_bytes: 0 });
  for (const allowance of [{ ...exact, work_units: exact.work_units - 1 }, { ...exact, memory_bytes: exact.memory_bytes - 1 }]) {
    const quote = quoteAccessPoolIdentity(runtime, "workspace-1", ["project"], value, new Charges(AMPLE), identityCaptures(pair));
    const limited = new Charges(allowance);
    expect(() => bindAccessPoolIdentity(runtime, "workspace-1", ["project"], value, limited, quote.prepared))
      .toThrow(SourceSemanticResourceExhausted);
    expect(limited.spentBytes).toBeLessThanOrEqual(allowance.memory_bytes);
    expect(limited.spentWork).toBeLessThanOrEqual(allowance.work_units);
    expect(() => [...quote.prepared.chunks(value, new Charges(AMPLE))]).toThrow(/closed/u);
  }
});

it("rejects replaced references and closes the request plan on binding failure without refunding expenditure", () => {
  const pair = captureSourcePhaseFixture(new Charges(AMPLE)), { runtime } = host();
  const quote = quoteAccessPoolIdentity(runtime, "workspace-1", ["project"], receipt(pair, true), new Charges(AMPLE), identityCaptures(pair));
  const value = receipt(pair), meter = new Charges(AMPLE);
  expect(() => bindAccessPoolIdentity(runtime, "workspace-1", ["project"], {
    ...value, phases: [2, structuredClone(pair.phases[1]), pair.phases[2], null] }, meter, quote.prepared)).toThrow(/binding changed/u);
  expect(meter.spentWork).toBeGreaterThan(0);
  expect(() => quote.prepared.accessPhases(value, meter)).toThrow(/closed/u);
  const retry = quoteAccessPoolIdentity(runtime, "workspace-1", ["project"], receipt(pair, true), new Charges(AMPLE), identityCaptures(pair));
  const limited = new Charges({ ...AMPLE, memory_bytes: 2000 });
  expect(() => bindAccessPoolIdentity(runtime, "workspace-1", ["project"], value, limited, retry.prepared))
    .toThrow(SourceSemanticResourceExhausted);
  expect(limited.spentBytes).toBeGreaterThan(0);
  expect(() => [...retry.prepared.chunks(value, new Charges(AMPLE))]).toThrow(/closed/u);
});

it("retires a fully quoted plan when the adjacent completion hold cannot fit, keeping planner spend", () => {
  const pair = captureSourcePhaseFixture(new Charges(AMPLE)), { runtime } = host();
  const quotes = vi.spyOn(receipts, "quoteAccessPoolIdentity");
  const attempt = (bytes: number) => {
    const parent = new Charges({ ...AMPLE, memory_bytes: bytes }), child = new Charges(AMPLE), holds = vi.spyOn(parent, "hold");
    child.charge(107, 229, "prior observation");
    const orderCost = () => ({ work_units: 0, memory_bytes: 0 }), owner = new SourceSemanticUnionCompletion(parent, child, orderCost);
    const input = { runtime, parent, child, records: [], sourcePages: 1, policy: "query-conditioned-v1" as const,
      budget: { schema_version: 1 as const, ...AMPLE, page_budget: 100000, finalization_reserve: 10000, min_envelope: 10 }, orderCost,
      leaseContext: { workspace_id: "workspace-1", principal: "", authorized: ["project"], as_of: "2026-09-18T00:00:00.000Z",
        expires_at: "2026-09-18T00:10:00.000Z", revision: "1:1", original_query: "Why delayed" },
      phases: { preparation: pair.phases[1], acquisition: pair.phases[2] }, ...identityCaptures(pair) };
    let required = 0, error: unknown;
    const quoteIndex = quotes.mock.results.length;
    try {
      owner.preparationBase(input);
      const prepared = owner.emptyCompletion(input);
      required = parent.spentBytes + child.spentBytes + holds.mock.calls.reduce((sum, [cost]) => sum + cost.memory_bytes, 0);
      prepared?.close();
    } catch (caught) { error = caught; }
    finally { owner.release(); }
    const quoted = quotes.mock.results[quoteIndex];
    return { required, error, parent, prepared: quoted?.type === "return" ? quoted.value.prepared : undefined };
  };
  const ample = attempt(AMPLE.memory_bytes);
  expect(ample.error).toBeUndefined();
  const exact = attempt(ample.required);
  expect(exact.error).toBeUndefined(); expect(exact.required).toBe(ample.required);
  const short = attempt(ample.required - 1);
  expect(short.error).toBeInstanceOf(SourceSemanticResourceExhausted);
  expect(short.prepared).toBeDefined();
  expect(short.parent.spentBytes).toBe(exact.parent.spentBytes);
  expect(short.parent.outstandingAllowance()).toEqual({ work_units: short.parent.spentWork, memory_bytes: short.parent.spentBytes });
  expect(() => short.prepared!.accessPhases(receipt(pair), new Charges(AMPLE))).toThrow(/closed/u);
});

it("keeps the sealed plan through completion-hold release and stores only numeric obligations on the ledger", () => {
  const pair = captureSourcePhaseFixture(new Charges(AMPLE)), { runtime } = host();
  const parent = new Charges(AMPLE), child = new Charges(AMPLE), hold = vi.spyOn(parent, "hold");
  const debits = vi.spyOn(SourceSemanticResourceLedger.prototype, "charge"), absorbed = vi.spyOn(parent, "absorb");
  child.charge(107, 229, "prior observation");
  const orderCost = () => ({ work_units: 0, memory_bytes: 0 });
  const owner = new SourceSemanticUnionCompletion(parent, child, orderCost);
  const input = { runtime, parent, child, records: [], sourcePages: 1, policy: "query-conditioned-v1" as const,
    budget: { schema_version: 1 as const, ...AMPLE, page_budget: 100000, finalization_reserve: 10000, min_envelope: 10 }, orderCost,
    leaseContext: { workspace_id: "workspace-1", principal: "", authorized: ["project"], as_of: "2026-09-18T00:00:00.000Z",
      expires_at: "2026-09-18T00:10:00.000Z", revision: "1:1", original_query: "Why delayed" },
    phases: { preparation: pair.phases[1], acquisition: pair.phases[2] },
    borrowPreparation: pair.borrowPreparation, acquisitionCapture: pair.acquisition };
  try {
    owner.preparationBase(input);
    const before = parent.spentBytes, prepared = owner.emptyCompletion(input);
    const planning = absorbed.mock.calls.at(-1)![0];
    const plannerBytes = (phase: string) => debits.mock.calls.reduce((sum, [, bytes, reason], index) =>
      sum + (debits.mock.contexts[index] === planning && reason === phase ? bytes : 0), 0);
    expect(parent.spentBytes - before).toBe(planning.spentBytes);
    expect(prepared).toBeDefined();
    expect(parent.outstandingAllowance()).toEqual({ work_units: parent.spentWork, memory_bytes: parent.spentBytes });
    expect(hold.mock.calls.every(([cost]) => !Object.hasOwn(cost, "prepared"))).toBe(true);
    expect(plannerBytes("source identity completion numeric hold record")).toBe(128);
    const value = receipt(pair);
    expect(bindAccessPoolIdentity(runtime, "workspace-1", ["project"], value, new Charges(AMPLE), prepared).pool_id)
      .toBe(bindAccessPoolIdentity(runtime, "workspace-1", ["project"], value, new Charges(AMPLE)).pool_id);
    expect(plannerBytes("canonical prepared opcode block")).toBe(4 * 472);
    expect(plannerBytes("canonical prepared scalar block")).toBe(4 * 1096);
  } finally { owner.release(); pair.retire(); }
});
