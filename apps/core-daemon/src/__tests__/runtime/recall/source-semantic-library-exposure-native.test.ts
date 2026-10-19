import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => { isolation.restore(); });
import { canonicalJson, sourceGoldRootIdentity } from "@do-soul/alaya-protocol";
import { encodeSourceSemanticLibraryResponse } from "@do-soul/alaya-core";
import { complementaryProofSelectionFixture, physicalRoot, rawSourceTwin, selectionExecutionBudget, textWindowSelectionFixture }
  from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-selection-fixture.js";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { prepareLibraryPackages, type LibraryExecutedSupport }
  from "../../../runtime/recall-read-worker/source-semantic-library-packages.js";
import { createLibraryExposureMeter } from "./source-semantic-library-exposure.test-support.js";
import { deliverAllPages, measureNativeSubset, measurementSummary, nativeSubsetContext, roomyDeliveryBytes,
  type NativeSubsetContext } from "./source-semantic-library-subset-packing.test-support.js";

function windows(context: NativeSubsetContext, branches: readonly LibraryExecutedSupport[]) {
  const result = prepareLibraryPackages(context.runtime,
    { workspace_id: "ws", as_of: "2026-09-18T00:00:00.000Z", authorized_scopes: { mode: "named", scopes: ["project"] } } as never,
    ["project"], new SourceSemanticReadBudget(selectionExecutionBudget), context.fixture.sources.map(row => rawSourceTwin(row.package).entry), branches);
  expect(result.incomplete).toBe(false);
  return result.packages;
}

it("adds real conditional qualifications with zero new source positions through SQLite, native delivery and public encoding", async () => {
  const authored = complementaryProofSelectionFixture(), context = await nativeSubsetContext(authored.fixture);
  try {
    const root = physicalRoot(authored.fixture.pool[0]!);
    const candidates = windows(context, authored.branches).filter(row => physicalRoot(row) === root);
    const raw = measureNativeSubset(context, roomyDeliveryBytes, undefined, candidates.filter(row => row.proofs.length === 0));
    const proof = measureNativeSubset(context, roomyDeliveryBytes, undefined, candidates);
    expect(raw.native.proofs ?? []).toHaveLength(0);
    expect(proof.native.proofs).toHaveLength(3);
    expect(proof.selector_regions.some(row => row.region === "same_root_post_pass")).toBe(true);
    expect(proof.native.proofs).toEqual(proof.plan.pages[0]!.flatMap(row => row.proofs));
    expect(proof.native.proofs!.map(row => canonicalJson(row.interpretation)).sort()).toEqual(
      authored.branches.slice(0, 3).map(row => canonicalJson(row.proof.interpretation)).sort());
    const meter = createLibraryExposureMeter();
    const initial = meter.observe(raw.native, raw.encoded, context.exposure_sources);
    const upgraded = meter.observe(proof.native, proof.encoded, context.exposure_sources);
    expect(initial.position).toMatchObject({ status: "complete", increment: Buffer.byteLength(authored.fixture.sources[0]!.body) });
    expect(initial.proof_qualification).toMatchObject({ status: "complete", increment: 0 });
    expect(upgraded.position).toMatchObject({ status: "complete", increment: 0 });
    expect(upgraded.proof_qualification).toMatchObject({ status: "complete", increment: 3 });
    expect(upgraded.proof_qualification.qualifications.map(row => row.qualifier.support!.evidence_inputs
      .filter(input => input.status === "supported").map(input => input.input)).sort()).toEqual([[0], [1], [2]]);
    expect(upgraded.proof_qualification.evaluator_usage.work_units).toBeGreaterThan(0);
    expect(upgraded.content_context).toEqual({ status: "not_measured", reason: "no_declared_content_context_signal" });
    const repeated = meter.observe(proof.native, proof.encoded, context.exposure_sources);
    expect(repeated.position.increment).toBe(0); expect(repeated.proof_qualification.increment).toBe(0);
    for (const run of [raw, proof]) {
      expect(run.encoded_bytes).toBeLessThanOrEqual(run.limit);
      expect(run.encoded.results?.every(row => row.budget_state.within_budget)).toBe(true);
      expect(measurementSummary(run)).toHaveProperty("support", run.support);
      expect(measurementSummary(run).support_basis).toBe("authored_fixture_statements_and_alternative_completeness");
      expect(measurementSummary(run)).not.toHaveProperty("legacy_text_support");
      expect((run.native.proofs ?? []).every(row => row.world_claim === "unknown" && row.semantic_status === "unreviewed")).toBe(true);
    }
    expect(meter.observe(proof.native, { ...proof.encoded, delivery_id: "mismatched" }, context.exposure_sources)).toMatchObject({
      position: { status: "unknown", increment: null }, proof_qualification: { status: "unknown", increment: null } });
    expect(createLibraryExposureMeter().observe(proof.native, proof.encoded, [])).toMatchObject({
      position: { status: "unknown", increment: null }, proof_qualification: { status: "unknown", increment: null } });
  } finally { await context.close(); }
});

