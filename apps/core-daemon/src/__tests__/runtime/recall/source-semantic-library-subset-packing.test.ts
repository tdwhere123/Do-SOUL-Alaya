import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => { isolation.restore(); });
import { encodeSourceSemanticLibraryResponse, sourceGoldRootIdentity } from "@do-soul/alaya-core";
import { selectSourceSemanticLibraryPageWithEvidenceSetCoverage }
  from "../../../../../../packages/core/src/recall/runtime/source-semantic-library-selection.js";
import { alternativeSelectionFixture, compatibleTaskSupport, coverageSelectionFixture, feasibleSubsets,
  physicalRoot, rawSourceTwin, selectionExecutionBudget, type SelectionTaskFixture }
  from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-selection-fixture.js";
import { assertNativeSupport, deliverAllPages, measureNativeSubset, measurementSummary, nativeSubsetContext,
  persistArtifact, persistMeasurement, roomyDeliveryBytes, type NativeMeasurement, type NativeSubsetContext }
  from "./source-semantic-library-subset-packing.test-support.js";

for (const caseName of ["coverage", "alternatives"] as const) {
  it(`measures the frozen ${caseName} task through complete native response reservations`, async () => {
    const authored = caseName === "coverage" ? coverageSelectionFixture(selectionExecutionBudget)
      : alternativeSelectionFixture(selectionExecutionBudget);
    const fixture = { ...authored, sources: authored.sources.slice(0, 4), pool: authored.pool.slice(0, 4) };
    const context = await nativeSubsetContext(fixture);
    try {
      await persistArtifact(caseName, "fixture.json", { fixture, setup_work: context.setup_work,
        provenance: "authored source statements and H/Q/C; native source execution and SQLite admission; no provider or discovery-quality claim",
        evaluator_premise: "same declared environment h; native cross-source compatibility remains unknown" });
      const subsets = feasibleSubsets(fixture.pool, rows => rows.length === 2 || rows.length === 3, 3);
      expect(subsets.filter(rows => rows.length === 2)).toHaveLength(6);
      expect(subsets.filter(rows => rows.length === 3)).toHaveLength(4);
      const measurements: NativeMeasurement[] = [];
      for (const [index, rows] of subsets.entries()) {
        const result = measureNativeSubset(context, roomyDeliveryBytes, rows);
        await persistMeasurement(caseName, `roomy-${index}`, result);
        measurements.push(result);
      }
      await persistArtifact(caseName, "roomy-matrix.json", measurements.map(measurementSummary));
      const complete = measurements.every(row => row.actual_subset && row.reserved_bytes !== null);
      if (!complete) {
        await recordStatus(caseName, { status: "reservation_unavailable", reason: "at least one frozen subset was not retained" });
        return;
      }
      for (const row of measurements) assertNativeSupport(fixture, row);
      const pairBytes = measurements.filter(row => row.desired_sources!.length === 2).map(row => row.reserved_bytes!);
      const tripleBytes = measurements.filter(row => row.desired_sources!.length === 3).map(row => row.reserved_bytes!);
      const limit = Math.max(...pairBytes), minimumTripleBytes = Math.min(...tripleBytes);
      const envelope = { output_byte_limit: limit, maximum_pair_bytes: limit, minimum_triple_bytes: minimumTripleBytes };
      await persistArtifact(caseName, "envelope.json", envelope);
      if (limit >= minimumTripleBytes) {
        await recordStatus(caseName, { status: "no_uniform_two_root_envelope", ...envelope });
        return;
      }
      const replay: NativeMeasurement[] = [];
      for (const [index, roomy] of measurements.entries()) {
        const result = measureNativeSubset(context, limit, roomy.plan.pages[0]!);
        await persistMeasurement(caseName, `bounded-${index}`, result);
        replay.push(result);
      }
      await persistArtifact(caseName, "bounded-matrix.json", replay.map(measurementSummary));
      const exactBoundary = replay.every(row => row.probe?.fits === (row.desired_sources!.length === 2));
      if (!exactBoundary) {
        await recordStatus(caseName, { status: "derived_envelope_not_reproduced", ...envelope });
        return;
      }
      const pairs = replay.filter(row => row.desired_sources!.length === 2);
      for (const row of pairs) {
        expect(row.actual_subset).toBe(true); assertNativeSupport(fixture, row);
      }
      const current = measureNativeSubset(context, limit);
      await persistMeasurement(caseName, "current-selector", current);
      assertNativeSupport(fixture, current);
      expect(current.delivered).toHaveLength(2);
      if (caseName === "coverage") assertCoverageDiscriminator(current, pairs);
      else assertAlternativeDiscriminator(fixture, current, pairs);
      await assertRawTwinDelivery(context, caseName, limit);
      await recordStatus(caseName, { status: "discriminator_observed", ...envelope,
        current: measurementSummary(current), finite_pair_reference: pairs.map(measurementSummary),
        interpretation: "selection and full native delivery counterexample under frozen authored semantics; no answer or world-truth certification" });
    } finally { await context.close(); }
  }, 60_000);
}

