import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => { isolation.restore(); });
import BetterSqlite3 from "better-sqlite3";
import { sourceSemanticAccessPhases, sourceSemanticAcquisitionNotRun, sourceSemanticExecution, sourceSemanticExecutionPhases,
  sourceDisclosure, qualifySourceDisclosure, hashLabeledIdentity, SourceSemanticResourceExhausted, unavailableSourceQueryPreparation,
  type SourceSemanticAcquisitionPhase } from "@do-soul/alaya-protocol";
import { encodeSourceSemanticLibraryResponse, sourceGoldRootIdentity, sourceSemanticLibrarySourceEntry, SourceIndexAcquisition,
  type SourceSemanticLibraryPackage } from "@do-soul/alaya-core";
import { SqliteFieldEraseBarrierRepo, SqliteSourceIndexRepository } from "@do-soul/alaya-storage";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { prepareLibraryPackages } from "../../../runtime/recall-read-worker/source-semantic-library-packages.js";
import { prepareNominatedLibraryWindows, type LibrarySourceNomination }
  from "../../../runtime/recall-read-worker/source-semantic-library-nominated-windows.js";
import { projectResearchNativeProposals, researchNativeProposalSelector, compareResearchNominatedSourceLibrary,
  captureResearchNominatedSourceDelivery, ResearchSourceAcquisitionReplySchema, ResearchSourceDeliveryDiagnosticsSchema }
  from "../../../runtime/recall-read-worker/source-semantic-research-nominated-library.js";
import * as candidateAccess from "../../../runtime/recall-read-worker/source-semantic-candidate-access.js";
import * as researchDelivery from "../../../runtime/recall-read-worker/source-semantic-research-nominated-library.js";
import * as nominatedWindows from "../../../runtime/recall-read-worker/source-semantic-library-nominated-windows.js";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { runSourceSemanticWorker } from "../../../runtime/recall-read-worker/source-semantic-reasoning.js";
import { complementaryProofSelectionFixture, rawSourceTwin }
  from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-selection-fixture.js";
import { query as incompatibleQuery } from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-proof-fixture.js";
import { nominatedLibraryContext, censusNominatedLibraryContext, compareInGuardedWorker, BODY, CONDITION, ANSWER, ORIGINAL, digest, ACCESS_BUDGET, CLOCK, WS,
  type NominatedLibraryContext } from "./source-semantic-nominated-library.test-support.js";

function captured(context: NominatedLibraryContext) {
  const phase = sourceSemanticAccessPhases(context.pool.access).acquisition;
  const nomination = phase.result!.nominations.find(row => row.source.source_id === "answer")!;
  expect(nomination.vector!.window.start_byte).toBe(8192);
  const entries = context.pool.sources.map(record => sourceSemanticLibrarySourceEntry({ workspaceId: WS,
    root_id: record.identity, source_version: record.source_version, content_digest: record.content_digest,
    evidence_object_id: record.evidence_object_id, hypothesis_id: "research-source" }));
  return { phase, nomination, entries };
}
function hydrate(context: NominatedLibraryContext, nominations: readonly LibrarySourceNomination[]) {
  return prepareNominatedLibraryWindows(context.runtime, context.payload, ["project"], new SourceSemanticReadBudget(ACCESS_BUDGET),
    captured(context).entries, nominations);
}
function relocated(nomination: LibrarySourceNomination, start: number, end: number): LibrarySourceNomination {
  return { ...nomination, vector: { ...nomination.vector!, window: { ...nomination.vector!.window,
    start_byte: start, end_byte: end, content_digest: digest(Buffer.from(BODY).subarray(start, end).toString("utf8")) } } };
}