it("does not claim first qualification exposure after an unverified earlier observation", async () => {
  const authored = complementaryProofSelectionFixture(), context = await nativeSubsetContext(authored.fixture);
  try {
    const root = physicalRoot(authored.fixture.pool[0]!);
    const run = measureNativeSubset(context, roomyDeliveryBytes, undefined,
      windows(context, authored.branches).filter(row => physicalRoot(row) === root));
    for (const failure of ["public_binding", "source_mapping"] as const) {
      const meter = createLibraryExposureMeter();
      const first = meter.observe(run.native, failure === "public_binding" ? { ...run.encoded, delivery_id: "unbound" } : run.encoded,
        failure === "source_mapping" ? [] : context.exposure_sources);
      expect(first.proof_qualification).toMatchObject({ status: "unknown", increment: null });
      const verified = meter.observe(run.native, run.encoded, context.exposure_sources);
      expect(verified.proof_qualification).toMatchObject({ status: "partial", increment: null, known_increment: 3,
        cumulative_known: 3, history_complete: false, issues: ["prior_observation_unresolved"] });
      expect(meter.observe(run.native, run.encoded, context.exposure_sources).proof_qualification).toMatchObject({
        status: "partial", increment: null, known_increment: 0, cumulative_known: 3, history_complete: false });
    }
  } finally { await context.close(); }
});

it("measures every actual continuation once, preserving first-page cost and exact public provenance", async () => {
  const fixture = textWindowSelectionFixture(true), context = await nativeSubsetContext(fixture);
  try {
    const branches = fixture.sources.map(source => ({ proof: source.package.proofs[0]!, group: source.package,
      source: source.body, dependencies: source.dependencies }));
    const run = measureNativeSubset(context, 51_708, undefined, windows(context, branches));
    expect(measurementSummary(run)).toMatchObject({ planned_pages: 5, exposure_pages_observed: 1,
      reserved_plan_fully_observed: false, first_page_exposure: run.exposure });
    const costs: typeof run.delivery_work[] = [];
    const pages = deliverAllPages(context, run, (_page, cost) => costs.push(cost));
    expect(pages).toHaveLength(5); expect(pages[0]).toBe(run.native);
    expect(costs).toHaveLength(5); expect(costs[0]).toEqual(run.delivery_work);
    expect(run.exposure_pages).toHaveLength(5); expect(run.exposure_pages[0]).toBe(run.exposure);
    expect(pages.some(page => page.coverage.payload === "truncated")).toBe(true);
    let observedBytes = 0;
    for (const [index, page] of pages.entries()) {
      const encoded = encodeSourceSemanticLibraryResponse(page);
      if (encoded.operation !== "recall" || encoded.results === undefined) throw new Error("encoded recall results expected");
      expect(Buffer.byteLength(JSON.stringify(encoded))).toBeLessThanOrEqual(run.limit);
      const pageBytes = encoded.results.reduce((sum, result) => {
        const target = result.target;
        if (target?.kind !== "source_evidence" || target.span === undefined) throw new Error("located source result expected");
        const source = fixture.sources.find(row => physicalRoot(row.package) === sourceGoldRootIdentity(target))!;
        const bytes = Buffer.from(result.content_preview), start = target.span.content_start;
        expect(Buffer.from(source.body).subarray(start, start + bytes.length)).toEqual(bytes);
        expect(target).toEqual(page.index.entries[encoded.results!.indexOf(result)]!.target);
        return sum + bytes.length;
      }, 0);
      observedBytes += pageBytes;
      // Source text outside a verified delivered window is not an unknown position inside it.
      expect(run.exposure_pages[index]!.position.issues).toEqual([]);
      expect(run.exposure_pages[index]!.position).toMatchObject({ status: "complete",
        increment: pageBytes, known_increment: pageBytes, cumulative_known: observedBytes });
    }
    expect(measurementSummary(run).exposure_pages).toHaveLength(5);
    expect(measurementSummary(run)).toMatchObject({ planned_pages: 5, exposure_pages_observed: 5, reserved_plan_fully_observed: true });
  } finally { await context.close(); }
}, 120_000);