// Protocol v2 envelopes measured by the exhaustive native pair controls above.
const frozenEnvelopes = [{ caseName: "coverage", limit: 513_496 }, { caseName: "alternatives", limit: 176_533 }] as const;
for (const { caseName, limit } of frozenEnvelopes) {
  it(`compares evidence-set selection for ${caseName} at the frozen native byte limit`, async () => {
    const authored = caseName === "coverage" ? coverageSelectionFixture(selectionExecutionBudget)
      : alternativeSelectionFixture(selectionExecutionBudget);
    const fixture = { ...authored, sources: authored.sources.slice(0, 4), pool: authored.pool.slice(0, 4) };
    const context = await nativeSubsetContext(fixture), report = `${caseName}-comparison`;
    try {
      await persistArtifact(report, "fixture.json", { fixture, setup_work: context.setup_work,
        frozen_output_byte_limit: limit, baseline_artifact: `native-envelope-first/${caseName}/result.json`,
        provenance: "same authored four-source H/Q/C; native execution and SQLite binding; no new envelope derivation" });
      const current = measureNativeSubset(context, limit);
      await persistMeasurement(report, "default", current);
      const candidate = measureNativeSubset(context, limit, undefined, fixture.pool,
        selectSourceSemanticLibraryPageWithEvidenceSetCoverage);
      await persistMeasurement(report, "candidate", candidate);
      const comparison = { output_byte_limit: limit, current: measurementSummary(current),
        candidate: measurementSummary(candidate), cost_difference: measurementDifference(current, candidate),
        cost_scope: "preparation freezes all pages; delivery covers the initial page; shared setup is separate; source execution usage remains in fixture proofs" };
      await persistArtifact(report, "observed-comparison.json", comparison);
      for (const result of [current, candidate]) {
        assertNativeSupport(fixture, result); expect(result.delivered).toHaveLength(2);
        expect(result.reserved_bytes).not.toBeNull();
        expect(result.reserved_bytes!).toBeLessThanOrEqual(limit);
      }
      expect(candidate.request).toEqual(current.request);
      expect(candidate.native.request_identity).toBe(current.native.request_identity);
      expect(candidate.native.index.query_id).toBe(current.native.index.query_id);
      expect(candidate.native.index.snapshot_id).toBe(current.native.index.snapshot_id);
      if (caseName === "coverage") {
        expect(current.selected_sources).toEqual(["a-trap", "b-trap"]);
        expect(current.support.supported_inputs).toHaveLength(11);
        expect(candidate.selected_sources).toEqual(["c-left", "d-right"]);
        expect(candidate.support.supported_inputs).toHaveLength(12);
        expect(current.support.complete_alternatives).toBe(0);
        expect(candidate.support.complete_alternatives).toBe(0);
      } else assertAlternativeDiscriminator(fixture, current, [candidate]);
      const defaultTwins = await assertRawTwinDelivery(context, `${report}/default-twins`, limit);
      const candidateTwins = await assertRawTwinDelivery(context, `${report}/candidate-twins`, limit,
        selectSourceSemanticLibraryPageWithEvidenceSetCoverage);
      await recordStatus(report, { status: "candidate_improvement_observed", ...comparison,
        raw_proof_twin_controls: { current: defaultTwins, candidate: candidateTwins },
        interpretation: "finite authored native selection result; unknown joint semantics preserved; no provider, utility or default-promotion claim" });
    } finally { await context.close(); }
  }, 60_000);
}

function measurementDifference(current: NativeMeasurement, candidate: NativeMeasurement) {
  const difference = (before: NativeMeasurement["preparation_work"], after: NativeMeasurement["preparation_work"]) => ({
    logical_work: after.logical_work - before.logical_work, logical_bytes: after.logical_bytes - before.logical_bytes,
    native_work: after.native_work - before.native_work, native_bytes: after.native_bytes - before.native_bytes
  });
  return { reserved_bytes: current.reserved_bytes === null || candidate.reserved_bytes === null ? null
    : candidate.reserved_bytes - current.reserved_bytes, delivered_bytes: candidate.encoded_bytes - current.encoded_bytes,
    preparation: difference(current.preparation_work, candidate.preparation_work),
    initial_delivery: difference(current.delivery_work, candidate.delivery_work) };
}