it("hydrates every located census window within the original hydration allowance without changing baseline prefixes", async () => {
  const context = await censusNominatedLibraryContext();
  // Frozen first-request hydration allowance, not a larger quota or a new divisor.
  const allowance = { work_units: 1_533_996, memory_bytes: 8_740_785 };
  try {
    expect(context.sources).toHaveLength(475);
    expect(context.bodies.reduce((sum, body) => sum + body.length, 0)).toBe(498_652);
    expect(context.nominations.reduce((sum, row) => sum + row.vector!.window.end_byte - row.vector!.window.start_byte, 0)).toBe(5_344);
    context.database.connection.transaction(() => {
      const prefixMeter = new SourceSemanticReadBudget(allowance), nominatedMeter = new SourceSemanticReadBudget(allowance);
      const prefix = prepareLibraryPackages(context.runtime, context.payload, ["project"], prefixMeter, context.sources, []);
      const nominated = prepareLibraryPackages(context.runtime, context.payload, ["project"], nominatedMeter,
        context.sources, [], context.nominations);
      expect(prefix.incomplete).toBe(false);
      expect(prefix.packages).toHaveLength(475);
      expect(prefixMeter.spentWork).toBeGreaterThan(1_490_000);
      expect(nominated.incomplete).toBe(false);
      expect(nominated.packages).toHaveLength(491);
      const variants = nominated.packages.filter(row => row.entry.target.kind === "source_evidence"
        && row.entry.target.span!.content_start > 0);
      expect(variants).toHaveLength(16); // Null/partial preparation is not success.
      expect(nominated.packages.filter(row => !variants.includes(row))).toEqual(prefix.packages);
      for (const [position, row] of variants.entries()) {
        const span = row.entry.target.kind === "source_evidence" ? row.entry.target.span! : undefined;
        expect(span).toBeDefined();
        expect(span!.content_start).toBe(context.nominations[position]!.vector!.window.start_byte);
        expect(row.preview).toBe(Buffer.from(context.bodies[position]!).subarray(span!.content_start, span!.content_end).toString("utf8"));
        expect(row.proofs).toEqual([]);
        expect(row.access_position).toBe(position);
      }
      expect(nominatedMeter.spentWork).toBeLessThanOrEqual(allowance.work_units);
      expect(nominatedMeter.spentWork - prefixMeter.spentWork).toBeLessThanOrEqual(35_092);
      expect(nominatedMeter.spentBytes).toBeLessThanOrEqual(allowance.memory_bytes);
      expect(() => prepareLibraryPackages(context.runtime, context.payload, ["project"],
        new SourceSemanticReadBudget({ ...allowance, work_units: prefixMeter.spentWork + 1_000 }),
        context.sources, [], context.nominations)).toThrow(SourceSemanticResourceExhausted);
    })();
  } finally { await context.close(); }
}, 60_000);

it("keeps nomination order and duplicate windows before the first raw alias of a source tuple", async () => {
  const context = await nominatedLibraryContext();
  try {
    const { nomination, entries } = captured(context);
    const source = entries.find(entry => entry.target.kind === "source_evidence"
      && sourceGoldRootIdentity(entry.target) === nomination.source.root_key)!;
    const sources = [source, { ...source, hypothesis_id: "source-alias" }, ...entries.filter(entry => entry !== source)];
    const first = relocated(nomination, 8192, 8220), second = relocated(nomination, 8200, 8230);
    const result = context.database.connection.transaction(() => prepareLibraryPackages(context.runtime, context.payload,
      ["project"], new SourceSemanticReadBudget(ACCESS_BUDGET), sources, [], [second, first, second]))();
    expect(result.incomplete).toBe(false);
    const position = result.packages.filter(row => row.access_position === 0);
    expect(position.map(row => row.entry.target.kind === "source_evidence" && row.entry.target.span!.content_start))
      .toEqual([8200, 8192, 8200, 0]);
    expect(position[0]).not.toBe(position[2]); // Same nomination object still produces two legal variants.
    expect(position.every(row => row.entry.hypothesis_id === source.hypothesis_id)).toBe(true);
    expect(result.packages.filter(row => row.access_position === 1)).toHaveLength(1);
    expect(result.packages.find(row => row.access_position === 1)!.entry.hypothesis_id).toBe("source-alias");
  } finally { await context.close(); }
});

