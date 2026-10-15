import { expect, vi } from "vitest";
import { SourceSemanticResourceExhausted, SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";
import { encodeSourceSemanticLibraryResponse, sourceGoldRootIdentity } from "@do-soul/alaya-core";
import { selectSourceSemanticLibraryPage, selectSourceSemanticLibraryPageWithPairExchange,
  type SourceSemanticLibraryPackage } from "../../../../../../packages/core/src/recall/runtime/source-semantic-library-selection.js";
import { deploymentStatement, physicalRoot, type SelectionTaskFixture }
  from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-selection-fixture.js";
import type { LibraryPageSelector } from "../../../runtime/recall-read-worker/source-semantic-library-delivery.js";
import { deliverAllPages, measureNativeSubset, type NativeSubsetContext } from "./source-semantic-library-subset-packing.test-support.js";

const rawOnly: LibraryPageSelector = input => selectSourceSemanticLibraryPage({ ...input,
  candidates: input.candidates.filter(row => row.proofs.length === 0), order: "source_access" });

/** Historical private ranking heuristic; repeated lines and partial overlaps are intentional diagnostic controls. */
export const previewNoveltyBytes = (raw: string | undefined, proof: string) => proof.split("\n")
  .filter(text => !raw?.includes(text)).reduce((bytes, text) => bytes + Buffer.byteLength(text), 0);

/** Gold-free authored policy: reserve B0 roots, then try complete proof upgrades at the real fit boundary. */
function reserveRawRoots(input: Parameters<LibraryPageSelector>[0], novelOnly: boolean, deferNovel = false): readonly SourceSemanticLibraryPackage[] {
  let selected = rawOnly(input);
  if (deferNovel && selected.length === 0) return selectSourceSemanticLibraryPage(input);
  const raws = new Map(input.candidates.filter(row => row.proofs.length === 0).map(row => [physicalRoot(row), row]));
  const novelBytes = (row: SourceSemanticLibraryPackage) => previewNoveltyBytes(raws.get(physicalRoot(row))?.preview, row.preview);
  const meter = input.meter, heldWork = meter.work - Math.min(200_000, Math.floor(meter.work / 2));
  const heldBytes = meter.bytes - Math.min(16_000_000, Math.floor(meter.bytes / 2));
  meter.work -= heldWork; meter.bytes -= heldBytes;
  try {
    meter.charge(input.candidates.length, input.candidates.length * 16, "raw reservation proof candidates");
    const proofs = input.candidates.filter(row => row.proofs.length > 0);
    const ranks = new Map(proofs.map(row => {
      meter.retain(row.preview, "novel source text");
      // Package size ranks candidates only; exact public encoding alone decides fit.
      meter.retain(row, "novel source package size");
      return [row, novelBytes(row) / Math.max(1, Buffer.byteLength(JSON.stringify(row)))];
    }));
    if (novelOnly) proofs.sort((a, b) => ranks.get(b)! - ranks.get(a)!);
    for (const proof of proofs) {
      if (novelOnly && ranks.get(proof) === 0) continue;
      const root = physicalRoot(proof);
      if (!selected.some(row => physicalRoot(row) === root)) continue;
      const desired = selected.map(row => physicalRoot(row) === root ? proof : row);
      const trial = selectSourceSemanticLibraryPage({ ...input, candidates: desired });
      if (trial.length === selected.length) selected = trial;
      else if (deferNovel && input.fitsStandalone !== undefined) {
        const standalone = selectSourceSemanticLibraryPage({ ...input, candidates: [proof],
          // A final-only envelope can replace baseline raw exposure; retain raw in that case.
          fits: page => input.fits(page) && input.fitsStandalone!(page[0]!, selected.length - 1) });
        if (standalone.length === 0) continue;
        const deferred = selected.filter(row => physicalRoot(row) !== root);
        // The last raw root can upgrade directly; never return an empty deferred page.
        if (deferred.length > 0 && input.fits(deferred)) selected = deferred;
      }
    }
  } catch (error) { if (!(error instanceof SourceSemanticResourceExhausted)) throw error; }
  finally { meter.work += heldWork; meter.bytes += heldBytes; }
  return selected;
}

export const textRecallPolicies = {
  raw_only: rawOnly,
  original_default: selectSourceSemanticLibraryPage,
  anytime_pairs: selectSourceSemanticLibraryPageWithPairExchange,
  raw_first: ((input) => reserveRawRoots(input, false)) satisfies LibraryPageSelector,
  new_text_per_byte: ((input) => reserveRawRoots(input, true)) satisfies LibraryPageSelector,
  deferred_new_text: ((input) => reserveRawRoots(input, true, true)) satisfies LibraryPageSelector
};

/** Freeze before execution. Gold stays in this evaluator closure and is never passed to a policy. */
export function freezeTextGold(fixture: SelectionTaskFixture) {
  const statements = Object.freeze([...new Set(fixture.alternatives.flat())].map(input => deploymentStatement(input)));
  const alternatives = Object.freeze(fixture.alternatives.map(inputs => Object.freeze(inputs.map(deploymentStatement))));
  return Object.freeze({ statements, alternatives });
}

/** Source-position coverage is independent of text novelty, gold relevance and proof claims. */
export function compareSourceExposure(baseline: ReturnType<typeof measureTextRecall>, candidate: ReturnType<typeof measureTextRecall>) {
  return baseline.eventual_source_exposure.map(before => {
    const after = candidate.eventual_source_exposure.find(row => row.root === before.root);
    if (before.span === null || after?.span === null) return { root: before.root, status: "unknown" as const, lost_bytes: null };
    const intersection = after === undefined ? 0 : Math.max(0,
      Math.min(before.span.content_end, after.span.content_end) - Math.max(before.span.content_start, after.span.content_start));
    const lost_bytes = before.span.content_end - before.span.content_start - intersection;
    return { root: before.root, status: lost_bytes === 0 ? "retained" as const : "lost" as const, lost_bytes };
  });
}

export function measureTextRecall(context: NativeSubsetContext, candidates: readonly SourceSemanticLibraryPackage[], limit: number,
  selector: LibraryPageSelector, gold: ReturnType<typeof freezeTextGold>) {
  let selectorWork = 0, selectorBytes = 0;
  const budgetRejections: { phase: string; work: number; bytes: number; remaining_work: number; remaining_bytes: number }[] = [];
  const reserve = SourceSemanticResourceLedger.prototype.reserve;
  const observe = vi.spyOn(SourceSemanticResourceLedger.prototype, "reserve").mockImplementation(
    function (this: SourceSemanticResourceLedger, work, bytes, phase = "preparation") {
      try { return reserve.call(this, work, bytes, phase); }
      catch (error) {
        if (error instanceof SourceSemanticResourceExhausted) budgetRejections.push({ phase, work, bytes,
          remaining_work: this.work, remaining_bytes: this.bytes });
        throw error;
      }
    });
  let measurement: ReturnType<typeof measureNativeSubset>, pages: ReturnType<typeof deliverAllPages>;
  const deliveryCosts: ReturnType<typeof measureNativeSubset>["delivery_work"][] = [];
  try {
    measurement = measureNativeSubset(context, limit, undefined, candidates, input => {
      const work = input.meter.spentWork, bytes = input.meter.spentBytes;
      const page = selector(input);
      selectorWork += input.meter.spentWork - work; selectorBytes += input.meter.spentBytes - bytes;
      return page;
    });
    pages = deliverAllPages(context, measurement, (_page, cost) => deliveryCosts.push(cost));
  } finally { observe.mockRestore(); }
  const pageBytes: number[] = [];
  const exposures = pages.flatMap((page, index) => {
    const encoded = encodeSourceSemanticLibraryResponse(page);
    if (encoded.operation !== "recall") throw new Error("recall page expected");
    pageBytes.push(Buffer.byteLength(JSON.stringify(encoded)));
    expect(pageBytes.at(-1)).toBeLessThanOrEqual(limit);
    expect((page.proofs ?? []).every(proof => proof.world_claim === "unknown" && proof.semantic_status === "unreviewed")).toBe(true);
    return (encoded.results ?? []).map(result => {
      const target = result.target;
      if (target?.kind !== "source_evidence") throw new Error("source evidence expected");
      const root = sourceGoldRootIdentity(target), source = context.fixture.sources.find(row => physicalRoot(row.package) === root);
      const span = target.span ?? (result.content_preview === source?.body
        ? { content_start: 0, content_end: Buffer.byteLength(source.body) } : null);
      if (span !== null) expect(result.content_preview).toBe(Buffer.from(source!.body).subarray(span.content_start, span.content_end).toString("utf8"));
      return { root, page: index + 1, span, text: result.content_preview };
    });
  });
  expect(new Set(exposures.map(row => row.root)).size).toBe(exposures.length);
  expect(pages.length).toBeLessThanOrEqual(context.fixture.sources.length);
  const texts = pages.map(page => Object.values(page.previews ?? {}));
  const contains = (list: readonly string[], statement: string) => list.some(text => text.includes(statement));
  const first = texts[0] ?? [], covered = gold.statements.filter(statement => contains(first, statement));
  const cumulative: string[] = [];
  let allGoldPage: number | null = null;
  for (const [index, text] of texts.entries()) {
    cumulative.push(...text);
    if (allGoldPage === null && gold.statements.every(statement => contains(cumulative, statement))) allGoldPage = index + 1;
  }
  return { recall_at_5: covered.length / gold.statements.length, covered_gold: covered,
    best_alternative_completeness: Math.max(...gold.alternatives.map(alt => alt.filter(statement => contains(first, statement)).length / alt.length)),
    any_at_5: covered.length > 0, pages_for_all_gold: allGoldPage, planned_pages: pages.length,
    encoded_bytes: measurement.encoded_bytes, selector_work: selectorWork, selector_bytes: selectorBytes,
    preparation_work: measurement.preparation_work,
    delivery_costs: deliveryCosts, encoded_page_bytes: pageBytes, eventual_source_exposure: exposures,
    eventual_proof_claims: pages.flatMap((page, index) => (page.proofs ?? []).map(proof => ({ page: index + 1,
      id: proof.conditional_computation_id, world_claim: proof.world_claim, semantic_status: proof.semantic_status }))),
    // Caller exhaustion is recorded by the enclosing scan's catch. A returned partial plan is distinct.
    exhausted: false, delivery_truncated: measurement.plan.discovery.truncated, budget_rejections: budgetRejections,
    first_page_roots: measurement.plan.pages[0]!.map(physicalRoot),
    retained_proof_claims: measurement.plan.pages[0]!.flatMap(row => row.proofs.map(proof => ({
      id: proof.conditional_computation_id, world_claim: proof.world_claim, semantic_status: proof.semantic_status }))) };
}
