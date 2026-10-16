import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => { isolation.restore(); });
import { canonicalJson, canonicalJsonChunks, captureSourceSemanticAcquisition, captureSourceSemanticQueryPreparation,
  packSourceSemanticAcquisition, packSourceSemanticQueryPreparation, SourceSemanticAccessReceiptSchema,
  sourceSemanticAccessPhases, type SourceSemanticAccessReceipt }
  from "@do-soul/alaya-protocol";
import { fieldContractSha256, fieldContractSha256Chunks } from "@do-soul/alaya-core";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { observeSourceSemanticAccess } from "../../../runtime/recall-read-worker/source-semantic-candidate-access.js";
import { sourceSemanticRevision } from "../../../runtime/recall-read-worker/source-semantic-leases.js";
import { runSourceSemanticWorker } from "../../../runtime/recall-read-worker/source-semantic-reasoning.js";
import { SourceSemanticUnionCompletion } from "../../../runtime/recall-read-worker/source-semantic-empty-population-budget.js";
import type { RecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { CLOCK, ORIGINAL, QUERY_BUDGET, RAW, SCOPES, WS, withIndexedSources, type IndexFixture }
  from "./source-semantic-index-acquisition.test-support.js";

const AMPLE = { work_units: 1_000_000, memory_bytes: 1_000_000 };
const prepare = { kind: "prepare_query" as const, original_query: ORIGINAL, budget: QUERY_BUDGET };
function runtime(fixture: IndexFixture) { return { database: fixture.database } as RecallReadWorkerRuntime; }

function compactPhases(access: Readonly<{ phases: SourceSemanticAccessReceipt["phases"] }>) {
  expect(access.phases[0]).toBe(2);
  expect(Array.isArray(access.phases[1])).toBe(true);
  expect(Array.isArray(access.phases[2])).toBe(true);
  expect(access).not.toHaveProperty("preparation");
  expect(access).not.toHaveProperty("acquisition");
  expect(access).not.toHaveProperty("phase_accounting");
}

function independentPoolMaterial(access: Omit<SourceSemanticAccessReceipt, "trace">, worker: RecallReadWorkerRuntime,
  authorized: readonly string[] | null = ["project"]) {
  const expanded = sourceSemanticAccessPhases(access);
  const receipt = {
    contract: access.contract, policy: access.policy, input_id: access.input_id,
    ...(access.source_preview_extents === undefined ? {} : { source_preview_extents: access.source_preview_extents }),
    observed_source_count: access.observed_source_count,
    observed_interpretation_count: access.observed_interpretation_count,
    source_candidates: access.source_candidates, interpretation_candidates: access.interpretation_candidates,
    unvisited_sources: access.unvisited_sources, unvisited_interpretations: access.unvisited_interpretations,
    stopping_reasons: access.stopping_reasons, ...expanded
  };
  return { receipt, workspace: WS, authorized, revision: sourceSemanticRevision(worker) };
}
function independentPoolId(access: Omit<SourceSemanticAccessReceipt, "trace">, worker: RecallReadWorkerRuntime) {
  return `sha256:${fieldContractSha256(canonicalJson(independentPoolMaterial(access, worker)))}`;
}

function scalarEncodingBytes(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum, child) => sum + scalarEncodingBytes(child), 0);
  if (value !== null && typeof value === "object") return Object.entries(value).reduce((sum, [key, child]) =>
    sum + 24 + 2 * JSON.stringify(key).length + scalarEncodingBytes(child), 0);
  return 24 + 2 * JSON.stringify(value).length;
}

function held(budget: SourceSemanticReadBudget) {
  const outstanding = budget.outstandingAllowance();
  return { work_units: outstanding.work_units - budget.spentWork, memory_bytes: outstanding.memory_bytes - budget.spentBytes };
}

it("charges exact UTF-8 hash handoffs without changing Unicode preimages", () => {
  for (const text of ["ascii", "原文", "🙂", "\ud800"]) {
    const value = { text }, preimage = canonicalJson(value);
    let handoffBytes = 0;
    const digest = fieldContractSha256Chunks(canonicalJsonChunks(value), {
      charge(work, bytes, phase) {
        expect(work).toBe(1);
        expect(phase).toBe("canonical identity hash handoff");
        handoffBytes += bytes;
      }
    });
    expect(digest).toBe(fieldContractSha256(preimage));
    expect(handoffBytes).toBe(Buffer.byteLength(preimage, "utf8"));
  }
});