it.each(["absent", "invalid"] as const)("exposes actual non-prefix bytes with Q %s in a guarded SQLite worker, without changing public O1", async mode => {
  const context = await nominatedLibraryContext(mode === "invalid" ? incompatibleQuery("a different original question") : undefined);
  try {
    const { nomination } = captured(context);
    expect(nomination.lexical).toEqual([]); // Vector navigation is the only located nomination.
    const comparison = await compareInGuardedWorker(context);
    expect(comparison.kind).toBe("PRIVATE_COUNTERFACTUAL");
    expect(comparison.query_semantics_status).toMatchObject({ status: "unavailable", reason: mode });
    const prefix = comparison.hydration.prefix, nominated = comparison.hydration.nominated;
    const resultOf = (arm: typeof prefix) => arm.artifact.results!.find(row => row.target.kind === "source_evidence"
      && row.target.root_id === nomination.source.target.root_id)!;
    expect(resultOf(prefix)).toBeDefined();
    expect(resultOf(prefix).content_preview).not.toContain(ANSWER); // Root hit is not answer exposure.
    expect(resultOf(nominated).content_preview).toContain(CONDITION + ANSWER);
    for (const arm of [prefix, nominated, ...Object.values(comparison.ordering)]) {
      expect(arm.kind).toBe("PRIVATE_COUNTERFACTUAL");
      for (const field of ["order", "operation", "delivery_id", "request_identity", "protocol_version"]) {
        expect(arm.artifact).not.toHaveProperty(field);
      }
      expect(arm.artifact.index).not.toHaveProperty("continuation");
      expect(arm.full_envelope_bytes).toBeLessThanOrEqual(300_000);
      const execution = sourceSemanticExecutionPhases(arm.artifact.execution!);
      const capturedPhases = sourceSemanticAccessPhases(context.pool.access);
      expect(execution.query_preparation).toEqual(capturedPhases.preparation);
      expect(execution.acquisition).toEqual(capturedPhases.acquisition);
      expect(arm.artifact.proofs ?? []).toEqual([]);
      expect(arm.artifact.coverage?.conditional_computation).toBe("unexercised");
      for (const row of arm.artifact.results!) {
        expect(sourceDisclosure(row.source_disclosure!).proof_use).toEqual({ kind: "source_only", qualification: "not_current_proof" });
        expect(row.budget_state.within_budget).toBe(true);
        const target = row.target;
        if (target.kind !== "source_evidence" || target.span === undefined) throw new Error("actual delivered interval required");
        const original = context.records.find(record => record.identity === target.root_id)!;
        const body = original.source_id === "answer" ? BODY : `User: unrelated granite wall ${original.source_id.at(-1)}.`;
        const bytes = Buffer.from(body).subarray(target.span.content_start, target.span.content_end);
        expect(bytes.toString("utf8")).toBe(row.content_preview);
        expect(bytes.length).toBe(Buffer.byteLength(row.content_preview));
      }
    }
    expect(comparison.ordering.o1.package_repertoire).toEqual(comparison.ordering.access.package_repertoire);
    expect(comparison.ordering.native.package_repertoire).toEqual(comparison.ordering.o1.package_repertoire);
    expect(comparison.ordering.native.output_byte_limit).toBe(comparison.ordering.o1.output_byte_limit);
    const window = resultOf(nominated).target;
    expect(window.kind === "source_evidence" && window.span?.content_start).toBe(8192);
  } finally { await context.close(); }
}, 60_000);

it("matches prefix O1 at a tight cap where omitting captured phase bytes would admit the full first page", async () => {
  const context = await nominatedLibraryContext();
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  const ordinary = () => {
    const result = runSourceSemanticWorker(context.runtime, context.payload);
    if (result.kind !== "recall") throw new Error("ordinary library recall required");
    return result;
  };
  try {
    const roomy = ordinary();
    expect(roomy.index.entries).toHaveLength(5);
    expect(roomy.execution).not.toBe("native_reasoning_only");
    const capturedExecution = sourceSemanticExecution(context.meter.preparation, context.meter.acquisition);
    // Independent mandatory-envelope quote: original phases, maximum work, no optional source time.
    const mandatory = encodeSourceSemanticLibraryResponse({ ...roomy, execution: capturedExecution,
      source_disclosures: Object.fromEntries(Object.entries(roomy.source_disclosures).map(([key, value]) =>
        [key, qualifySourceDisclosure(value, sourceDisclosure(value).proof_use.kind, false)])),
      work: { native_work: ACCESS_BUDGET.work_units, index_work: ACCESS_BUDGET.work_units,
        native_accounting: "partial", logical_work: ACCESS_BUDGET.work_units,
        native_bytes: ACCESS_BUDGET.memory_bytes, logical_memory_bytes: ACCESS_BUDGET.memory_bytes,
        rss_bytes: Number.MAX_SAFE_INTEGER }
    });
    // Negative control only: dropping the actual phases makes all five roots appear to fit.
    const omittedPhases = { ...mandatory, execution: "native_reasoning_only" as const };
    const limit = bytes(omittedPhases);
    expect(bytes(mandatory)).toBeGreaterThan(limit);
    if (context.payload.request.kind !== "recall") throw new Error("direct recall request required");
    context.payload = { ...context.payload, request: { ...context.payload.request, output_byte_limit: limit } };
    const native = ordinary(), encoded = encodeSourceSemanticLibraryResponse(native);
    if (encoded.operation !== "recall") throw new Error("public recall envelope required");
    expect(native.index.entries.length).toBeGreaterThan(0);
    expect(native.index.entries.length).toBeLessThan(roomy.index.entries.length);
    expect(bytes(encoded)).toBeLessThanOrEqual(limit);
    const comparison = await compareInGuardedWorker(context), prefix = comparison.hydration.prefix;
    expect(prefix.artifact.index.entries).toEqual(native.index.entries);
    expect(prefix.artifact.results!.map(row => [row.target, row.content_preview]))
      .toEqual(encoded.results!.map(row => [row.target, row.content_preview]));
    for (const arm of [prefix, comparison.hydration.nominated, ...Object.values(comparison.ordering)]) {
      expect(arm.artifact.execution).toEqual(capturedExecution);
      expect(arm.full_envelope_bytes).toBeLessThanOrEqual(limit);
    }
  } finally { await context.close(); }
}, 60_000);