function assertCoverageDiscriminator(current: NativeMeasurement, pairs: readonly NativeMeasurement[]) {
  expect(current.selected_sources).toEqual(["a-trap", "b-trap"]);
  expect(current.support.supported_inputs).toHaveLength(11);
  const best = pairs.reduce((left, right) => left.support.supported_inputs.length > right.support.supported_inputs.length ? left : right);
  expect(best.selected_sources).toEqual(["c-left", "d-right"]);
  expect(best.support.supported_inputs).toHaveLength(12);
  expect([current, ...pairs].every(row => row.support.complete_alternatives === 0)).toBe(true);
  const selected = new Set(current.selected_sources);
  const oneRootExchanges = pairs.filter(row => row.selected_sources.filter(source => selected.has(source)).length === 1);
  expect(oneRootExchanges).toHaveLength(4);
  expect(oneRootExchanges.every(row => row.support.supported_inputs.length < 11)).toBe(true);
}

function assertAlternativeDiscriminator(fixture: SelectionTaskFixture, current: NativeMeasurement, pairs: readonly NativeMeasurement[]) {
  expect(current.selected_sources).toEqual(["checks-left", "checks-right"]);
  expect(current.support).toMatchObject({ supported_inputs: [3, 4, 5, 6], complete_alternatives: 0 });
  const complete = pairs.filter(row => row.support.complete_alternatives === 1);
  expect(complete).toHaveLength(1);
  const sufficient = complete[0]!;
  expect(sufficient.selected_sources).toEqual(["backup", "permission"]);
  expect(sufficient.support.supported_inputs).toEqual([1, 2]);
  const backup = fixture.sources.find(row => row.id === "backup")!.package;
  expect(compatibleTaskSupport(fixture, sufficient.delivered, new Map([[physicalRoot(backup), "h-prime"]]))
    .complete_alternatives).toBe(0);
  expect(compatibleTaskSupport(fixture, sufficient.delivered, new Map([[physicalRoot(backup), null]])))
    .toMatchObject({ alternatives: ["unknown", "incomplete"], complete_alternatives: 0 });
}

async function assertRawTwinDelivery(context: NativeSubsetContext, caseName: string, limit: number,
  selector?: Parameters<typeof measureNativeSubset>[4]) {
  const candidates = context.fixture.pool.flatMap(row => [rawSourceTwin(row), row]);
  const result = measureNativeSubset(context, limit, undefined, candidates, selector);
  await persistMeasurement(caseName, "raw-proof-twins", result);
  const pages = deliverAllPages(context, result), roots: string[] = [];
  for (const [index, page] of pages.entries()) {
    const encoded = encodeSourceSemanticLibraryResponse(page);
    await persistArtifact(caseName, `raw-proof-twins-page-${index}.json`, encoded);
    if (encoded.operation !== "recall" || encoded.results === undefined) throw new Error("native library page expected");
    expect(Buffer.byteLength(JSON.stringify(encoded))).toBeLessThanOrEqual(limit);
    expect(encoded.results.every(row => row.budget_state.within_budget)).toBe(true);
    expect(page.proofs).toEqual(result.plan.pages[index]!.flatMap(row => row.proofs));
    for (const delivered of encoded.results) {
      if (delivered.target?.kind !== "source_evidence") throw new Error("native source target expected");
      const root = sourceGoldRootIdentity(delivered.target);
      roots.push(root);
      expect(delivered.content_preview).toBe(context.fixture.sources.find(row => physicalRoot(row.package) === root)!.body);
    }
  }
  expect(roots).toHaveLength(4); expect(new Set(roots).size).toBe(4);
  expect(pages.flatMap(page => page.proofs)).toHaveLength(4);
  return { initial: measurementSummary(result), pages: pages.length, physical_roots: roots };
}

async function recordStatus(caseName: string, result: Readonly<Record<string, unknown>>) {
  await persistArtifact(caseName, "result.json", result);
  console.info(JSON.stringify({ native_subset_packing: caseName, ...result,
    current: undefined, candidate: undefined, finite_pair_reference: undefined, raw_proof_twin_controls: undefined }));
}
