import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => { isolation.restore(); });
import { indexEntryCacheKey, SourceSemanticWorkerResultSchema } from "@do-soul/alaya-protocol";
import { assembleSourceSemanticLibraryIndex, encodeSourceSemanticLibraryResponse, preparedDeliveryId, slotQualifiersFor }
  from "@do-soul/alaya-core";
import { selectSourceSemanticLibraryPage, selectSourceSemanticLibraryPageWithPairExchange }
  from "../../../../../../packages/core/src/recall/runtime/source-semantic-library-selection.js";
import { alternativeSelectionFixture, coverageSelectionFixture, physicalRoot, rawSourceTwin, selectionExecutionBudget }
  from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-selection-fixture.js";
import { deliverAllPages, measureNativeSubset, measurementSummary, nativeSubsetContext, persistArtifact,
  type NativeMeasurement, type NativeSubsetContext } from "./source-semantic-library-subset-packing.test-support.js";
import { exhaustiveReference, measureSelectionGap, selectionGapLimits } from "./source-semantic-library-selection-gap.test-support.js";
import { freezeTextGold, measureTextRecall, textRecallPolicies } from "./source-semantic-library-text-recall.test-support.js";

/** Independent single-page sizing oracle over the complete frozen membership,
 * not a delivery, selector replay, or a copied production reservation byte count. */
function combinedMembershipEnvelope(context: NativeSubsetContext, measurement: NativeMeasurement) {
  const { plan, native, request } = measurement, membership = plan.pages.flat();
  const proofs = membership.flatMap(row => row.proofs);
  const { index } = assembleSourceSemanticLibraryIndex({ query_id: plan.query_id, snapshot_id: plan.snapshot_id,
    interpretation_id: plan.interpretation_id, as_of: plan.as_of, expires_at: plan.expires_at,
    authorized_scopes: plan.authorized, source_entries: membership.map(row => row.entry),
    selected_entries: membership.map(row => row.entry), proof_groups: membership.filter(row => row.proofs.length > 0),
    root_order: membership.map(physicalRoot), truncated: plan.discovery.truncated,
    open_residuals: plan.discovery.open_residuals, more_roots: false, emitted_offset: 0 });
  const material = SourceSemanticWorkerResultSchema.parse({ ...native, index, total_count: membership.length,
    delivery_id: preparedDeliveryId(native.request_identity, index), proofs,
    previews: Object.fromEntries(membership.map(row => [indexEntryCacheKey(row.entry), row.preview])),
    source_disclosures: Object.fromEntries(membership.map(row => [indexEntryCacheKey(row.entry), row.source_disclosure])),
    slot_qualifiers: slotQualifiersFor(index, proofs).map(row => ({ ...row,
      payload_support: membership[row.index]!.payload_support, selection_basis: membership[row.index]!.selection_basis })),
    discovery: { ...native.discovery, access: { ...context.pool.access,
      trace: { kind: "library_selection", omitted_source_count: 0, omitted_interpretation_count: 0 } } },
    work: { native_work: request.budget.work_units, index_work: request.budget.work_units,
      native_accounting: "partial", logical_work: request.budget.work_units,
      native_bytes: request.budget.memory_bytes, logical_memory_bytes: request.budget.memory_bytes,
      rss_bytes: Number.MAX_SAFE_INTEGER } });
  if (material.kind !== "recall") throw new Error("complete public membership expected");
  const encoded = encodeSourceSemanticLibraryResponse(material);
  if (encoded.operation !== "recall" || encoded.results === undefined) throw new Error("complete public membership expected");
  return { ...encoded, results: encoded.results };
}

