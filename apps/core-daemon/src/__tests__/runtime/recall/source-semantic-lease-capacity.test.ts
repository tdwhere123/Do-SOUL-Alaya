import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => { isolation.restore(); });
import { captureSourceSemanticQueryPreparation, packSourceSemanticQueryPreparation, packSourceSemanticAcquisition,
  sourceSemanticAcquisitionNotRun, unavailableSourceQueryPreparation, SourceSemanticResourceExhausted,
  type SourceSemanticResourceBudget } from "@do-soul/alaya-protocol";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { sourceSemanticAccessReceiptValue } from "../../../runtime/recall-read-worker/source-semantic-access-receipts.js";
import { issueSemanticLeaseGroup, preflightSemanticLeaseGroup, readSemanticLease, sourceSemanticRevision,
  type SourceSemanticLease } from "../../../runtime/recall-read-worker/source-semantic-leases.js";
import type { RecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { CLOCK, WS, withIndexedSources } from "./source-semantic-index-acquisition.test-support.js";

const AMPLE = { work_units: 4_000_000, memory_bytes: 64_000_000 };
const DIGEST = `sha256:${"a".repeat(64)}`;
const caller = { workspace_id: WS, principal: "", as_of: CLOCK };

function ownedLease(runtime: RecallReadWorkerRuntime, reason: string) {
  const meter = new SourceSemanticReadBudget(AMPLE);
  const input = { ...unavailableSourceQueryPreparation(reason, "unavailable"), elapsed_ms: 0.5 };
  const preparation = packSourceSemanticQueryPreparation(captureSourceSemanticQueryPreparation(input, meter), meter);
  const acquisition = packSourceSemanticAcquisition(sourceSemanticAcquisitionNotRun("not_observed"), meter);
  const receipt = sourceSemanticAccessReceiptValue(meter, "query-conditioned-v1", DIGEST, [], [], false, false, [],
    undefined, { preparation, acquisition, observation: null });
  const lease: SourceSemanticLease = { ...caller, kind: "query", authorized: ["project"],
    expires_at: "2026-09-18T00:10:00.000Z", revision: sourceSemanticRevision(runtime),
    access_pool: { sources: [], descriptors: [], access: { ...receipt, pool_id: DIGEST }, sourcePages: 1, interpretationPages: 1 } };
  return { lease, input, preparation, acquisition };
}

// Independent expectations from the ledger's documented logical node/slot costs,
// not a measurement or quote produced by the execution being checked.
function expectedCost(value: unknown, borrowed: readonly object[] = [], sizing = false): SourceSemanticResourceBudget {
  if (!sizing && value !== null && typeof value === "object" && borrowed.includes(value)) {
    return { work_units: 1, memory_bytes: 8 };
  }
  const object = value !== null && typeof value === "object", array = Array.isArray(value);
  const entries = object ? Object.entries(value) : [];
  const children = entries.map(([, child]) => expectedCost(child, borrowed, sizing));
  return {
    work_units: 1 + (sizing ? typeof value === "string" || typeof value === "number" ? 1 : 0 : 0)
      + (sizing && object && !array ? entries.length : 0) + children.reduce((sum, child) => sum + child.work_units, 0),
    memory_bytes: (sizing ? typeof value === "number" && !Number.isSafeInteger(value) ? 88 : 0 : typeof value === "string" ? 24 + 4 * value.length : 64)
      + (!sizing && object ? array ? entries.length * 8 : entries.reduce((sum, [key]) => sum + 24 + 4 * key.length, 0) : 0)
      + children.reduce((sum, child) => sum + child.memory_bytes, 0)
  };
}
function plus(left: SourceSemanticResourceBudget, right: SourceSemanticResourceBudget): SourceSemanticResourceBudget {
  return { work_units: left.work_units + right.work_units, memory_bytes: left.memory_bytes + right.memory_bytes };
}
function inventory(runtime: RecallReadWorkerRuntime) {
  const lease: SourceSemanticLease = { ...caller, kind: "query", authorized: ["project"],
    expires_at: "2026-09-18T00:10:00.000Z", revision: sourceSemanticRevision(runtime) };
  issueSemanticLeaseGroup(runtime, Array.from({ length: 32 }, (_, index) => ({ issuedId: `older-${index}`, lease })),
    new SourceSemanticReadBudget(AMPLE));
}
function retainedInventory(runtime: RecallReadWorkerRuntime) {
  for (let index = 0; index < 32; index++) expect(readSemanticLease(runtime, caller, `older-${index}`, ["project"], "query")).toBeDefined();
}

it.each([1, 1024, 16384])("meters preflight and publication independently of %i owned phase string units", async length => {
  await withIndexedSources([{ id: "raw", text: "Orchid irrigation.", vector: [1, 0, 0] }], async fixture => {
    const runtime = { database: fixture.database } as RecallReadWorkerRuntime;
    inventory(runtime);
    const { lease, input, preparation, acquisition } = ownedLease(runtime, '"\\\n原文🙂'.repeat(length));
    const expectedLength = JSON.stringify(lease).length;
    input.reason = "caller mutation after capture";
    const sizing = expectedCost(lease, [], true);
    const publication = plus(plus(expectedCost(lease, [preparation, acquisition]), sizing),
      { work_units: 64, memory_bytes: 0 }); // One issue checked against the actual 32 retained rows.
    const stringify = vi.spyOn(JSON, "stringify");
    const preflight = new SourceSemanticReadBudget(sizing);
    preflightSemanticLeaseGroup(runtime, [lease], preflight);
    const published = new SourceSemanticReadBudget(publication);
    issueSemanticLeaseGroup(runtime, [{ issuedId: "published", lease }], published);
    const serialized = stringify.mock.calls.map(([value]) => value);
    stringify.mockRestore();
    expect(serialized.every(value => typeof value === "number")).toBe(true);
    expect(preflight.remaining()).toEqual({ work_units: 0, memory_bytes: 0 });
    expect(published.remaining()).toEqual({ work_units: 0, memory_bytes: 0 });
    const retained = readSemanticLease(runtime, caller, "published", ["project"], "query");
    expect(JSON.stringify(retained).length).toBe(expectedLength);
    expect(retained.access_pool!.access.phases[1]).toBe(preparation);
    expect(preparation[1]).not.toContain(input.reason);
    expect(Object.isFrozen(preparation[1])).toBe(true);
    // A full row inventory evicts only the oldest entry at publication, not at preflight.
    expect(() => readSemanticLease(runtime, caller, "older-0", ["project"], "query")).toThrow(/expired/u);
    for (const [index, short] of [{ ...sizing, work_units: sizing.work_units - 1 },
      { ...sizing, memory_bytes: sizing.memory_bytes - 1 }].entries()) {
      expect(() => preflightSemanticLeaseGroup(runtime, [lease], new SourceSemanticReadBudget(short)))
        .toThrow(SourceSemanticResourceExhausted);
      const cost = { ...publication, [index === 0 ? "work_units" : "memory_bytes"]:
        publication[index === 0 ? "work_units" : "memory_bytes"] - 1 };
      expect(() => issueSemanticLeaseGroup(runtime, [{ issuedId: `short-${index}`, lease }], new SourceSemanticReadBudget(cost)))
        .toThrow(SourceSemanticResourceExhausted);
      expect(() => readSemanticLease(runtime, caller, `short-${index}`, ["project"], "query")).toThrow(/expired/u);
      expect(readSemanticLease(runtime, caller, "published", ["project"], "query")).toBe(retained);
    }
  });
});

it("keeps exact and adjacent canonical byte capacity with real retained inventory and atomic rejection", async () => {
  await withIndexedSources([{ id: "raw", text: "Orchid irrigation.", vector: [1, 0, 0] }], async fixture => {
    const runtime = { database: fixture.database } as RecallReadWorkerRuntime;
    inventory(runtime);
    const base = ownedLease(runtime, "");
    const padding = 2_000_000 - JSON.stringify(base.lease).length;
    const exact = ownedLease(runtime, "x".repeat(padding));
    const adjacent = ownedLease(runtime, "x".repeat(padding + 1));
    expect(4 * JSON.stringify(exact.lease).length).toBe(8_000_000);
    expect(4 * JSON.stringify(adjacent.lease).length).toBe(8_000_004);
    const sizing = expectedCost(exact.lease, [], true);
    preflightSemanticLeaseGroup(runtime, [exact.lease], new SourceSemanticReadBudget(sizing));
    retainedInventory(runtime);
    expect(() => preflightSemanticLeaseGroup(runtime, [adjacent.lease], new SourceSemanticReadBudget(sizing)))
      .toThrow(/exceeds lease capacity/u);
    retainedInventory(runtime);
    const publication = plus(plus(expectedCost(exact.lease, [exact.preparation, exact.acquisition]), sizing),
      { work_units: 64, memory_bytes: 0 });
    expect(() => issueSemanticLeaseGroup(runtime, [{ issuedId: "oversize", lease: adjacent.lease }], new SourceSemanticReadBudget(publication)))
      .toThrow(/exceeds lease capacity/u);
    retainedInventory(runtime);
    expect(() => readSemanticLease(runtime, caller, "oversize", ["project"], "query")).toThrow(/expired/u);
    const meter = new SourceSemanticReadBudget(publication);
    issueSemanticLeaseGroup(runtime, [{ issuedId: "exact", lease: exact.lease }], meter);
    expect(meter.remaining()).toEqual({ work_units: 0, memory_bytes: 0 });
    expect(readSemanticLease(runtime, caller, "exact", ["project"], "query")).toBe(exact.lease);
    for (let index = 0; index < 32; index++) {
      expect(() => readSemanticLease(runtime, caller, `older-${index}`, ["project"], "query")).toThrow(/expired/u);
    }
  });
});