it("composes private fitted non-prefix text from one live observation and one prepared finite-vector call", async () => {
  const context = await nominatedLibraryContext();
  let peer: BetterSqlite3.Database | undefined;
  const observation = vi.spyOn(candidateAccess, "observeSourceSemanticAccess");
  const preparation = vi.spyOn(SourceIndexAcquisition, "prepareQuery");
  const embedded = vi.fn(async (inputs: readonly { input_id: string; text: string }[]) => inputs.map(input => ({
    status: "embedded" as const, input_id: input.input_id, input_digest: digest(input.text),
    vector: new Float32Array([1, 0, 0]), token_count: 2, truncated: false as const
  })));
  try {
    const state = new SqliteSourceIndexRepository(context.database, fieldContractSha256).state(WS);
    if (!("selection" in state)) throw new Error("authored source selection required");
    const prepared = await SourceIndexAcquisition.prepareQuery({ navigation: ORIGINAL, selection: state.selection,
      signal: new AbortController().signal, remainingMs: () => 60_000,
      bind: async () => ({ status: "ready", profile: state.selection.configuration.profile,
        profile_id: state.selection.profile_id, embedInputs: embedded }) });
    expect(prepared.receipt.status).toBe("ready");
    context.database.connection.exec("CREATE TABLE recall_snapshot_probe (value INTEGER NOT NULL); INSERT INTO recall_snapshot_probe VALUES (0)");
    // Use a genuinely independent connection, not initDatabase's per-file cache.
    peer = new BetterSqlite3(context.filename);
    context.database.connection.exec("BEGIN DEFERRED");
    expect(context.database.connection.prepare("SELECT value FROM recall_snapshot_probe").get()).toEqual({ value: 0 });
    peer.prepare("UPDATE recall_snapshot_probe SET value = 1").run();
    expect(peer.prepare("SELECT value FROM recall_snapshot_probe").get()).toEqual({ value: 1 });
    const reply = runSourceSemanticWorker(context.runtime, { ...context.payload, prepared_query: prepared, acquisition_control: "dual" });
    if (reply.kind !== "research_acquisition") throw new Error("private recall wrapper required");
    expect(ResearchSourceAcquisitionReplySchema.safeParse(reply).success).toBe(true);
    expect(context.database.connection.inTransaction).toBe(true);
    // Repository transaction helpers may use nested savepoints. A replaced outer
    // snapshot would expose the independently committed value instead of zero.
    expect(context.database.connection.prepare("SELECT value FROM recall_snapshot_probe").get()).toEqual({ value: 0 });
    expect(preparation).toHaveBeenCalledTimes(1);
    expect(embedded).toHaveBeenCalledTimes(1);
    expect(observation).toHaveBeenCalledTimes(1);
    expect(observation.mock.calls[0]![0]).toBe(context.runtime);
    const diagnostics = reply.private_delivery;
    expect(diagnostics.status).toBe("complete");
    const prefix = diagnostics.comparison!.hydration.prefix!, nominated = diagnostics.comparison!.hydration.nominated!;
    expect(prefix.artifact.results!.some(row => row.content_preview?.includes(ANSWER))).toBe(false);
    const delivered = nominated.artifact.results!.find(row => row.content_preview?.includes(CONDITION + ANSWER))!;
    expect(delivered).toBeDefined();
    if (delivered.target.kind !== "source_evidence" || delivered.target.span === undefined) throw new Error("located original-body text required");
    expect(delivered.target.span.content_start).toBe(8192);
    expect(delivered.content_preview).toBe(Buffer.from(BODY).subarray(delivered.target.span.content_start, delivered.target.span.content_end).toString("utf8"));
    expect(sourceDisclosure(delivered.source_disclosure!).proof_use).toEqual({ kind: "source_only", qualification: "not_current_proof" });
    expect(reply.result.previews && Object.values(reply.result.previews).some(text => text.includes(ANSWER))).toBe(false);
    expect(reply.result).not.toHaveProperty("private_delivery");
    expect(reply).not.toHaveProperty("execution");
    expect(reply).not.toHaveProperty("work");
    expect(Buffer.byteLength(JSON.stringify(reply))).toBeGreaterThan(Buffer.byteLength(JSON.stringify(reply.result)));
    expect(diagnostics.captured.work.logical_work).toBeGreaterThan(0);
    expect(diagnostics.captured.work.index_work).toBeGreaterThan(0);
    for (const cost of diagnostics.costs) {
      expect(cost.work.logical_work).toBeGreaterThanOrEqual(diagnostics.captured.work.logical_work!);
      expect(cost.work.native_work).toBeGreaterThanOrEqual(diagnostics.captured.work.native_work);
      expect(cost.work.index_work).toBe(diagnostics.captured.work.index_work);
    }
    for (const arm of [prefix, nominated, ...Object.values(diagnostics.comparison!.ordering)]) {
      expect(arm!.artifact.execution).toEqual(diagnostics.captured.execution);
      expect(arm!.full_envelope_bytes).toBeLessThanOrEqual(arm!.output_byte_limit);
      expect(arm!.artifact).not.toHaveProperty("delivery_id");
      expect(arm!.artifact.index).not.toHaveProperty("continuation");
    }
    context.database.connection.exec("ROLLBACK");
    expect(context.database.connection.inTransaction).toBe(false);
    expect(context.database.connection.prepare("SELECT value FROM recall_snapshot_probe").get()).toEqual({ value: 1 });
    observation.mockClear();
    const ordinary = runSourceSemanticWorker(context.runtime, { ...context.payload, prepared_query: prepared });
    expect(ordinary.kind).toBe("recall");
    expect(ordinary).not.toHaveProperty("private_delivery");
    expect(ordinary).not.toHaveProperty("result");
    expect(observation).toHaveBeenCalledTimes(1);
    expect(preparation).toHaveBeenCalledTimes(1);
    expect(embedded).toHaveBeenCalledTimes(1);
  } finally {
    if (context.database.connection.inTransaction) context.database.connection.exec("ROLLBACK");
    peer?.close();
    vi.restoreAllMocks(); await context.close();
  }
});