it("delivers all thirteen text statements in two bounded pages despite optional pair-work refusal at 238405 bytes", async () => {
  const limit = 238405, context = await nativeSubsetContext(coverageSelectionFixture(selectionExecutionBudget));
  try {
    const candidates = context.fixture.pool.flatMap(row => [rawSourceTwin(row), row]), gold = freezeTextGold(context.fixture);
    const baseline = measureTextRecall(context, candidates, limit, textRecallPolicies.original_default, gold);
    const trial = measureTextRecall(context, candidates, limit, textRecallPolicies.anytime_pairs, gold);
    expect(gold.statements).toHaveLength(13);
    expect(trial.pages_for_all_gold).toBe(2);
    expect(trial.planned_pages).toBe(2);
    expect(trial.encoded_page_bytes).toHaveLength(2);
    expect(trial.encoded_page_bytes.every(bytes => bytes <= limit)).toBe(true);
    expect(trial.reserved_plan_fully_observed).toBe(true);
    expect(gold.statements.filter(text => trial.eventual_source_exposure.some(row => row.text.includes(text)))).toEqual(gold.statements);
    expect(new Set(trial.eventual_source_exposure.map(row => row.root)).size).toBe(context.fixture.sources.length);
    for (const row of trial.eventual_source_exposure) {
      const source = context.fixture.sources.find(source => physicalRoot(source.package) === row.root);
      expect(source).toBeDefined();
      expect(row.text).toBe(source!.body);
    }
    for (const page of trial.exposure_pages) {
      expect(page.native_completeness.payload).toBe("truncated");
      expect(page.position).toMatchObject({ status: "unknown", increment: null, history_complete: false });
    }
    expect(trial.delivery_truncated).toBe(false);
    expect(trial.budget_rejections.length).toBeGreaterThan(0);
    expect(trial.recall_at_5).toBe(baseline.recall_at_5);
    expect(trial.exhausted).toBe(false);
  } finally { await context.close(); }
}, 120_000);

it.each([238982, 277716])("keeps complete default delivery where private pair work truncates later pages at %i bytes", async limit => {
  const context = await nativeSubsetContext(coverageSelectionFixture(selectionExecutionBudget));
  try {
    const candidates = context.fixture.pool.flatMap(row => [rawSourceTwin(row), row]), gold = freezeTextGold(context.fixture);
    const baseline = measureTextRecall(context, candidates, limit, textRecallPolicies.original_default, gold);
    const trial = measureTextRecall(context, candidates, limit, textRecallPolicies.anytime_pairs, gold);
    expect(gold.statements).toHaveLength(13);
    expect(baseline.pages_for_all_gold).not.toBeNull();
    expect(baseline.delivery_truncated).toBe(false);
    expect(trial.pages_for_all_gold).toBeNull();
    expect(gold.statements.filter(text => trial.eventual_source_exposure.some(row => row.text.includes(text)))).toHaveLength(12);
    expect(gold.statements.filter(text => !trial.eventual_source_exposure.some(row => row.text.includes(text))))
      .toEqual(["Deployment Cedar health checks passed."]);
    expect(trial.delivery_truncated).toBe(true);
    expect(trial.budget_rejections.length).toBeGreaterThan(0);
    expect(trial.recall_at_5).toBe(baseline.recall_at_5);
    expect(trial.exhausted).toBe(false);
  } finally { await context.close(); }
}, 120_000);

