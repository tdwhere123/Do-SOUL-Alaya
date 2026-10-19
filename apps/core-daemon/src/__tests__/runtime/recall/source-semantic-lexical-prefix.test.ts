import { beforeAll, afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  const { installStrictProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/strict-provider-free-boundary.js");
  return { safe: installProviderFreeBoundary(), strict: installStrictProviderFreeBoundary() };
});
const workerGuards = ["provider-free-cli-bootstrap.mjs", "strict-provider-free-cli-bootstrap.mjs"]
  .map(name => `--import=${new URL(`../../../../../bench-runner/src/__tests__/support/${name}`, import.meta.url).href}`);
beforeAll(() => { process.execArgv.push(...workerGuards); });
afterEach(() => { expect(isolation.safe.violations).toEqual([]); expect(isolation.strict.forbidden).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => {
  for (const guard of [...workerGuards].reverse()) process.execArgv.splice(process.execArgv.lastIndexOf(guard), 1);
  isolation.strict.restore(); isolation.safe.restore();
});
import { SourceSemanticResourceExhausted, unavailableSourceQueryPreparation, sourceDisclosure, qualifySourceDisclosure,
  type SourceIndexLexicalCandidate, type SourceIndexLexicalRead, type SourceIndexQueryRepository } from "@do-soul/alaya-protocol";
import { SourceIndexAcquisition, sourceGoldRootIdentity, sourceSemanticLibrarySourceEntry, selectSourceSemanticLibraryPage, encodeSourceSemanticLibraryResponse } from "@do-soul/alaya-core";
import { SqliteSourceIndexRepository } from "@do-soul/alaya-storage";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { ResearchLexicalPrefixCapture } from "../../../runtime/recall-read-worker/source-semantic-research-lexical-prefix.js";
import { acquireSourceSemanticIndex } from "../../../runtime/recall-read-worker/source-semantic-index-acquisition.js";
import { researchNativeProposalSelector, compareResearchNominatedSourceLibrary, ResearchSourceAcquisitionReplySchema } from
  "../../../runtime/recall-read-worker/source-semantic-research-nominated-library.js";
import { prepareLibraryPackages } from "../../../runtime/recall-read-worker/source-semantic-library-packages.js";
import * as nominated from "../../../runtime/recall-read-worker/source-semantic-library-nominated-windows.js";
import * as delivery from "../../../runtime/recall-read-worker/source-semantic-library-delivery.js";
import * as researchPool from "../../../runtime/recall-read-worker/source-semantic-research-pool.js";
import { bindAccessPoolIdentity } from "../../../runtime/recall-read-worker/source-semantic-candidate-access.js";
import { runSourceSemanticWorker } from "../../../runtime/recall-read-worker/source-semantic-reasoning.js";
import { createRecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { parseWorkerOperationResult } from "../../../runtime/recall-read-worker/operation-schemas.js";
import { compareResearchSourceAcquisitionControls } from "../../../runtime/recall/source-semantic-research-acquisition-controls.js";
import { complementaryProofSelectionFixture, rawSourceTwin } from
  "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-selection-fixture.js";
import { nominatedLibraryContext, digest, WS, ACCESS_BUDGET, ORIGINAL as SOURCE_ORIGINAL, type NominatedLibraryContext } from "./source-semantic-nominated-library.test-support.js";
import { queryClient, payload, query, ORIGINAL, BUDGET } from "./source-semantic-query-preparation-fixture.js";

function lexicalPayload(context: NominatedLibraryContext, original = "granite") {
  if (context.payload.request.kind !== "recall") throw new Error("direct recall required");
  return { ...context.payload, request: { ...context.payload.request, original_query: original },
    prepared_query: { receipt: unavailableSourceQueryPreparation(SourceIndexAcquisition.channelNotRequested, "not_requested"),
      vector: { status: "unavailable" as const, reason: SourceIndexAcquisition.channelNotRequested } } };
}
function rawPackages(context: NominatedLibraryContext) {
  const entries = context.pool.sources.map(record => sourceSemanticLibrarySourceEntry({ workspaceId: WS,
    root_id: record.identity, source_version: record.source_version, content_digest: record.content_digest,
    evidence_object_id: record.evidence_object_id, hypothesis_id: "raw-prefix-test" }));
  return prepareLibraryPackages(context.runtime, context.payload, ["project"], new SourceSemanticReadBudget(ACCESS_BUDGET), entries, []).packages;
}
function row(context: NominatedLibraryContext, sourceIndex: number, rank: number, lane: "unicode61" | "trigram", bm25: number): SourceIndexLexicalCandidate {
  const record = context.pool.sources[sourceIndex]!;
  const target = { kind: "source_evidence" as const, workspace_id: record.workspace_id, root_kind: "source_record" as const,
    root_id: record.identity, source_version: record.source_version, content_digest: record.content_digest,
    evidence_object_id: record.evidence_object_id };
  return { source: { target, source_id: record.source_id, root_key: sourceGoldRootIdentity(target), body_bytes: 10 },
    lexical: { rank, lane, lane_rank: rank, bm25 } };
}
function capturedRead(context: NominatedLibraryContext, candidates: readonly SourceIndexLexicalCandidate[], budget = ACCESS_BUDGET) {
  const capture = new ResearchLexicalPrefixCapture({ ...lexicalPayload(context), acquisition_control: "lexical" }, new SourceSemanticReadBudget(ACCESS_BUDGET));
  const result: SourceIndexLexicalRead = { candidates, completion: "partial", reason: "candidate_limit",
    resources: { work: 3, memory_bytes: 100, native_bytes: 24, sql_internal_work: "unknown" }, index_coverage: "partial",
    tokenization: null, resource_refusal: null, limitations: ["database_wide_bm25_statistics"] };
  const vector = vi.fn(), admission = vi.fn();
  const repository: SourceIndexQueryRepository = { readLexicalCandidates: vi.fn(() => result),
    readVectorCandidates: vector, admitQueryCandidate: admission };
  const decorated = capture.repository(repository, context.runtime);
  expect(decorated.readLexicalCandidates(WS, "granite", 128, budget)).toBe(result);
  return { capture, repository, decorated, vector, admission, result };
}

it("intersects preadmission tuples, preserves reader lane/rank order and labels the access remainder unranked", async () => {
  const context = await nominatedLibraryContext();
  try {
    const first = row(context, 2, 1, "unicode61", -0.001), second = row(context, 0, 2, "trigram", -500);
    const stale = { ...row(context, 1, 3, "unicode61", -900), source: { ...row(context, 1, 3, "unicode61", -900).source,
      target: { ...row(context, 1, 3, "unicode61", -900).source.target, source_version: "stale-version" } } };
    const forbidden = { ...row(context, 3, 4, "trigram", -1000), source: { ...row(context, 3, 4, "trigram", -1000).source,
      source_id: "forbidden-logical-source", target: { ...row(context, 3, 4, "trigram", -1000).source.target,
        root_id: "forbidden-record", workspace_id: "forbidden-workspace" } } };
    const wrongDigest = { ...row(context, 4, 5, "unicode61", -2000), source: { ...row(context, 4, 5, "unicode61", -2000).source,
      target: { ...row(context, 4, 5, "unicode61", -2000).source.target, content_digest: digest("stale bytes") } } };
    const inputs = [first, second, first, stale, forbidden, wrongDigest];
    const { capture, decorated, vector, admission } = capturedRead(context, inputs);
    expect(capture.rows).toEqual(inputs); expect(capture.rows[0]).not.toBe(first);
    const packages = rawPackages(context), before = structuredClone(packages);
    const evidence = capture.evidence(context.runtime, context.pool.access.pool_id, context.pool.sources, packages, new SourceSemanticReadBudget(ACCESS_BUDGET));
    expect(evidence.order.slice(0, 2)).toEqual([
      { root: first.source.root_key, position: 0, lexical: first.lexical },
      { root: second.source.root_key, position: 1, lexical: second.lexical }
    ]); // The much lower trigram score must NOT be fused ahead of unicode61.
    expect(evidence.order.slice(2).map(item => [item.root, item.lexical])).toEqual(packages
      .filter(item => ![first.source.root_key, second.source.root_key].includes(sourceGoldRootIdentity(item.entry.target as typeof first.source.target)))
      .map(item => [sourceGoldRootIdentity(item.entry.target as typeof first.source.target), null]));
    expect(evidence).toMatchObject({ returned_rows: 6, retained_rows: 6, authorized_rows: 3, discarded_rows: 3,
      reader_limit: 128, capture_status: "complete", reader: { completion: "partial", reason: "candidate_limit", tokenization: null },
      resources: { sql_internal_work: "unknown" } });
    expect(JSON.stringify(evidence)).not.toMatch(/forbidden-|stale-version/u);
    expect(packages).toEqual(before);
    decorated.readVectorCandidates(WS, null, 1, ACCESS_BUDGET);
    decorated.admitQueryCandidate(first.source, null, ACCESS_BUDGET);
    expect(vector).toHaveBeenCalledWith(WS, null, 1, ACCESS_BUDGET);
    expect(admission).toHaveBeenCalledWith(first.source, null, ACCESS_BUDGET);
    const common = new SourceSemanticReadBudget(ACCESS_BUDGET); common.charge(9, 17, "authored common acquisition");
    capture.carryInto(common);
    expect(common.spentWork).toBe(9 + capture.cost().work_units);
    expect(common.spentBytes).toBe(17 + capture.cost().memory_bytes);
  } finally { await context.close(); }
});

it("retains a metered partial prefix without inventing ranks for omitted rows", async () => {
  const context = await nominatedLibraryContext();
  try {
    const rows = Array.from({ length: 128 }, (_, index) => row(context, index % 5, index + 1, "unicode61", -1));
    expect(capturedRead(context, rows).capture.rows).toHaveLength(128); // Reader prefix, not the 16-nomination cap.
    const { capture } = capturedRead(context, rows, { ...ACCESS_BUDGET, work_units: 120 });
    expect(capture.rows.length).toBeGreaterThan(0); expect(capture.rows.length).toBeLessThan(128);
    expect(capture.cost().work_units).toBeGreaterThan(0);
    const evidence = capture.evidence(context.runtime, context.pool.access.pool_id, context.pool.sources, rawPackages(context), new SourceSemanticReadBudget(ACCESS_BUDGET));
    expect(evidence.capture_status).toBe("partial"); expect(evidence.capture_reason).toBe("lexical_capture_resource_exhausted");
    expect(evidence.retained_rows).toBe(capture.rows.length); expect(evidence.returned_rows).toBe(128);
  } finally { await context.close(); }
});

it("captures the original route only and never runs lexical reads for the vector control", async () => {
  const context = await nominatedLibraryContext();
  const lexical = vi.spyOn(SqliteSourceIndexRepository.prototype, "readLexicalCandidates");
  try {
    const input = lexicalPayload(context, "opens");
    const capture = new ResearchLexicalPrefixCapture({ ...input, acquisition_control: "lexical" }, new SourceSemanticReadBudget(ACCESS_BUDGET));
    const acquired = acquireSourceSemanticIndex({ runtime: context.runtime, workspace: WS, navigation: "opens", authorized: ["project"],
      meter: new SourceSemanticReadBudget(ACCESS_BUDGET), metadataMeter: new SourceSemanticReadBudget(ACCESS_BUDGET),
      vector: input.prepared_query.vector, supplemental: { navigation: "granite", vector: input.prepared_query.vector },
      canonicalBytes: 0, sourceCost: () => ({ work_units: 0, memory_bytes: 0 }), control: "lexical", lexicalCapture: capture });
    acquired.releaseCanonical();
    expect(lexical.mock.calls.map(args => args[1])).toEqual(["opens", "granite"]);
    expect(capture.header!.tokenization!.terms).toEqual(["opens"]);
    expect(capture.rows.map(item => item.source.source_id)).toEqual(["answer"]);
    lexical.mockClear();
    const vector = context.payload.prepared_query!.vector;
    const vectorCapture = new ResearchLexicalPrefixCapture({ ...context.payload, acquisition_control: "vector" }, new SourceSemanticReadBudget(ACCESS_BUDGET));
    const vectorAcquired = acquireSourceSemanticIndex({ runtime: context.runtime, workspace: WS, navigation: SOURCE_ORIGINAL,
      authorized: ["project"], meter: new SourceSemanticReadBudget(ACCESS_BUDGET), metadataMeter: new SourceSemanticReadBudget(ACCESS_BUDGET),
      vector, canonicalBytes: 0, sourceCost: () => ({ work_units: 0, memory_bytes: 0 }), control: "vector", lexicalCapture: vectorCapture });
    vectorAcquired.releaseCanonical();
    expect(lexical).not.toHaveBeenCalled(); expect(vectorCapture.header).toBeUndefined(); expect(vectorCapture.rows).toEqual([]);
    expect(vectorCapture.reason).toBe("lexical_channel_not_requested");
  } finally { await context.close(); }
});

it("uses the existing fit selector for an oversized lexical leader, root deduplication and five slots", () => {
  const fixture = complementaryProofSelectionFixture();
  const raw = rawSourceTwin(fixture.fixture.pool[0]!);
  const candidates = Array.from({ length: 7 }, (_, index) => ({ ...raw, access_position: index,
    preview: index === 0 ? "oversized leader" : `raw ${index}`, entry: sourceSemanticLibrarySourceEntry({ workspaceId: "fit-workspace",
      root_id: `root-${index}`, source_version: "1", content_digest: digest(`root-${index}`), evidence_object_id: null, hypothesis_id: "fit" }) }));
  const roots = candidates.map(item => sourceGoldRootIdentity(item.entry.target as { kind: "source_evidence"; workspace_id: string; root_kind: "source_record";
    root_id: string; source_version: string; content_digest: string; evidence_object_id: null }));
  const ordered = [roots[0]!, ...roots.slice(1).reverse()].map((root, position) => ({ root, position }));
  const seen: string[][] = [];
  const selected = researchNativeProposalSelector(ordered)({ candidates: [candidates[0]!, ...candidates], meter: new SourceSemanticReadBudget(ACCESS_BUDGET),
    fits: rows => { seen.push(rows.map(item => item.preview)); return rows.every(item => item.preview !== "oversized leader") && rows.length <= 5; } });
  expect(selected.map(item => item.preview)).toEqual(["raw 6", "raw 5", "raw 4", "raw 3", "raw 2"]);
  expect(seen[0]).toEqual(["oversized leader"]);
  expect(selected).toHaveLength(5);
  expect(candidates.map(item => item.access_position)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  expect(selectSourceSemanticLibraryPage({ candidates, meter: new SourceSemanticReadBudget(ACCESS_BUDGET), order: "source_access", fits: () => true }))
    .toHaveLength(5);
});

it("preserves native exposure on optional capture exhaustion and retains fitted lexical arms before failed nominated hydration", async () => {
  const context = await nominatedLibraryContext();
  try {
    const input = lexicalPayload(context);
    const decoration = vi.spyOn(ResearchLexicalPrefixCapture.prototype, "repository").mockImplementation(repository => repository);
    const ordinary = runSourceSemanticWorker(createRecallReadWorkerRuntime(context.database), input);
    expect(decoration).not.toHaveBeenCalled();
    const baseline = runSourceSemanticWorker(createRecallReadWorkerRuntime(context.database), { ...input, acquisition_control: "lexical" });
    if (baseline.kind !== "research_acquisition" || ordinary.kind !== "recall") throw new Error("native recall required");
    expect(ordinary.index.entries).toEqual(baseline.result.index.entries);
    decoration.mockRestore();
    const originalRetain = SourceSemanticReadBudget.prototype.retain;
    const retention = vi.spyOn(SourceSemanticReadBudget.prototype, "retain").mockImplementation(function (this: SourceSemanticReadBudget, value, phase, ownership) {
      if (phase === "research lexical reader metadata") {
        // Tighten only the optional fork; the real retention owner must refuse before copying.
        this.work = Math.min(this.work, 7); this.bytes = Math.min(this.bytes, 128);
      }
      return originalRetain.call(this, value, phase, ownership);
    });
    const reply = runSourceSemanticWorker(createRecallReadWorkerRuntime(context.database), { ...input, acquisition_control: "lexical" });
    if (reply.kind !== "research_acquisition") throw new Error("private wrapper required");
    expect(ResearchSourceAcquisitionReplySchema.safeParse(reply).success).toBe(true);
    expect(reply.result.index.entries).toEqual(baseline.result.index.entries); expect(reply.result.previews).toEqual(baseline.result.previews);
    expect(reply.result.work.logical_work).toBe(baseline.result.work.logical_work);
    expect(reply.private_delivery.lexical_prefix).toMatchObject({ status: "unavailable", reason: "lexical_capture_resource_exhausted", evidence: null });
    expect(reply.private_delivery.lexical_prefix!.capture_cost.work_units).toBeGreaterThanOrEqual(4);
    retention.mockRestore();
    vi.spyOn(nominated, "prepareNominatedLibraryWindows").mockImplementation(() => { throw new SourceSemanticResourceExhausted("authored window failure"); });
    const next = runSourceSemanticWorker(context.runtime, { ...input, acquisition_control: "lexical" });
    if (next.kind !== "research_acquisition") throw new Error("private wrapper required");
    expect(next.private_delivery).toMatchObject({ status: "partial", reason: "comparison_failed",
      nominated_comparison: { status: "partial", reason: "comparison_failed", failure: { phase: "authored window failure" } },
      failure: { phase: "authored window failure" } });
    expect(ResearchSourceAcquisitionReplySchema.safeParse(next).success).toBe(true);
    expect(ResearchSourceAcquisitionReplySchema.safeParse({ ...next, private_delivery: {
      ...next.private_delivery, status: "complete", reason: null, failure: null } }).success).toBe(false);
    const contrast = next.private_delivery.lexical_prefix!;
    expect(contrast).toMatchObject({ status: "partial", reason: "partial_delivery", evidence: { reader: { completion: "complete" } } });
    expect(contrast.control).not.toBeNull(); expect(contrast.candidate).not.toBeNull();
    expect(contrast.control!.package_repertoire).toEqual(contrast.candidate!.package_repertoire);
    expect(contrast.control!.artifact.index.entries).toEqual(next.result.index.entries);
    expect(contrast.control!.full_envelope_bytes).toBeLessThanOrEqual(input.request.output_byte_limit);
    expect(contrast.candidate!.full_envelope_bytes).toBeLessThanOrEqual(input.request.output_byte_limit);
    expect(next.result.index.entries).toEqual(baseline.result.index.entries);
  } finally { await context.close(); }
});

it("fits both lexical orders against the full captured-phase envelope at a cap that excludes the roomy five-root page", async () => {
  const context = await nominatedLibraryContext();
  try {
    const input = lexicalPayload(context);
    const roomy = runSourceSemanticWorker(createRecallReadWorkerRuntime(context.database), input);
    if (roomy.kind !== "recall") throw new Error("native recall required");
    expect(roomy.index.entries).toHaveLength(5);
    // Independent mandatory envelope: retain actual phases, omit optional source time and quote maximum work.
    const mandatory = encodeSourceSemanticLibraryResponse({ ...roomy,
      source_disclosures: Object.fromEntries(Object.entries(roomy.source_disclosures).map(([key, value]) =>
        [key, qualifySourceDisclosure(value, sourceDisclosure(value).proof_use.kind, false)])),
      work: { native_work: ACCESS_BUDGET.work_units, index_work: ACCESS_BUDGET.work_units, native_accounting: "partial",
        logical_work: ACCESS_BUDGET.work_units, native_bytes: ACCESS_BUDGET.memory_bytes,
        logical_memory_bytes: ACCESS_BUDGET.memory_bytes, rss_bytes: Number.MAX_SAFE_INTEGER }
    });
    const limit = Buffer.byteLength(JSON.stringify({ ...mandatory, execution: "native_reasoning_only" }));
    expect(Buffer.byteLength(JSON.stringify(mandatory))).toBeGreaterThan(limit);
    const request = { ...input.request, output_byte_limit: limit };
    const native = runSourceSemanticWorker(createRecallReadWorkerRuntime(context.database), { ...input, request });
    const reply = runSourceSemanticWorker(createRecallReadWorkerRuntime(context.database), { ...input, request, acquisition_control: "lexical" });
    if (native.kind !== "recall" || reply.kind !== "research_acquisition") throw new Error("native and private recall required");
    expect(native.index.entries.length).toBeGreaterThan(0);
    expect(native.index.entries.length).toBeLessThan(5);
    expect(Buffer.byteLength(JSON.stringify(encodeSourceSemanticLibraryResponse(native)))).toBeLessThanOrEqual(limit);
    const contrast = reply.private_delivery.lexical_prefix!;
    expect(contrast.control!.artifact.index.entries).toEqual(reply.result.index.entries);
    expect(contrast.control!.package_repertoire).toEqual(contrast.candidate!.package_repertoire);
    expect(contrast.control!.package_repertoire).toHaveLength(5);
    for (const arm of [contrast.control!, contrast.candidate!]) {
      expect(arm.full_envelope_bytes).toBeLessThanOrEqual(limit);
      expect(arm.artifact.index.entries.length).toBeLessThan(5);
      expect(arm.artifact.execution).toEqual(reply.private_delivery.captured.execution);
    }
  } finally { await context.close(); }
});

it("travels through guarded real SQLite workers and strict private reply validation with fake deterministic vectors", async () => {
  const h = await queryClient();
  try {
    const request = payload({ kind: "recall", original_query: ORIGINAL, accepts_unreviewed_conditional_results: true,
      access_policy: "query-conditioned-v1", budget: BUDGET, output_byte_limit: 1_000_000 });
    const replies: unknown[] = [];
    const dispatch = h.client.researchAcquisition!.dispatch.bind(h.client.researchAcquisition);
    vi.spyOn(h.client.researchAcquisition!, "dispatch").mockImplementation(async (...args) => {
      const reply = await dispatch(...args); replies.push(reply);
      expect(parseWorkerOperationResult("conditionalField.sourceSemantics", reply)).toEqual(reply);
      return reply;
    });
    const comparison = await compareResearchSourceAcquisitionControls(h.client, request);
    expect(comparison.outcome).toBe("complete"); expect(h.bind).toHaveBeenCalledTimes(1); expect(h.prepare).toHaveBeenCalledTimes(1);
    expect(replies).toHaveLength(3);
    for (const control of ["lexical", "vector", "dual"] as const) {
      const arm = comparison.arm_envelopes[control];
      if (arm.kind !== "PRIVATE_COUNTERFACTUAL") throw new Error("completed worker arm required");
      const lexical = arm.private_delivery.lexical_prefix!;
      if (control === "vector") { expect(lexical).toMatchObject({ status: "not_run", reason: "lexical_channel_not_requested", evidence: null }); continue; }
      expect(lexical.status).toBe("complete"); expect(lexical.evidence!.reader.tokenization!.terms.length).toBeGreaterThan(0);
      expect(arm.private_delivery).toMatchObject(control === "lexical"
        ? { status: "partial", reason: "comparison_states_differ", failure: null,
          nominated_comparison: { status: "unavailable", reason: "no_located_nominations" } }
        : { status: "complete", reason: null, nominated_comparison: { status: "complete" } });
      expect(lexical.evidence!.snapshot_revision).not.toBe(""); expect(lexical.evidence!.pool_id).not.toBe("");
      expect(lexical.control!.package_repertoire).toEqual(lexical.candidate!.package_repertoire);
      expect(lexical.control!.artifact.execution).toEqual(lexical.candidate!.artifact.execution);
      expect(lexical.control!.artifact.results!.map(item => item.content_preview)).toEqual(lexical.candidate!.artifact.results!.map(item => item.content_preview));
      expect(lexical.control!.full_envelope_bytes).toBeLessThanOrEqual(1_000_000);
      expect(lexical.candidate!.full_envelope_bytes).toBeLessThanOrEqual(1_000_000);
      expect(lexical.evidence!.resources.sql_internal_work).toBe("unknown");
      for (const phase of arm.private_delivery.costs.filter(item => item.phase.startsWith("lexical_"))) {
        expect(phase.work.logical_work).toBeGreaterThan(arm.private_delivery.captured.work.logical_work! + lexical.capture_cost.work_units);
      }
    }
    const host = h.client.researchAcquisition!;
    await host.withExecutionScope({ timeoutMs: 5000 }, () => h.client.readSnapshot.isolate!(async () => {
      const prepared = await host.prepareQuery(request);
      await h.client.readSnapshot.beginDeferred();
      try {
        const before = h.observations().length;
        await host.dispatch(request, prepared, "vector");
        expect(h.observations().slice(before).some(item => /MATCH/u.test(item.sql))).toBe(false);
      } finally { await h.client.readSnapshot.rollback(); }
    }));
    const reply = ResearchSourceAcquisitionReplySchema.parse(replies[0]);
    const contrast = reply.private_delivery.lexical_prefix!;
    const malformed = structuredClone(reply);
    malformed.private_delivery.lexical_prefix!.candidate!.package_repertoire[0]!.preview += "changed";
    expect(ResearchSourceAcquisitionReplySchema.safeParse(malformed).success).toBe(false);
    expect(contrast.control!.artifact).not.toHaveProperty("delivery_id");
    expect(contrast.control!.artifact.index).not.toHaveProperty("continuation");
    // A completed lexical sibling cannot make a differing, failed or skipped comparison complete.
    const mixed = structuredClone(replies[2]) as typeof reply;
    mixed.private_delivery.lexical_prefix!.status = "partial";
    mixed.private_delivery.lexical_prefix!.reason = "partial_delivery";
    expect(ResearchSourceAcquisitionReplySchema.safeParse(mixed).success).toBe(false);
    mixed.private_delivery.status = "partial"; mixed.private_delivery.reason = "comparison_states_differ";
    expect(ResearchSourceAcquisitionReplySchema.safeParse(mixed).success).toBe(true);
    mixed.private_delivery.lexical_prefix!.failure = { name: "SourceSemanticResourceExhausted", message: "authored transport stop",
      code: null, phase: "authored transport stop" };
    mixed.private_delivery.reason = "comparison_failed";
    expect(ResearchSourceAcquisitionReplySchema.safeParse(mixed).success).toBe(false);
    mixed.private_delivery.failure = mixed.private_delivery.lexical_prefix!.failure;
    expect(ResearchSourceAcquisitionReplySchema.safeParse(mixed).success).toBe(true);
  } finally { await h.cleanup(); }
}, 30_000);

it.each(["invalid", "admitted", "unavailable"] as const)("skips provided %s Q without treating it as absent", async mode => {
  const h = await queryClient();
  try {
    const input = payload({ kind: "recall", original_query: ORIGINAL, accepts_unreviewed_conditional_results: true,
      access_policy: "query-conditioned-v1", budget: BUDGET, output_byte_limit: 1_000_000,
      ...(mode === "unavailable" ? { query_semantics_unavailable: "producer_failure" } : { query_semantics: query(mode === "invalid" ? "another original" : ORIGINAL) }) });
    const comparison = await compareResearchSourceAcquisitionControls(h.client, input);
    expect(comparison.outcome).toBe("complete");
    const arm = comparison.arm_envelopes.lexical;
    if (arm.kind !== "PRIVATE_COUNTERFACTUAL") throw new Error("completed native arm required");
    expect(arm.private_delivery.lexical_prefix).toMatchObject({ status: "not_run", reason: "supplied_query_semantics_not_absence", evidence: null,
      capture_cost: { work_units: 0, memory_bytes: 0 } });
    expect(arm.artifact.query_semantics_status).toMatchObject(mode === "admitted" ? { status: "admitted" }
      : { status: "unavailable", reason: mode === "invalid" ? "invalid" : "producer_failure" });
  } finally { await h.cleanup(); }
}, 30_000);

it("binds observations by the exact record and logical source pair and preserves the first duplicate", async () => {
  const context = await nominatedLibraryContext();
  try {
    const original = context.pool.access.source_candidates[0]!;
    const wrongSource = { ...original, source_id: "different-logical-source" };
    const duplicate = { ...original, signal: { ...original.signal, source_text_score: original.signal.source_text_score === 0 ? 1 : 0 } };
    const { pool_id: _poolId, ...receipt } = context.pool.access;
    const access = bindAccessPoolIdentity(context.runtime, WS, ["project"], { ...receipt,
      source_candidates: [wrongSource, original, duplicate, ...receipt.source_candidates.slice(1)] }, new SourceSemanticReadBudget(ACCESS_BUDGET));
    // Stop at re-admission: duplicate observations are a first-match binding control, not a legal delivery census.
    const binding = vi.spyOn(researchPool, "bindVerifiedResearchSourceRecords").mockImplementation(() => { throw new Error("binding boundary reached"); });
    const charge = vi.spyOn(SourceSemanticReadBudget.prototype, "charge");
    expect(() => compareResearchNominatedSourceLibrary(context.database, context.payload, { ...context.pool, access }, context.meter))
      .toThrow("binding boundary reached");
    expect(binding).toHaveBeenCalledTimes(1);
    expect(binding.mock.calls[0]![4][0]).toMatchObject({ ...original,
      source_version: context.pool.sources[0]!.source_version, content_digest: context.pool.sources[0]!.content_digest });
    const association = charge.mock.calls.filter(args => /research (observation lookup|captured observation binding)/u.test(args[2] ?? ""));
    expect(association.reduce((sum, args) => sum + args[0], 0)).toBe(1 + access.source_candidates.length + context.pool.sources.length);
    expect(association.find(args => args[2] === "research captured observation binding")![1]).toBe(context.pool.sources.length * 256);
  } finally { await context.close(); }
});

it("charges the common ordering projection before equal tight fit forks without candidate-only selection work", async () => {
  const context = await nominatedLibraryContext();
  try {
    const prepare = delivery.prepareLibraryDelivery;
    const selectionMeters: SourceSemanticReadBudget[] = [];
    const starting: { work: number; bytes: number }[] = [];
    let preparations = 0;
    const originalCharge = SourceSemanticReadBudget.prototype.charge;
    const projections: { meter: SourceSemanticReadBudget; work: number; bytes: number }[] = [];
    vi.spyOn(SourceSemanticReadBudget.prototype, "charge").mockImplementation(function (this: SourceSemanticReadBudget, work, bytes, phase) {
      if (phase === "research private ordering projection") projections.push({ meter: this, work, bytes });
      return originalCharge.call(this, work, bytes, phase);
    });
    vi.spyOn(delivery, "prepareLibraryDelivery").mockImplementation((base, candidates, request, meter, ...rest) => {
      if (++preparations >= 2 && selectionMeters.length < 2) {
        expect(projections).toHaveLength(1); // After native delivery, before either lexical fit fork.
        starting.push({ work: meter.work, bytes: meter.bytes });
        meter.work = Math.min(meter.work, 60_000); meter.bytes = Math.min(meter.bytes, 1_000_000);
        selectionMeters.push(meter);
      }
      return prepare(base, candidates, request, meter, ...rest);
    });
    const reply = runSourceSemanticWorker(context.runtime, { ...lexicalPayload(context), acquisition_control: "lexical" });
    if (reply.kind !== "research_acquisition") throw new Error("private recall required");
    const lexical = reply.private_delivery.lexical_prefix!;
    expect(selectionMeters).toHaveLength(2); expect(starting[0]).toEqual(starting[1]);
    expect(projections[0]).toMatchObject({ work: 5, bytes: 5 * 256 });
    expect(projections.every(row => !selectionMeters.includes(row.meter))).toBe(true);
    expect(lexical.control!.artifact.index.entries).toHaveLength(5);
    expect(lexical.candidate!.artifact.index.entries).toHaveLength(5);
    expect(lexical.control!.package_repertoire).toEqual(lexical.candidate!.package_repertoire);
    expect(ResearchSourceAcquisitionReplySchema.safeParse(reply).success).toBe(true);
  } finally { await context.close(); }
});

it("measures both lexical first-page envelopes for five hundred authorized synthetic roots under retained acquisition limits", async () => {
  const { createAuditedSourceAdmission, SourceIndexLifecycle, fieldContractSha256 } = await import("@do-soul/alaya-core");
  const { SqliteEventLogRepo } = await import("@do-soul/alaya-storage");
  const { createDaemonFieldRepos } = await import("../../../runtime/field/field-repos.js");
  const { createSqliteFieldFormationStores } = await import("../../../runtime/field/sqlite-field-formation-stores.js");
  const { CLOCK } = await import("./source-semantic-query-preparation-fixture.js");
  // Read only from the retained invocation's budget/config, never its query or result population.
  const budgetSource = "question-38146c39-local-recall/acquisition-call-result.json:input.config";
  const budget = { schema_version: 1 as const, work_units: 10_000_000, memory_bytes: 60_000_000,
    page_budget: 10_000, finalization_reserve: 50_000, min_envelope: 10 };
  const outputLimit = 1_000_000, timeoutMs = 30_000;
  const original = "What travel plans and cooking preferences are recorded in my project notes?";
  const lengths = [256, 640, 896, 1408, 1920];
  const subjects = [
    "User: The project travel plans mention a quiet hotel and a garden.",
    "Assistant: Cooking preferences include fresh herbs and a simple pan.",
    "User: Project notes record meeting work on tools and storage.",
    "Assistant: Travel preferences include morning walks and careful packing.",
    "User: Cooking plans mention market produce and a family dinner."
  ];
  const filler = " The afternoon record describes weather, garden paths, family errands, tools, and a quiet room.";
  const bodies = ["Alice uses tools.", ...Array.from({ length: 499 }, (_, index) =>
    (`Record ${index.toString().padStart(3, "0")}. ${subjects[index % subjects.length]}${filler.repeat(24)}`)
      .slice(0, lengths[index % lengths.length]))];
  const bodyBytes = bodies.reduce((sum, body) => sum + Buffer.byteLength(body), 0);
  const fixture = { authorized_roots: bodies.length, full_body_bytes: bodyBytes, body_lengths: lengths,
    min_body_chars: Math.min(...bodies.map(body => body.length)), max_body_chars: Math.max(...bodies.map(body => body.length)),
    bodies_digest: digest(JSON.stringify(bodies)), query: original, budget_source: budgetSource, budget,
    output_byte_limit: outputLimit, timeout_ms: timeoutMs, limits: { roots_per_page: 5, nominations: 16, lexical_prefix: 128 } };
  expect(bodies).toHaveLength(500); expect(bodyBytes).toBe(510_097); expect(fixture.max_body_chars).toBe(1920);
  process.stdout.write(`LEXICAL_PREFIX_SCALE_FIXTURE ${JSON.stringify(fixture)}\n`);
  const h = await queryClient({ requestTimeoutMs: timeoutMs });
  try {
    const admission = createAuditedSourceAdmission({
      stores: createSqliteFieldFormationStores({ database: h.database, repos: createDaemonFieldRepos({ database: h.database }) }),
      eventLogRepo: new SqliteEventLogRepo(h.database), runtimeNotifier: { notifyEntry: async () => undefined }, sha256: fieldContractSha256
    });
    for (let index = 1; index < bodies.length; index++) await admission.admit({ workspace_id: WS,
      source_id: `scale-source-${index.toString().padStart(3, "0")}`, source_version: "1", content_bytes: bodies[index]!,
      evidence_object_id: null, recorded_at: CLOCK, event_time: null, valid_from: null, valid_to: null,
      speaker: "user", scope_class: "project", spans: [] }, { workspaceId: WS });
    const lifecycle = new SourceIndexLifecycle(h.index, fieldContractSha256), generation = lifecycle.begin(h.selection);
    const setupBudget = { work: 100_000, native_bytes: 16_000_000 };
    let capture = lifecycle.capture(WS, generation.generation_id, 128, setupBudget);
    for (let page = 1; !capture.generation.enumeration_complete && page < 16; page++) {
      capture = lifecycle.capture(WS, generation.generation_id, 128, setupBudget);
    }
    expect(capture.generation.enumeration_complete).toBe(true);
    let after: string | null = null, indexedRoots = 0, indexedWindows = 0;
    for (let page = 0; page < 5; page++) {
      const targets = h.index.listTargets(WS, generation.generation_id, after, 128);
      for (const target of targets) {
        const prepared = lifecycle.prepare(WS, generation.generation_id, target.root_key, setupBudget);
        if (prepared.status !== "ready") throw new Error(`synthetic source manifest unavailable: ${prepared.status}`);
        for (const window of prepared.document.windows) {
          expect(lifecycle.acceptVector(WS, generation.generation_id, { window_id: window.window_id,
            input_digest: window.content_digest, embedding: new Float32Array(indexedRoots % 2 === 0 ? [1, 0, 0] : [0, 1, 0]),
            token_count: 2, truncated: false })).toEqual({ status: "accepted" });
          indexedWindows++;
        }
        indexedRoots++;
      }
      if (targets.length < 128) break;
      after = targets.at(-1)!.root_key;
    }
    expect(indexedRoots).toBe(500); expect(lifecycle.publish(WS, generation.generation_id)).toEqual({ status: "accepted" });
    const request = payload({ kind: "recall", original_query: original, accepts_unreviewed_conditional_results: true,
      access_policy: "query-conditioned-v1", budget, output_byte_limit: outputLimit });
    const prepared = { receipt: unavailableSourceQueryPreparation(SourceIndexAcquisition.channelNotRequested, "not_requested"),
      vector: { status: "unavailable" as const, reason: SourceIndexAcquisition.channelNotRequested } };
    const host = h.client.researchAcquisition!;
    const reply = await host.withExecutionScope({ timeoutMs }, () => h.client.readSnapshot.isolate!(async () => {
      await h.client.readSnapshot.beginDeferred();
      try { return await host.dispatch(request, prepared, "lexical"); }
      finally { await h.client.readSnapshot.rollback(); }
    }));
    expect(parseWorkerOperationResult("conditionalField.sourceSemantics", reply)).toEqual(reply);
    const lexical = reply.private_delivery.lexical_prefix!;
    const firstPages = { control: lexical.control?.artifact.index.entries.length ?? null,
      candidate: lexical.candidate?.artifact.index.entries.length ?? null };
    const measurement = { fixture, indexed_roots: indexedRoots, indexed_windows: indexedWindows,
      native: { kind: reply.result.kind, first_page_roots: reply.result.index.entries.length,
        eligible_roots: reply.result.discovery.eligible_source_count, work: reply.result.work, coverage: reply.result.coverage },
      diagnostic: { status: reply.private_delivery.status, reason: reply.private_delivery.reason, failure: reply.private_delivery.failure,
        captured: reply.private_delivery.captured, costs: reply.private_delivery.costs },
      private_reply_bytes: Buffer.byteLength(JSON.stringify(reply)),
      lexical: { status: lexical.status, reason: lexical.reason, failure: lexical.failure, capture_cost: lexical.capture_cost, first_pages: firstPages,
        returned_rows: lexical.evidence?.returned_rows ?? null, retained_rows: lexical.evidence?.retained_rows ?? null,
        reader_limit: lexical.evidence?.reader_limit ?? null, reader: lexical.evidence?.reader ?? null,
        control_package_count: lexical.control?.package_repertoire.length ?? null,
        candidate_package_count: lexical.candidate?.package_repertoire.length ?? null,
        control_preview_bytes: lexical.control?.package_repertoire.reduce((sum, row) => sum + Buffer.byteLength(row.preview), 0) ?? null,
        candidate_preview_bytes: lexical.candidate?.package_repertoire.reduce((sum, row) => sum + Buffer.byteLength(row.preview), 0) ?? null,
        control_full_envelope_bytes: lexical.control?.full_envelope_bytes ?? null,
        candidate_full_envelope_bytes: lexical.candidate?.full_envelope_bytes ?? null },
      comparison_headroom: firstPages.control === 5 && firstPages.candidate === 5 ? "demonstrated_synthetic_only" : "unresolved",
      physical_total: "unknown", benefit: "not_measured" };
    process.stdout.write(`LEXICAL_PREFIX_SCALE_MEASUREMENT ${JSON.stringify(measurement)}\n`);
    expect(reply.result.kind).toBe("recall"); expect(reply.result.index.entries).toHaveLength(5);
    expect(reply.result.discovery.eligible_source_count).toBe(500);
    expect(reply.result.work.logical_work).toBeLessThanOrEqual(budget.work_units);
    expect(reply.result.work.logical_memory_bytes).toBeLessThanOrEqual(budget.memory_bytes);
    expect(firstPages).toEqual({ control: 5, candidate: 5 });
    expect(lexical.control!.package_repertoire).toHaveLength(500);
    expect(lexical.control!.package_repertoire).toEqual(lexical.candidate!.package_repertoire);
    expect(lexical.control!.full_envelope_bytes).toBeLessThanOrEqual(outputLimit);
    expect(lexical.candidate!.full_envelope_bytes).toBeLessThanOrEqual(outputLimit);
    expect(h.bind).not.toHaveBeenCalled(); expect(h.prepare).not.toHaveBeenCalled();
  } finally { await h.cleanup(); }
// invariant: fixture admission/indexing is outside the unchanged 30s acquisition deadline.
}, process.platform === "win32" ? 240_000 : 120_000);