it("retains native recall and completed prefix costs when nominated hydration exhausts its own fork", async () => {
  const context = await nominatedLibraryContext();
  const hydrateWindow = vi.spyOn(nominatedWindows, "prepareNominatedLibraryWindows").mockImplementation((_runtime, _payload, _authorized, meter) => {
    meter.charge(7, 11, "authored nominated hydration failure");
    throw new SourceSemanticResourceExhausted("authored nominated hydration failure");
  });
  try {
    // Lexical control needs no embedding, and the real observation remains source-only.
    const prepared = { receipt: unavailableSourceQueryPreparation(SourceIndexAcquisition.channelNotRequested, "not_requested"),
      vector: { status: "unavailable" as const, reason: SourceIndexAcquisition.channelNotRequested } };
    const reply = runSourceSemanticWorker(context.runtime, { ...context.payload, prepared_query: prepared, acquisition_control: "lexical" });
    if (reply.kind !== "research_acquisition") throw new Error("private recall wrapper required");
    expect(reply.result.kind).toBe("recall");
    expect(reply.result.index.entries.length).toBeGreaterThan(0);
    const diagnostics = reply.private_delivery;
    expect(ResearchSourceDeliveryDiagnosticsSchema.safeParse(diagnostics).success).toBe(true);
    expect(diagnostics.status).toBe("partial");
    expect(diagnostics.failure).toMatchObject({ phase: "authored nominated hydration failure" });
    expect(diagnostics.comparison!.hydration.prefix).not.toBeNull();
    expect(diagnostics.comparison!.hydration.nominated).toBeNull();
    expect(diagnostics.costs.find(row => row.phase === "nominated_preparation")!.work.logical_work)
      .toBeGreaterThan(diagnostics.captured.work.logical_work! + 7);
    expect(diagnostics.costs.some(row => row.phase === "prefix")).toBe(true);
    expect(hydrateWindow).toHaveBeenCalledTimes(1);
  } finally { vi.restoreAllMocks(); await context.close(); }
});