it("keeps an over-cap complete membership partially observed until the actual continuation supplies the missing text", async () => {
  const limit = 238405, context = await nativeSubsetContext(coverageSelectionFixture(selectionExecutionBudget));
  try {
    const candidates = context.fixture.pool.flatMap(row => [rawSourceTwin(row), row]), gold = freezeTextGold(context.fixture);
    const measurement = measureNativeSubset(context, limit, undefined, candidates, textRecallPolicies.anytime_pairs);
    const combined = combinedMembershipEnvelope(context, measurement);
    expect(gold.statements).toHaveLength(13);
    expect(combined.results).toHaveLength(context.fixture.sources.length);
    expect(new Set(measurement.plan.pages.flat().map(physicalRoot)))
      .toEqual(new Set(context.fixture.sources.map(row => physicalRoot(row.package))));
    expect(combined.results.every(row => row.budget_state.within_budget)).toBe(true);
    expect(gold.statements.filter(text => combined.results.some(row => row.content_preview.includes(text)))).toEqual(gold.statements);
    expect(Buffer.byteLength(JSON.stringify(combined))).toBeGreaterThan(limit);

    const first = measurementSummary(measurement);
    expect(first).toMatchObject({ planned_pages: 2, exposure_pages_observed: 1, reserved_plan_fully_observed: false });
    expect(measurement.native.index.continuation).not.toBeNull();
    expect(measurement.native.discovery).toMatchObject({ truncated: false, open_residuals: false });
    expect(gold.statements.filter(text => !measurement.encoded.results!.some(row => row.content_preview.includes(text))))
      .toEqual(["Deployment Cedar network rules approved."]);
    expect(first.first_page_exposure.position).toMatchObject({ status: "unknown", increment: null });

    const pages = deliverAllPages(context, measurement), continued = encodeSourceSemanticLibraryResponse(pages[1]!);
    if (continued.operation !== "recall" || continued.results === undefined) throw new Error("continued public membership expected");
    const delivered = [...measurement.encoded.results!, ...continued.results];
    expect(gold.statements.filter(text => delivered.some(row => row.content_preview.includes(text)))).toEqual(gold.statements);
    expect(measurementSummary(measurement)).toMatchObject({
      planned_pages: 2, exposure_pages_observed: 2, reserved_plan_fully_observed: true });
    expect(pages[1]!.index.continuation).toBeNull();
    for (const page of pages) {
      expect(page.coverage).toMatchObject({ source_interpretation: "open", semantic_correspondence: "open", payload: "truncated" });
      expect((page.proofs ?? []).every(proof => proof.world_claim === "unknown" && proof.semantic_status === "unreviewed")).toBe(true);
      const encoded = encodeSourceSemanticLibraryResponse(page);
      if (encoded.operation !== "recall" || encoded.results === undefined) throw new Error("public membership expected");
      expect(encoded.results.every(row => row.budget_state.within_budget)).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(encoded))).toBeLessThanOrEqual(limit);
    }
    expect(measurement.exposure_pages.every(page => page.position.status === "unknown" && page.position.increment === null)).toBe(true);
  } finally { await context.close(); }
}, 120_000);

// Frozen before running: optional work <= min(200k, incumbent work, half remaining);
// optional memory <= min(16M, half remaining). Encoder callbacks share that ledger.
const enabled = process.env["ALAYA_SELECTION_POLICY_SCAN"] === "1";
for (const [name, make] of Object.entries({ alternatives: alternativeSelectionFixture, coverage: coverageSelectionFixture })) {
  it.skipIf(!enabled)(`bounds anytime exchange against the original selector and exact ${name} optimum`, async () => {
    const context = await nativeSubsetContext(make(selectionExecutionBudget));
    try {
      const candidates = context.fixture.pool.flatMap(row => [rawSourceTwin(row), row]);
      const rows = selectionGapLimits(context).map(limit => {
        const reference = exhaustiveReference(context, limit, candidates);
        const baseline = measureSelectionGap(context, limit, candidates, selectSourceSemanticLibraryPage, reference);
        const candidate = measureSelectionGap(context, limit, candidates, selectSourceSemanticLibraryPageWithPairExchange, reference);
        const delta = candidate.selected.objective.map((value, index) => value - baseline.selected.objective[index]!)
          .find(value => value !== 0) ?? 0;
        expect(delta).toBeGreaterThanOrEqual(0);
        expect(candidate.selected_fits_in_pool_order).toBe(true);
        expect(candidate.selector_work.logical_work).toBeLessThanOrEqual(2 * baseline.selector_work.logical_work);
        expect(candidate.selected.label).not.toBe("");
        return { limit, baseline, candidate, work_ratio: candidate.selector_work.logical_work / baseline.selector_work.logical_work };
      });
      expect(rows).toHaveLength(22);
      const ratios = rows.map(row => row.work_ratio).sort((a, b) => a - b);
      const result = { cap: { optional_work: 200_000, optional_bytes: 16_000_000, max_work_ratio: 2 },
        optimal: rows.filter(row => row.candidate.selector_is_optimal).length,
        better: rows.filter(row => JSON.stringify(row.candidate.selected.objective) !== JSON.stringify(row.baseline.selected.objective)).length,
        median_work_ratio: (ratios[10]! + ratios[11]!) / 2, maximum_work_ratio: ratios.at(-1), rows };
      await persistArtifact("anytime-selection", `${name}.json`, result);
      console.log(JSON.stringify({ pool: name, ...result, rows: undefined }));
    } finally { await context.close(); }
  }, 600_000);
}
