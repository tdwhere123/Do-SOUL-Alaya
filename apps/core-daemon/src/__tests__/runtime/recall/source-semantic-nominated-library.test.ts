import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => { isolation.restore(); });
import { sourceSemanticAccessPhases, sourceSemanticAcquisitionNotRun, sourceSemanticExecution, sourceSemanticExecutionPhases,
  sourceDisclosure, qualifySourceDisclosure, hashLabeledIdentity,
  type SourceSemanticAcquisitionPhase } from "@do-soul/alaya-protocol";
import { encodeSourceSemanticLibraryResponse, sourceGoldRootIdentity, sourceSemanticLibrarySourceEntry,
  type SourceSemanticLibraryPackage } from "@do-soul/alaya-core";
import { SqliteFieldEraseBarrierRepo } from "@do-soul/alaya-storage";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { prepareNominatedLibraryWindows, type LibrarySourceNomination }
  from "../../../runtime/recall-read-worker/source-semantic-library-nominated-windows.js";
import { projectResearchNativeProposals, researchNativeProposalSelector, compareResearchNominatedSourceLibrary }
  from "../../../runtime/recall-read-worker/source-semantic-research-nominated-library.js";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { runSourceSemanticWorker } from "../../../runtime/recall-read-worker/source-semantic-reasoning.js";
import { complementaryProofSelectionFixture, rawSourceTwin }
  from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-selection-fixture.js";
import { query as incompatibleQuery } from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-proof-fixture.js";
import { nominatedLibraryContext, compareInGuardedWorker, BODY, CONDITION, ANSWER, digest, ACCESS_BUDGET, CLOCK, WS,
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