it("captures native work and execution before diagnostics without resampling process RSS afterward", async () => {
  const context = await nominatedLibraryContext();
  const nativeRss = 999, diagnosticProcessRss = 1_000_000_000;
  const memoryUsage = process.memoryUsage, captureDiagnostics = researchDelivery.captureResearchNominatedSourceDelivery;
  let diagnosticStarted = false, samplesAtDiagnosticEnd = -1;
  const samples = vi.spyOn(process, "memoryUsage").mockImplementation(() => ({
    ...memoryUsage(), rss: diagnosticStarted ? diagnosticProcessRss : nativeRss
  }));
  const diagnostics = vi.spyOn(researchDelivery, "captureResearchNominatedSourceDelivery").mockImplementation((...args) => {
    expect(context.database.connection.inTransaction).toBe(true);
    diagnosticStarted = true;
    const captured = captureDiagnostics(...args);
    samplesAtDiagnosticEnd = samples.mock.calls.length;
    return captured;
  });
  try {
    const payload = { ...context.payload, prepared_query: {
      receipt: unavailableSourceQueryPreparation(SourceIndexAcquisition.channelNotRequested, "not_requested"),
      vector: { status: "unavailable" as const, reason: SourceIndexAcquisition.channelNotRequested }
    } };
    const reply = runSourceSemanticWorker(context.runtime, { ...payload, acquisition_control: "lexical" });
    if (reply.kind !== "research_acquisition") throw new Error("private recall wrapper required");
    expect(diagnostics).toHaveBeenCalledTimes(1);
    expect(reply.result.work.rss_bytes).toBe(nativeRss);
    expect(Object.isFrozen(reply.result.work)).toBe(true);
    expect(samples.mock.calls.length).toBe(samplesAtDiagnosticEnd);
    expect(reply.result.execution).toEqual(reply.private_delivery.captured.execution);
    expect(sourceSemanticExecutionPhases(reply.result.execution!).query_preparation)
      .toMatchObject({ status: "not_requested", reason: SourceIndexAcquisition.channelNotRequested, submitted_inputs: 0 });
    expect(sourceSemanticExecutionPhases(reply.result.execution!).acquisition.result?.vector.completion).toBe("not_run");
    // Diagnostic RSS still samples this process; it is not an isolated allocation delta.
    expect(reply.private_delivery.captured.work.rss_bytes).toBe(diagnosticProcessRss);
    expect(reply.private_delivery.costs.length).toBeGreaterThan(0);
    for (const cost of reply.private_delivery.costs) expect(cost.work.rss_bytes).toBe(diagnosticProcessRss);
    diagnosticStarted = false;
    const ordinary = runSourceSemanticWorker(context.runtime, payload);
    if (ordinary.kind !== "recall") throw new Error("ordinary native recall required");
    expect(ordinary.work.rss_bytes).toBe(nativeRss);
    expect(diagnostics).toHaveBeenCalledTimes(1);
  } finally { vi.restoreAllMocks(); await context.close(); }
});

it("distinguishes unattempted live-pool absence from lexical comparison without located nominations", async () => {
  const context = await nominatedLibraryContext();
  try {
    const noPool = captureResearchNominatedSourceDelivery(context.database, context.payload, undefined, context.meter);
    expect(noPool).toMatchObject({ status: "not_run", comparison: null, failure: null, costs: [] });
    expect(noPool.captured.work.logical_work).toBe(context.meter.spentWork);
    const reply = runSourceSemanticWorker(context.runtime, { ...context.payload, acquisition_control: "lexical", prepared_query: {
      receipt: unavailableSourceQueryPreparation(SourceIndexAcquisition.channelNotRequested, "not_requested"),
      vector: { status: "unavailable", reason: SourceIndexAcquisition.channelNotRequested }
    } });
    if (reply.kind !== "research_acquisition") throw new Error("private recall wrapper required");
    expect(reply.private_delivery).toMatchObject({ status: "unavailable", reason: "no_located_nominations", failure: null });
    expect(reply.private_delivery.comparison!.hydration.prefix).not.toBeNull();
    expect(reply.private_delivery.comparison!.hydration.nominated!.artifact.results!.some(row => row.content_preview?.includes(ANSWER))).toBe(false);
    expect(reply.private_delivery.costs.length).toBeGreaterThan(0);
  } finally { await context.close(); }
});