it("hashes the expanded preimage independently while retaining compact phases and charging packing without refunds", async () => {
  await withIndexedSources([{ id: "raw", text: RAW, vector: [1, 0, 0] }], async fixture => {
    const prepared = await fixture.prepareQuery({ navigation: ORIGINAL,
      signal: new AbortController().signal, remainingMs: () => 60_000 });
    const worker = runtime(fixture);
    const charge = SourceSemanticReadBudget.prototype.charge;
    const retain = SourceSemanticReadBudget.prototype.retain;
    const spent: number[] = [];
    const charged: { phase: string | undefined; units: number; bytes: number }[] = [];
    const retained: { phase: string | undefined; value: unknown }[] = [];
    const meter = new SourceSemanticReadBudget(QUERY_BUDGET);
    vi.spyOn(SourceSemanticReadBudget.prototype, "charge").mockImplementation(function (this: SourceSemanticReadBudget, units, bytes, phase) {
      charge.call(this, units, bytes, phase);
      if (this === meter) {
        spent.push(this.spentWork);
        charged.push({ phase, units, bytes });
      }
    });
    vi.spyOn(SourceSemanticReadBudget.prototype, "retain").mockImplementation(function (this: SourceSemanticReadBudget, value, phase, ownership) {
      retain.call(this, value, phase, ownership);
      retained.push({ phase, value });
    });
    const pool = fixture.database.connection.transaction(() => observeSourceSemanticAccess(worker, {
      workspace_id: WS, as_of: CLOCK, authorized_scopes: SCOPES, prepared_query: prepared, request: prepare
    }, ["project"], meter, ORIGINAL, undefined, "query-conditioned-v1", QUERY_BUDGET))();
    compactPhases(pool.access);
    expect(independentPoolId(pool.access, worker)).toBe(pool.access.pool_id);
    const semantics = sourceSemanticAccessPhases(pool.access);
    expect(packSourceSemanticQueryPreparation(captureSourceSemanticQueryPreparation(semantics.preparation)))
      .toEqual(pool.access.phases[1]);
    expect(packSourceSemanticAcquisition(captureSourceSemanticAcquisition(semantics.acquisition)))
      .toEqual(pool.access.phases[2]);
    expect(meter.preparation).toEqual(pool.access.phases[1]);
    expect(meter.acquisition).toEqual(pool.access.phases[2]);
    const receipt = retained.find(row => row.phase === "access receipt identity")?.value as { phases?: unknown } | undefined;
    expect(receipt?.phases).toEqual(pool.access.phases);
    expect(receipt).not.toHaveProperty("preparation");
    expect(retained.some(row => row.phase === "source phase packed preparation allocation")).toBe(true);
    expect(retained.some(row => row.phase === "source phase packed acquisition allocation")).toBe(true);
    // Borrowed phase strings are streamed rather than retained as a second full preimage.
    expect(retained.some(row => row.phase === "source access expanded canonical identity traversal")).toBe(false);
    expect(retained.some(row => row.phase === "source access canonical identity encoding")).toBe(false);
    for (const phase of ["canonical identity traversal", "canonical identity scalar encoding", "canonical identity hash handoff"]) {
      expect(charged.some(row => row.phase === phase && row.units > 0 && row.bytes > 0)).toBe(true);
    }
    const material = independentPoolMaterial(pool.access, worker);
    expect(charged.filter(row => row.phase === "canonical identity hash handoff").reduce((sum, row) => sum + row.bytes, 0))
      .toBe(Buffer.byteLength(canonicalJson(material), "utf8"));
    expect(charged.filter(row => row.phase === "canonical identity scalar encoding").reduce((sum, row) => sum + row.bytes, 0))
      .toBe(scalarEncodingBytes(material));
    expect(spent.length).toBeGreaterThan(0);
    for (let index = 1; index < spent.length; index++) expect(spent[index]!).toBeGreaterThanOrEqual(spent[index - 1]!);
    expect(meter.spentWork).toBe(spent.at(-1));
    const quoted = { preparation: pool.access.phases[1] };
    // One array frame/slots plus five wrapper frames, preparation keys and owned references.
    const pending: unknown[] = [quoted];
    let sizeWork = 0, sizeBytes = 0;
    while (pending.length > 0) {
      const value = pending.pop(); sizeWork++;
      if (value !== null && typeof value === "object") {
        if (!Array.isArray(value)) sizeWork += Object.keys(value).length;
        pending.push(...Object.values(value));
      } else if (typeof value === "string" || typeof value === "number") {
        sizeWork++;
        if (typeof value === "number" && !Number.isSafeInteger(value)) sizeBytes += 88;
      }
    }
    const fiveHold = { work_units: 1 + 5 * 2 + 2 * sizeWork,
      memory_bytes: 64 + 5 * 8 + 5 * (64 + 24 + 4 * 11 + 8) + 2 * sizeBytes };
    const parent = new SourceSemanticReadBudget(AMPLE);
    const child = new SourceSemanticReadBudget(AMPLE);
    new SourceSemanticUnionCompletion(parent, child, () => ({ work_units: 0, memory_bytes: 0 })).metadata(quoted);
    expect(held(parent)).toEqual(fiveHold);
    expect(meter.spentWork).toBe(spent.at(-1));
  });
});

it("keeps compact access phases on the in-process public prepare path and the same independent identity", async () => {
  await withIndexedSources([{ id: "raw", text: RAW, vector: [1, 0, 0] }], async fixture => {
    const prepared = await fixture.prepareQuery({ navigation: ORIGINAL,
      signal: new AbortController().signal, remainingMs: () => 60_000 });
    const worker = runtime(fixture);
    const result = runSourceSemanticWorker(worker, { workspace_id: WS, as_of: CLOCK, authorized_scopes: SCOPES,
      prepared_query: prepared, request: prepare });
    if (result.kind !== "prepare_query" || result.access === undefined) throw new Error("public preparation access expected");
    expect(SourceSemanticAccessReceiptSchema.safeParse(result.access).success).toBe(true);
    compactPhases(result.access);
    const { trace: _trace, ...identity } = result.access;
    expect(independentPoolId(identity, worker)).toBe(result.access.pool_id);
    const semantics = sourceSemanticAccessPhases(result.access);
    expect(packSourceSemanticQueryPreparation(captureSourceSemanticQueryPreparation(semantics.preparation)))
      .toEqual(result.access.phases[1]);
    expect(packSourceSemanticAcquisition(captureSourceSemanticAcquisition(semantics.acquisition)))
      .toEqual(result.access.phases[2]);
    expect(semantics.acquisition.status).toBe("executed");
  });
});
