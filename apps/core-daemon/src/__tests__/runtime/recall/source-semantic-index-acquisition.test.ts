import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => { isolation.restore(); });
import { createSourceSemanticAccessPolicy, fieldContractSha256 } from "@do-soul/alaya-core";
import { SqliteFieldSourceRecordRepo, SqliteSourceIndexRepository } from "@do-soul/alaya-storage";
import { query as incompatibleQuery } from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-proof-fixture.js";
import { canonicalJson, SourceSemanticAccessReceiptSchema, SourceSemanticExecutionSchema, sourceSemanticAccessPhases,
  sourceSemanticExecution, sourceSemanticExecutionPhases, SourceSemanticResourceExhausted, SourceSemanticResourceLedger
} from "@do-soul/alaya-protocol";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { listEligibleSemanticSources } from "../../../runtime/recall-read-worker/source-recall-catalog.js";
import { readSemanticLease, sourceSemanticRevision } from "../../../runtime/recall-read-worker/source-semantic-leases.js";
import { runSourceSemanticWorker } from "../../../runtime/recall-read-worker/source-semantic-reasoning.js";
import { acquireSourceSemanticIndex } from "../../../runtime/recall-read-worker/source-semantic-index-acquisition.js";
import { observeSourceSemanticAccess } from "../../../runtime/recall-read-worker/source-semantic-candidate-access.js";
import type { RecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { CLOCK, WS, ORIGINAL, RAW, SCOPES, QUERY_BUDGET, SIMULATED_CONFIGURATION,
  digest, obstructedSources, publicMcp, withIndexedSources, workerCall, type IndexFixture }
  from "./source-semantic-index-acquisition.test-support.js";

const preparation = { kind: "prepare_query" as const, original_query: ORIGINAL, budget: QUERY_BUDGET };
const recall = { kind: "recall" as const, accepts_unreviewed_conditional_results: true as const,
  original_query: ORIGINAL, semantic_correspondences: [], budget: QUERY_BUDGET, output_byte_limit: 1_000_000 };
function runtime(fixture: IndexFixture) { return { database: fixture.database } as RecallReadWorkerRuntime; }
async function preparedVector(fixture: IndexFixture) {
  return fixture.prepareQuery({ navigation: ORIGINAL, signal: new AbortController().signal, remainingMs: () => 60_000 });
}
function checkedAcquisitionCapture(result: ReturnType<typeof acquireSourceSemanticIndex>, meter: SourceSemanticReadBudget) {
  const phase = sourceSemanticExecutionPhases(SourceSemanticExecutionSchema.parse(sourceSemanticExecution(undefined, meter.acquisition!))).acquisition;
  expect(result.phase).toEqual(phase);
  expect(Object.isFrozen(result.phase)).toBe(true);
  expect(Array.isArray(meter.acquisition)).toBe(true);
  return phase;
}

it("unions an unannotated vector-only root outside the same-budget canonical census through real SQLite", async () => {
  await withIndexedSources(obstructedSources, async fixture => {
    const prepared = await preparedVector(fixture);
    expect(prepared.receipt).toMatchObject({ status: "ready", submitted_inputs: 1, token_count: 2,
      method: "local_inference", external_api_attempts: 0, binding_work: "unknown", execution_work: "unknown" });
    expect(fixture.queryBinding.embedInputs.mock.calls[0]?.[0]).toEqual([{ input_id: digest(ORIGINAL), text: ORIGINAL }]);
    // The receipt's inference method describes the simulated binding; no real model was loaded.
    const meter = new SourceSemanticReadBudget(QUERY_BUDGET);
    const pool = fixture.database.connection.transaction(() => observeSourceSemanticAccess(runtime(fixture), {
      workspace_id: WS, as_of: CLOCK, authorized_scopes: SCOPES, request: preparation, prepared_query: prepared
    }, ["project"], meter, ORIGINAL, undefined, "query-conditioned-v1", QUERY_BUDGET))();
    const target = fixture.targets.find(row => row.source_id === "z-vector")!;
    const acquisition = sourceSemanticAccessPhases(pool.access).acquisition;
    const nomination = acquisition.result?.nominations.find(row => row.source.source_id === "z-vector");
    expect(nomination).toMatchObject({ source: target, lexical: [], vector: { rank: 1, cosine: 1,
      window: { start_byte: 0, end_byte: Buffer.byteLength(RAW), content_digest: digest(RAW) } } });
    expect(acquisition).toMatchObject({ status: "executed", accounting: "complete" });
    expect(acquisition.result?.lexical).toMatchObject({ completion: "complete", index_coverage: "partial" });
    expect(acquisition.result?.nominations.every(row => row.lexical.length === 0)).toBe(true);
    expect(pool.descriptors).toEqual([]);
    expect(pool.sources.filter(row => row.identity === target.target.root_id)).toHaveLength(1);
    expect(pool.access.source_candidates.find(row => row.record_id === target.target.root_id)).toMatchObject({ complete: true,
      read_bytes: Buffer.byteLength(RAW), body_bytes: Buffer.byteLength(RAW), signal: { source_text_score: 0 } });
    const controlMeter = new SourceSemanticReadBudget(QUERY_BUDGET);
    const control = fixture.database.connection.transaction(() => observeSourceSemanticAccess(runtime(fixture), {
      workspace_id: WS, as_of: CLOCK, authorized_scopes: SCOPES,
      request: { ...preparation, access_policy: "canonical-v1" }
    }, ["project"], controlMeter, ORIGINAL, undefined, "canonical-v1", QUERY_BUDGET))();
    expect(control.sources.some(row => row.identity === target.target.root_id)).toBe(false);
    expect(control.access.unvisited_sources).toBe(true);
    expect(sourceSemanticAccessPhases(control.access).acquisition).toMatchObject({ status: "not_run", reason: "controlled_or_scoped_access", result: null });
    expect(meter.indexWork).toBe(sourceSemanticAccessPhases(pool.access).acquisition.result!.resources.work);
    expect(meter.spentWork).toBeLessThanOrEqual(QUERY_BUDGET.work_units);
    expect(meter.spentBytes).toBeLessThanOrEqual(QUERY_BUDGET.memory_bytes);
    expect(fixture.database.connection.prepare("SELECT COUNT(*) AS n FROM evidence_capsules").get()).toEqual({ n: 0 });
  });
}, 60_000);

it("reaches the unannotated vector-only Source through public MCP preparation, frozen reuse and direct built-worker recall", async () => {
  await withIndexedSources(obstructedSources, async fixture => {
    const client = await fixture.openClient(), call = publicMcp(client);
    const dispatch = vi.spyOn(client.sourceSemanticsPort!, "execute");
    const target = fixture.targets.find(row => row.source_id === "z-vector")!;
    const prepared = await call({ operation: "prepare_query", original_query: ORIGINAL, budget: QUERY_BUDGET, authorized_scopes: SCOPES });
    if (prepared.operation !== "prepare_query") throw new Error("MCP preparation expected");
    expect(prepared.query_handle).toBeDefined();
    expect(prepared.access?.contract).toBe("source-semantic-access-v2");
    expect(prepared.access?.phases[0]).toBe(2);
    expect(prepared.access?.phases[2][0]).toBe(1);
    expect(SourceSemanticAccessReceiptSchema.safeParse(prepared.access).success).toBe(true);
    expect(SourceSemanticExecutionSchema.safeParse(prepared.execution).success).toBe(true);
    expect(sourceSemanticAccessPhases(prepared.access!).acquisition.result?.nominations.find(row => row.source.source_id === "z-vector"))
      .toMatchObject({ source: target, lexical: [], vector: { rank: 1, cosine: 1 } });
    expect(prepared.access?.source_candidates.find(row => row.record_id === target.target.root_id)).toMatchObject({ complete: true });
    expect(prepared.candidates).toEqual([]);
    expect(sourceSemanticExecutionPhases(prepared.execution).query_preparation.external_api_attempts).toBe(0);
    expect(fixture.queryBinding.embedInputs).toHaveBeenCalledTimes(1);
    const leased = await call({ operation: "recall", accepts_unreviewed_conditional_results: true,
      query_handle: prepared.query_handle, semantic_correspondences: [], budget: QUERY_BUDGET,
      output_byte_limit: 1_000_000, authorized_scopes: SCOPES });
    if (leased.operation !== "recall") throw new Error("MCP recall expected");
    expect(leased.protocol_version).toBe(8);
    expect(leased.index?.result_version).toBe("source-semantic-library-v6");
    expect(leased.discovery?.access?.pool_id).toBe(prepared.access?.pool_id);
    expect(leased.discovery?.access?.phases[2]).toEqual(prepared.access?.phases[2]);
    expect(sourceSemanticExecutionPhases(leased.execution).acquisition).toMatchObject({ status: "not_run" });
    // Payload hydration may read native source bytes; frozen reuse must not rerun acquisition or inference.
    expect(sourceSemanticExecutionPhases(leased.execution).query_preparation).toMatchObject({ status: "not_requested", submitted_inputs: 0 });
    expect(fixture.queryBinding.embedInputs).toHaveBeenCalledTimes(1);
    expect(leased.results?.find(row => row.target.kind === "source_evidence" && row.target.root_id === target.target.root_id))
      .toMatchObject({ content_preview: RAW, source_channels: ["source_record"] });
    const direct = await workerCall(client, recall);
    expect(fixture.queryBinding.embedInputs).toHaveBeenCalledTimes(2);
    expect(sourceSemanticExecutionPhases(SourceSemanticExecutionSchema.parse(direct.execution))).toMatchObject({ contract: "source-semantic-execution-v3",
      query_preparation: { status: "ready", submitted_inputs: 1 }, acquisition: { status: "executed", accounting: "complete" } });
    expect(sourceSemanticAccessPhases(direct.discovery.access!).acquisition.result?.nominations.find(row => row.source.source_id === "z-vector"))
      .toMatchObject({ source: target, lexical: [], vector: { rank: 1, cosine: 1 } });
    expect(direct.index.entries.filter(row => row.target.kind === "source_evidence" && row.target.root_id === target.target.root_id))
      .toHaveLength(1);
    expect(direct.proofs ?? []).toEqual([]);
    expect(direct.coverage.conditional_computation).toBe("unexercised");
    expect(direct.work.logical_work).toBeLessThanOrEqual(QUERY_BUDGET.work_units);
    expect(direct.work.logical_memory_bytes).toBeLessThanOrEqual(QUERY_BUDGET.memory_bytes);
    // Reuse the actual MCP caller binding, changing only scope rather than accidentally changing principal.
    const boundCaller = dispatch.mock.calls[0]![0];
    await expect(client.sourceSemanticsPort!.execute({ ...boundCaller,
      request: { ...recall, query_handle: prepared.query_handle! },
      authorized_scopes: { mode: "named", scopes: ["global_core"] } })).rejects.toThrow(/scope/u);
  });
}, 60_000);

it("denies indexed scopes before union admission and retains one tuple shared by canonical and vector discovery", async () => {
  await withIndexedSources([{ id: "public", text: RAW, vector: [1, 0, 0] },
    { id: "private", text: "Secret berth closure.", scope: "global_core", vector: [1, 0, 0] }], async fixture => {
    const client = await fixture.openClient();
    const result = await workerCall(client, { ...preparation, access_hint: "Secret berth" });
    expect(sourceSemanticAccessPhases(result.access!).acquisition.result?.accounting).toMatchObject({ attempted: 2, admitted: 1,
      rejected: 1, scope_denied: 1, native_unknown: 0 });
    expect(sourceSemanticAccessPhases(result.access!).acquisition.supplemental?.[0]?.result?.accounting.scope_denied)
      .toBeGreaterThanOrEqual(1);
    expect(result.access?.observed_source_count).toBe(1);
    expect(result.access?.source_candidates.map(row => row.source_id)).toEqual(["public"]);
    expect(sourceSemanticAccessPhases(result.access!).acquisition.result?.nominations.map(row => row.source.source_id)).toEqual(["public"]);
    const before = fixture.queryBinding.embedInputs.mock.calls.length;
    const canonical = await workerCall(client, { ...preparation, access_policy: "canonical-v1" });
    expect(sourceSemanticAccessPhases(canonical.access!).acquisition).toMatchObject({ status: "not_run", result: null, reason: "controlled_or_scoped_access" });
    expect(fixture.queryBinding.embedInputs).toHaveBeenCalledTimes(before);
    const source = await workerCall(client, { kind: "prepare_source", source_id: "public", budget: QUERY_BUDGET });
    if (source.source_handle === undefined) throw new Error("source handle expected");
    const restricted = await workerCall(client, { ...preparation, source_handle: source.source_handle });
    expect(restricted.access?.source_candidates.map(row => row.source_id)).toEqual(["public"]);
    expect(sourceSemanticAccessPhases(restricted.access!).acquisition).toMatchObject({ status: "not_run", result: null });
    expect(fixture.queryBinding.embedInputs).toHaveBeenCalledTimes(before);
    await expect(workerCall(client, { kind: "prepare_source", source_id: "private", budget: QUERY_BUDGET })).rejects.toThrow();
  });
}, 60_000);

it.each(["source revision", "selected profile"] as const)("does not redirect a nomination after a %s switch during simulated preparation", async mutation => {
  await withIndexedSources([{ id: "raw", text: RAW, vector: [1, 0, 0] }], async fixture => {
    const target = fixture.targets[0]!;
    const originalPreparation = fixture.prepareQuery.getMockImplementation()!;
    fixture.prepareQuery.mockImplementationOnce(async input => {
      const prepared = await originalPreparation(input);
      if (mutation === "source revision") await fixture.admit({ id: "raw", text: "Replaced original bytes." }, "2");
      else fixture.lifecycle.select(WS, { ...SIMULATED_CONFIGURATION,
        profile: { ...SIMULATED_CONFIGURATION.profile, model_revision: "fixture-v2" } });
      return prepared;
    });
    const client = await fixture.openClient();
    const result = await workerCall(client, { ...preparation, access_hint: "Unrelated irrigation" });
    expect(sourceSemanticExecutionPhases(SourceSemanticExecutionSchema.parse(result.execution)).query_preparation).toMatchObject({ status: "ready", selected: { profile_id: fixture.selection.profile_id } });
    expect(sourceSemanticAccessPhases(result.access!).acquisition.status).toBe("executed");
    expect(sourceSemanticAccessPhases(result.access!).acquisition.result?.nominations).toEqual([]);
    expect(sourceSemanticAccessPhases(result.access!).acquisition.supplemental?.[0]?.result?.nominations).toEqual([]);
    if (mutation === "selected profile") {
      expect(sourceSemanticAccessPhases(result.access!).acquisition.result?.vector).toMatchObject({ completion: "unavailable", state: { status: "unbound" } });
      // A model switch cannot revoke the still-current, independently authorized Source.
      expect(result.access?.source_candidates).toContainEqual(expect.objectContaining({ record_id: target.target.root_id, complete: true }));
    } else {
      expect(result.access?.source_candidates.some(row => row.record_id === target.target.root_id)).toBe(false);
      expect(result.access?.source_candidates.find(row => row.source_id === "raw")?.record_id).not.toBe(target.target.root_id);
      expect(sourceSemanticAccessPhases(result.access!).acquisition.result?.vector.state).toMatchObject({ status: "partial" });
    }
  });
}, 60_000);

it("checks the entire nominated target tuple without redirecting a mismatched root to the same source id", async () => {
  await withIndexedSources([{ id: "raw", text: RAW, vector: [1, 0, 0] }], async fixture => {
    const source = fixture.targets[0]!;
    for (const changed of [{ root_id: `sha256:${"b".repeat(64)}` }, { source_version: "2" },
      { content_digest: digest("different bytes") }, { workspace_id: "wrong-workspace" }]) {
      // Canonical discovery is separately charged; this exact-boundary probe stops before its next seek.
      const meter = new SourceSemanticReadBudget({ work_units: 5, memory_bytes: 1_000_000 });
      const result = listEligibleSemanticSources(fixture.database, WS, meter, ["project"], [], {
        nominations: [{ ...source, target: { ...source.target, ...changed } }],
        beforeRetain: () => { throw new Error("a mismatched nomination must not be admitted"); }
      });
      expect(result.sources).toEqual([]);
      expect(result.stopping_reasons).toContain("budget");
      expect(meter.nativeWork).toBe(5);
      expect(meter.spentWork).toBe(5);
    }
  });
});

it("keeps useful source observation and real v2 phase evidence inside the original small native preparation budget", async () => {
  await withIndexedSources([{ id: "raw", text: RAW, vector: [1, 0, 0] }], async fixture => {
    const budget = { ...QUERY_BUDGET, memory_bytes: 300_000 }, worker = runtime(fixture);
    const prepared = await fixture.prepareQuery({ navigation: ORIGINAL, supplemental_navigation: "x".repeat(1024),
      signal: new AbortController().signal, remainingMs: () => 60_000 });
    const reserve = SourceSemanticResourceLedger.prototype.reserve;
    const refusals: { phase: string | undefined; requested: readonly number[]; remaining: readonly number[] }[] = [];
    vi.spyOn(SourceSemanticResourceLedger.prototype, "reserve").mockImplementation(function (this: SourceSemanticResourceLedger, work, bytes, phase) {
      try { reserve.call(this, work, bytes, phase); }
      catch (error) {
        if (error instanceof SourceSemanticResourceExhausted) refusals.push({ phase, requested: [work, bytes], remaining: [this.work, this.bytes] });
        throw error;
      }
    });
    const result = (() => {
      try { return runSourceSemanticWorker(worker, { workspace_id: WS, as_of: CLOCK,
        authorized_scopes: SCOPES, prepared_query: prepared,
        request: { ...preparation, access_hint: "x".repeat(1024), budget } }); }
      catch (error) { throw new Error(`native preparation failed: ${JSON.stringify(refusals)}`, { cause: error }); }
    })();
    if (result.kind !== "prepare_query") throw new Error("preparation expected");
    expect(result.outcome, JSON.stringify({ work: result.work, refusals }))
      .toEqual({ status: "preparation_required", missing: "query_semantics" });
    expect(result.query_handle).toBeDefined();
    expect(result.access).toMatchObject({ contract: "source-semantic-access-v2", observed_source_count: 1,
      observed_interpretation_count: 0, unvisited_sources: false, unvisited_interpretations: false });
    expect(result.access?.source_candidates).toContainEqual(expect.objectContaining({ source_id: "raw", complete: true,
      read_bytes: Buffer.byteLength(RAW), body_bytes: Buffer.byteLength(RAW) }));
    expect(sourceSemanticExecutionPhases(SourceSemanticExecutionSchema.parse(result.execution)).acquisition)
      .toEqual(sourceSemanticAccessPhases(result.access!).acquisition);
    const { pool_id, trace: _trace, phases: _phases, ...fields } = result.access!;
    const expanded = { ...fields, ...sourceSemanticAccessPhases(result.access!) };
    const retained = readSemanticLease(worker, { workspace_id: WS, as_of: CLOCK }, result.query_handle!, ["project"], "query");
    expect(retained.access_pool?.retainedWitness).toHaveLength(2);
    expect(pool_id).toBe(`sha256:${fieldContractSha256(canonicalJson({ receipt: expanded,
      workspace: WS, authorized: ["project"], revision: sourceSemanticRevision(worker),
      retained_witness: retained.access_pool!.retainedWitness }))}`);
    expect(result.work.logical_work).toBeLessThanOrEqual(budget.work_units);
    expect(result.work.logical_memory_bytes).toBeLessThanOrEqual(budget.memory_bytes);
  });
});

it("retains actual native acquisition unknowns rather than certifying successful empty source absence", async () => {
  await withIndexedSources([{ id: "raw", text: RAW, vector: [1, 0, 0] }], async fixture => {
    const prepared = await preparedVector(fixture);
    // Corrupt projection metadata only; the independently authorized Source remains intact.
    fixture.database.connection.prepare("UPDATE source_index_roots SET target_json='{' WHERE workspace_id=?").run(WS);
    const meter = new SourceSemanticReadBudget(QUERY_BUDGET);
    const pool = fixture.database.connection.transaction(() => observeSourceSemanticAccess(runtime(fixture), {
      workspace_id: WS, as_of: CLOCK, authorized_scopes: SCOPES, prepared_query: prepared, request: preparation
    }, ["project"], meter, ORIGINAL, undefined, "query-conditioned-v1", QUERY_BUDGET))();
    const unknown = sourceSemanticAccessPhases(pool.access);
    expect(unknown.acquisition.result).toMatchObject({ completion: "partial", nominations: [],
      vector: { completion: "unavailable", reason: "native_query_failed" },
      resources: { sql_internal_work: "unknown" } });
    expect(unknown.phase_accounting).toMatchObject({ native_cpu: "unknown", observation: {
      sql_internal_work: "unknown", native_bytes: expect.any(Number) } });
    expect(unknown.acquisition.result?.resources.work).toBeGreaterThan(0);
    expect(pool.access.source_candidates).toContainEqual(expect.objectContaining({ source_id: "raw", complete: true }));
    expect(meter.acquisition).toEqual(pool.access.phases[2]);
  });
});

it("reports an actual bounded acquisition refusal with its native cost rather than counting held capacity as spend", async () => {
  await withIndexedSources([{ id: "raw", text: RAW, vector: [1, 0, 0] }], async fixture => {
    const prepared = await preparedVector(fixture);
    const meter = new SourceSemanticReadBudget({ work_units: 512, memory_bytes: QUERY_BUDGET.memory_bytes });
    const policy = createSourceSemanticAccessPolicy(ORIGINAL, undefined, "query-conditioned-v1",
      new SourceSemanticReadBudget(QUERY_BUDGET));
    const metadataMeter = new SourceSemanticReadBudget(QUERY_BUDGET);
    const result = fixture.database.connection.transaction(() => acquireSourceSemanticIndex({ runtime: runtime(fixture),
      workspace: WS, navigation: ORIGINAL, authorized: ["project"], meter, metadataMeter, vector: prepared.vector,
      canonicalBytes: Buffer.byteLength(RAW), sourceCost: policy.sourceCost }))();
    try {
      const phase = checkedAcquisitionCapture(result, meter);
      expect(phase).toMatchObject({ status: "executed", accounting: "complete", result: { completion: "partial" } });
      expect(phase.result?.resource_refusals.length).toBeGreaterThan(0);
      expect(phase.result?.vector.completion).not.toBe("complete");
      expect(meter.indexWork).toBe(phase.result!.resources.work);
      expect(meter.nativeBytes).toBe(phase.result!.resources.native_bytes);
      expect(meter.spentWork).toBeLessThanOrEqual(512);
      expect(meter.spentBytes).toBeLessThanOrEqual(QUERY_BUDGET.memory_bytes);
      const spent = [meter.spentWork, meter.spentBytes];
      result.releaseCanonical();
      expect([meter.spentWork, meter.spentBytes]).toEqual(spent);
    } finally { result.releaseCanonical(); }
  });
});

it.each(["absent", "refused"] as const)("retains original vector discovery under an incompatible hint and %s Q through the built worker", async semantics => {
  await withIndexedSources(obstructedSources, async fixture => {
    const hint = "Unrelated irrigation";
    fixture.queryBinding.embedInputs.mockImplementation(async inputs => inputs.map(input => ({ status: "embedded" as const,
      input_id: input.input_id, input_digest: digest(input.text), token_count: 2, truncated: false as const,
      vector: new Float32Array(input.text === ORIGINAL ? [1, 0, 0] : [0, 1, 0]) })));
    const client = await fixture.openClient();
    const result = await workerCall(client, { ...preparation, access_hint: hint,
      ...(semantics === "absent" ? {} : { query_semantics: incompatibleQuery() }) });
    expect(result.query_semantics_status).toEqual({ status: "unavailable", reason: semantics === "absent" ? "absent" : "invalid" });
    const phases = sourceSemanticAccessPhases(result.access!), first = phases.acquisition.result!;
    const second = phases.acquisition.supplemental?.[0];
    expect(phases.preparation.navigation_digest).toBe(digest(ORIGINAL));
    expect(phases.preparation.supplemental?.[0]).toMatchObject({ navigation_digest: digest(hint), submitted_inputs: 1 });
    expect(first.nominations.find(row => row.source.source_id === "z-vector"))
      .toMatchObject({ lexical: [], vector: { rank: 1, cosine: 1 } });
    expect(second?.result?.nominations.find(row => row.source.source_id === "z-vector"))
      .toMatchObject({ vector: { rank: 1, cosine: 0 } });
    expect(second?.allowance.max_attempts).toBe(phases.acquisition.allowance.max_attempts - first.accounting.attempted);
    expect(second?.allowance.max_roots).toBe(phases.acquisition.allowance.max_roots - first.nominations.length);
    expect(second?.allowance.max_vector_windows).toBe(phases.acquisition.allowance.max_vector_windows - first.vector.inspected_windows);
    expect(second!.budget.work_units).toBeLessThanOrEqual(phases.acquisition.budget.work_units - first.resources.work);
    expect(result.access?.source_candidates.filter(row => row.source_id === "z-vector")).toHaveLength(1);
    expect(result.access?.source_candidates.find(row => row.source_id === "z-vector")?.complete).toBe(true);
    expect(fixture.queryBinding.embedInputs.mock.calls.map(([inputs]) => inputs[0]?.text)).toEqual([ORIGINAL, hint]);
    const reused = await workerCall(client, { ...recall, query_handle: result.query_handle! });
    expect(reused.discovery.access?.pool_id).toBe(result.access?.pool_id);
    expect(reused.discovery.access?.phases).toEqual(result.access?.phases);
    expect(sourceSemanticExecutionPhases(SourceSemanticExecutionSchema.parse(reused.execution)).query_preparation.submitted_inputs).toBe(0);
    expect(fixture.queryBinding.embedInputs).toHaveBeenCalledTimes(2);
  });
}, 60_000);

it("preserves completed original nominations and failed hint expenditure with only one canonical hold", async () => {
  await withIndexedSources([{ id: "raw", text: RAW, vector: [1, 0, 0] }], async fixture => {
    const prepared = await fixture.prepareQuery({ navigation: ORIGINAL, supplemental_navigation: "Harbor",
      signal: new AbortController().signal, remainingMs: () => 60_000 });
    const read = SqliteSourceIndexRepository.prototype.readLexicalCandidates;
    let reads = 0;
    vi.spyOn(SqliteSourceIndexRepository.prototype, "readLexicalCandidates").mockImplementation(function (this: SqliteSourceIndexRepository, ...args) {
      if (++reads === 2) throw new Error("injected SQLite lexical read failure");
      return read.apply(this, args);
    });
    const meter = new SourceSemanticReadBudget(QUERY_BUDGET), metadataMeter = new SourceSemanticReadBudget(QUERY_BUDGET);
    const holds = vi.spyOn(meter, "hold");
    const policy = createSourceSemanticAccessPolicy(ORIGINAL, undefined, "query-conditioned-v1", metadataMeter);
    const result = fixture.database.connection.transaction(() => acquireSourceSemanticIndex({ runtime: runtime(fixture), workspace: WS,
      navigation: ORIGINAL, vector: prepared.vector, supplemental: { navigation: "Harbor", vector: prepared.supplemental!.vector },
      authorized: ["project"], meter, metadataMeter, canonicalBytes: Buffer.byteLength(RAW), sourceCost: policy.sourceCost }))();
    try {
      const phase = checkedAcquisitionCapture(result, meter), hint = phase.supplemental![0]!;
      expect(phase.status).toBe("executed");
      expect(result.nominations.map(row => row.source_id)).toEqual(["raw"]);
      expect(hint).toMatchObject({ status: "failed", accounting: "partial", result: { nominations: [], resource_refusals: [
        { stage: "lexical", phase: "acquisition_failed_unknown_additional_cost" }] } });
      expect(hint.result!.resources.work).toBeGreaterThan(0);
      expect(meter.indexWork).toBe(phase.result!.resources.work + hint.result!.resources.work);
      expect(meter.nativeBytes).toBe(phase.result!.resources.native_bytes + hint.result!.resources.native_bytes);
      expect(holds).toHaveBeenCalledTimes(1);
    } finally { result.releaseCanonical(); }
  });
});

it("does not refill the root allowance for a hint after original native discovery fills it", async () => {
  await withIndexedSources(Array.from({ length: 16 }, (_, index) => ({ id: `root-${index}`, text: `Berth ${index}.`,
    vector: [1, 0, 0] })), async fixture => {
    const prepared = await fixture.prepareQuery({ navigation: ORIGINAL, supplemental_navigation: "Unrelated irrigation",
      signal: new AbortController().signal, remainingMs: () => 60_000 });
    const meter = new SourceSemanticReadBudget(QUERY_BUDGET), metadataMeter = new SourceSemanticReadBudget(QUERY_BUDGET);
    const policy = createSourceSemanticAccessPolicy(ORIGINAL, undefined, "query-conditioned-v1", metadataMeter);
    const result = fixture.database.connection.transaction(() => acquireSourceSemanticIndex({ runtime: runtime(fixture), workspace: WS,
      navigation: ORIGINAL, vector: prepared.vector, supplemental: { navigation: "Unrelated irrigation", vector: prepared.supplemental!.vector },
      authorized: ["project"], meter, metadataMeter, canonicalBytes: 8, sourceCost: policy.sourceCost }))();
    try {
      const phase = checkedAcquisitionCapture(result, meter);
      expect(phase.result?.nominations).toHaveLength(16);
      expect(result.nominations).toHaveLength(16);
      expect(phase.supplemental?.[0]).toMatchObject({ status: "not_run", reason: "shared_nomination_allowance",
        allowance: { max_roots: 0 }, result: null });
      expect(meter.indexWork).toBe(phase.result!.resources.work);
      expect(prepared.supplemental?.receipt).toMatchObject({ submitted_inputs: 1, status: "ready" });
    } finally { result.releaseCanonical(); }
  });
});

it("keeps original nominations and remaining hint budget when union references exhaust before the distinct hint", async () => {
  await withIndexedSources([{ id: "raw", text: RAW, vector: [1, 0, 0] }], async fixture => {
    const prepared = await fixture.prepareQuery({ navigation: ORIGINAL, supplemental_navigation: "Harbor",
      signal: new AbortController().signal, remainingMs: () => 60_000 });
    const meter = new SourceSemanticReadBudget(QUERY_BUDGET), metadataMeter = new SourceSemanticReadBudget(QUERY_BUDGET);
    const policy = createSourceSemanticAccessPolicy(ORIGINAL, undefined, "query-conditioned-v1", metadataMeter);
    const charge = meter.charge.bind(meter);
    vi.spyOn(meter, "charge").mockImplementation(function (this: SourceSemanticReadBudget, work, bytes, phase) {
      if (phase === "source route union references") throw new SourceSemanticResourceExhausted("source route union references");
      return charge(work, bytes, phase);
    });
    const result = fixture.database.connection.transaction(() => acquireSourceSemanticIndex({ runtime: runtime(fixture), workspace: WS,
      navigation: ORIGINAL, vector: prepared.vector, supplemental: { navigation: "Harbor", vector: prepared.supplemental!.vector },
      authorized: ["project"], meter, metadataMeter, canonicalBytes: Buffer.byteLength(RAW), sourceCost: policy.sourceCost }))();
    try {
      const phase = checkedAcquisitionCapture(result, meter), hint = phase.supplemental![0]!, remaining = meter.remaining();
      expect(phase.status).toBe("executed");
      expect(result.nominations.map(row => row.source_id)).toEqual(["raw"]);
      expect(remaining.work_units).toBeGreaterThan(0);
      expect(remaining.memory_bytes).toBeGreaterThan(0);
      expect(hint).toMatchObject({ status: "not_run", reason: "source route union references", result: null,
        allowance: { max_attempts: expect.any(Number), max_roots: expect.any(Number), max_vector_windows: expect.any(Number) },
        budget: remaining });
      expect(hint.allowance.max_attempts).toBeGreaterThan(0);
      expect(hint.allowance.max_roots).toBeGreaterThan(0);
      expect(hint.budget).not.toEqual({ work_units: 0, memory_bytes: 0 });
      expect(hint.reason).not.toBe("supplemental_route_allowance");
    } finally { result.releaseCanonical(); }
  });
});

it("admits an overlapping source identity once while keeping both route occurrence receipts", async () => {
  await withIndexedSources([{ id: "raw", text: RAW, vector: [1, 0, 0] }], async fixture => {
    const prepared = await fixture.prepareQuery({ navigation: ORIGINAL, supplemental_navigation: "Harbor",
      signal: new AbortController().signal, remainingMs: () => 60_000 });
    const meter = new SourceSemanticReadBudget(QUERY_BUDGET), metadataMeter = new SourceSemanticReadBudget(QUERY_BUDGET);
    const policy = createSourceSemanticAccessPolicy(ORIGINAL, undefined, "query-conditioned-v1", metadataMeter);
    const result = fixture.database.connection.transaction(() => acquireSourceSemanticIndex({ runtime: runtime(fixture), workspace: WS,
      navigation: ORIGINAL, vector: prepared.vector, supplemental: { navigation: "Harbor", vector: prepared.supplemental!.vector },
      authorized: ["project"], meter, metadataMeter, canonicalBytes: Buffer.byteLength(RAW), sourceCost: policy.sourceCost }))();
    try {
      const phase = checkedAcquisitionCapture(result, meter);
      const original = phase.result?.nominations.find(row => row.source.source_id === "raw");
      const hinted = phase.supplemental?.[0]?.result?.nominations.find(row => row.source.source_id === "raw");
      expect(original?.source.root_key).toBe(hinted?.source.root_key);
      expect(original?.vector).toMatchObject({ rank: 1, cosine: 1 });
      expect(hinted?.lexical.length).toBeGreaterThan(0);
      expect(result.nominations.map(row => row.source_id)).toEqual(["raw"]);
      const catalog = vi.spyOn(SqliteFieldSourceRecordRepo.prototype, "findCurrentBounded");
      const catalogMeter = new SourceSemanticReadBudget(QUERY_BUDGET);
      fixture.database.connection.transaction(() => listEligibleSemanticSources(fixture.database, WS, catalogMeter, ["project"], [], {
        nominations: result.nominations, beforeRetain: () => undefined }))();
      expect(catalog.mock.calls.filter(call => call[1] === "raw")).toHaveLength(1);
    } finally { result.releaseCanonical(); }
  });
});

it("holds capacity without spending it and absorbs index native bytes exactly once at adjacent resource boundaries", () => {
  const resources = { work: 17, memory_bytes: 513, native_bytes: 97, sql_internal_work: "unknown" as const };
  const child = new SourceSemanticReadBudget({ work_units: 28, memory_bytes: 596 });
  const release = child.hold({ work_units: 11, memory_bytes: 83 });
  expect(child.remaining()).toEqual({ work_units: 17, memory_bytes: 513 });
  expect([child.spentWork, child.spentBytes, child.nativeBytes]).toEqual([0, 0, 0]);
  child.absorbIndex(resources);
  expect([child.spentWork, child.spentBytes, child.nativeWork, child.nativeBytes, child.indexWork]).toEqual([17, 513, 0, 97, 17]);
  release(); release();
  expect(child.remaining()).toEqual({ work_units: 11, memory_bytes: 83 });
  const parent = new SourceSemanticReadBudget({ work_units: 17, memory_bytes: 513 });
  parent.absorb(child);
  expect([parent.spentWork, parent.spentBytes, parent.nativeBytes, parent.indexWork]).toEqual([17, 513, 97, 17]);
  expect(parent.remaining()).toEqual({ work_units: 0, memory_bytes: 0 });
  for (const budget of [{ work_units: 16, memory_bytes: 513 }, { work_units: 17, memory_bytes: 512 }]) {
    const short = new SourceSemanticReadBudget(budget);
    expect(() => short.absorbIndex(resources)).toThrow(SourceSemanticResourceExhausted);
    expect([short.spentWork, short.spentBytes, short.nativeBytes, short.indexWork]).toEqual([0, 0, 0, 0]);
  }
});