it("rejects changed source tuples, record/logical-source confusion, digest, scope and erased bytes rather than redirecting", async () => {
  const context = await nominatedLibraryContext();
  try {
    const { nomination, entries } = captured(context);
    expect(nomination.source.target.root_id).not.toBe(nomination.source.source_id);
    for (const change of [{ source_version: "wrong" }, { root_id: nomination.source.source_id }, { content_digest: digest("wrong body") }]) {
      const target = { ...nomination.source.target, ...change };
      expect(() => hydrate(context, [{ ...nomination, source: { ...nomination.source, target, root_key: sourceGoldRootIdentity(target) } }]))
        .toThrow(/source pool/u);
    }
    expect(() => hydrate(context, [{ ...nomination, source: { ...nomination.source, source_id: "other-0" } }])).toThrow(/current source record/u);
    expect(() => hydrate(context, [{ ...nomination, vector: { ...nomination.vector!, window: {
      ...nomination.vector!.window, content_digest: digest("wrong window") } } }])).toThrow(/window digest/u);
    expect(() => prepareNominatedLibraryWindows(context.runtime, context.payload, [], new SourceSemanticReadBudget(ACCESS_BUDGET),
      entries, [nomination])).toThrow(/authorized scopes/u);
    const id = nomination.source.target.root_id;
    new SqliteFieldEraseBarrierRepo(context.database, fieldContractSha256).apply({
      identity: hashLabeledIdentity("erase_barrier", [WS, "source_record", id, ""], fieldContractSha256),
      barrier_id: "erase-nominated-source", workspace_id: WS, generation_id: null,
      subject_kind: "source_record", subject_id: id, erased_at: CLOCK
    });
    expect(() => hydrate(context, [nomination])).toThrow(/unavailable|current source record/u);
    expect(() => compareResearchNominatedSourceLibrary(context.database, context.payload, context.pool, context.meter)).toThrow(/revision changed/u);
  } finally { await context.close(); }
});

it("keeps missing lexical locations missing, rejects oversized or split-Unicode coordinates and reports clipped context honestly", async () => {
  const context = await nominatedLibraryContext();
  try {
    const { nomination } = captured(context);
    expect(hydrate(context, [{ ...nomination, vector: null }])).toEqual([]);
    expect(() => hydrate(context, [relocated(nomination, 4096, 8193)])).toThrow(/display bounds/u);
    const emoji = Buffer.byteLength(BODY.slice(0, BODY.indexOf("😀")));
    expect(() => hydrate(context, [relocated(nomination, emoji + 1, emoji + 4)])).toThrow(/unavailable|UTF-8/u);
    expect(() => hydrate(context, [relocated(nomination, emoji, emoji + 3)])).toThrow(/unavailable|UTF-8/u);
    // Cross a physical 4096-byte retained chunk without widening the nominated interval.
    const start = 8000, end = Buffer.byteLength(BODY);
    const [clipped] = hydrate(context, [relocated(nomination, start, end)]);
    expect(clipped!.preview).not.toContain("�");
    expect(Buffer.byteLength(clipped!.preview)).toBeLessThan(end - start);
    expect(clipped!.entry.target).toMatchObject({ span: { content_start: start,
      content_end: start + Buffer.byteLength(clipped!.preview), content_complete: false } });
    const answerStart = 8192 + Buffer.byteLength(CONDITION);
    const [withoutCondition] = hydrate(context, [relocated(nomination, answerStart, answerStart + Buffer.byteLength(ANSWER))]);
    expect(withoutCondition!.preview).toBe(ANSWER);
    expect(withoutCondition!.preview.includes(CONDITION)).toBe(false); // Answer-only is NOT complete-context success.
    const [rootOnly] = hydrate(context, [relocated(nomination, 0, 100)]);
    expect(rootOnly!.preview.includes(ANSWER)).toBe(false);
    expect(rootOnly!.proofs).toEqual([]);
  } finally { await context.close(); }
});

it("preserves global first-fit order, root aliases, legal variants and the labelled legacy remainder without route refill", async () => {
  const authored = complementaryProofSelectionFixture();
  const proof = authored.fixture.pool[0]!, raw = rawSourceTwin(proof);
  const other = rawSourceTwin(authored.fixture.pool.at(-1)!);
  const thirdEntry = sourceSemanticLibrarySourceEntry({ workspaceId: "ws", root_id: "third", source_version: "1",
    content_digest: digest("third"), evidence_object_id: null, hypothesis_id: "research" });
  const legacyEntry = sourceSemanticLibrarySourceEntry({ workspaceId: "ws", root_id: "legacy", source_version: "1",
    content_digest: digest("legacy"), evidence_object_id: null, hypothesis_id: "research" });
  const a = { ...raw, preview: "9", access_position: 3 }, aVariant = { ...raw, preview: "10", access_position: 3 },
    b = { ...other, preview: "4", access_position: 2 }, c = { ...raw, entry: thirdEntry, preview: "4", access_position: 1 },
    legacy = { ...raw, entry: legacyEntry, preview: "100", access_position: 0 };
  const root = (row: SourceSemanticLibraryPackage) => sourceGoldRootIdentity(row.entry.target as typeof nominationTarget);
  const nominationTarget = { kind: "source_evidence" as const, workspace_id: "ws", root_kind: "source_record" as const,
    root_id: "unused", source_version: "1", content_digest: digest("unused"), evidence_object_id: null };
  const nominate = (row: SourceSemanticLibraryPackage) => ({ source: { root_key: root(row), source_id: root(row),
    target: row.entry.target as typeof nominationTarget, body_bytes: 10 }, lexical: [], vector: null });
  const route = (nominations: readonly LibrarySourceNomination[]): SourceSemanticAcquisitionPhase => ({
    ...sourceSemanticAcquisitionNotRun("authored synthetic nomination order"), status: "executed", reason: null,
    accounting: "complete", result: {
      policy: "source-index-interleaved-prefix.v1", navigation_digest: digest("authored navigation"), completion: "complete", nominations,
      accounting: { attempted: nominations.length, admitted: nominations.length, duplicate: 0, rejected: 0, scope_denied: 0,
        native_unknown: 0, resource_refused: 0, stale: 0, nomination_limit: 0 },
      resources: { work: 0, memory_bytes: 0, native_bytes: 0, sql_internal_work: "unknown" }, resource_refusals: [],
      lexical: { completion: "not_run", index_coverage: "partial", reason: "synthetic order only", limitations: [], tokenization: null },
      vector: { completion: "not_run", state: null, reason: "synthetic order only", inspected_windows: 0, invalid_windows: 0,
        validation: "not_run", ranking: "exact_over_inspected_subset", input: { status: "unavailable", reason: "no inference" } },
      limitations: ["authored synthetic order only"]
    }
  });
  const phase = { ...route([nominate(a), nominate(b), nominate(a)]),
    supplemental: [route([nominate(a), nominate(c)])] };
  const candidates = [legacy, a, aVariant, b, c];
  const proposals = projectResearchNativeProposals(candidates, phase, new SourceSemanticReadBudget(ACCESS_BUDGET));
  expect(proposals.map(row => [row.root, row.provenance])).toEqual([[root(a), "primary"], [root(b), "primary"],
    [root(c), "supplemental"], [root(legacy), "legacy-access remainder"]]);
  const select = researchNativeProposalSelector(proposals);
  const run = (capacity: number) => {
    const attempts: string[] = [];
    const page = select({ candidates, meter: new SourceSemanticReadBudget(ACCESS_BUDGET), fits: rows => {
      attempts.push(rows.map(row => `${root(row)}:${row.preview}`).join("|"));
      return rows.reduce((sum, row) => sum + Number(row.preview), 0) <= capacity;
    } });
    return { roots: page.map(root), attempts };
  };
  const small = run(8), larger = run(9);
  expect(small.roots).toEqual([root(b), root(c)]);
  expect(small.attempts.slice(0, 4)).toEqual([`${root(a)}:9`, `${root(a)}:10`, `${root(b)}:4`, `${root(b)}:4|${root(c)}:4`]);
  expect(larger.roots).toEqual([root(a)]); // More capacity need not preserve membership or root count.
  expect(candidates).toEqual([legacy, a, aVariant, b, c]);
  // Same-root qualification variants survive projection and are tried intact, not interval-deduplicated.
  const qualified = [proof, ...authored.fixture.pool.slice(1, 3)];
  const qProposals = projectResearchNativeProposals(qualified, phase, new SourceSemanticReadBudget(ACCESS_BUDGET));
  const seen: unknown[][] = [];
  researchNativeProposalSelector(qProposals)({ candidates: qualified, meter: new SourceSemanticReadBudget(ACCESS_BUDGET),
    fits: rows => { seen.push(rows.map(row => row.proofs)); return false; } });
  expect(seen.map(row => row[0])).toEqual(qualified.map(row => row.proofs));
});
