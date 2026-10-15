import type { SourceSemanticLibraryPackage } from "@do-soul/alaya-core";
import { selectSourceSemanticLibraryPage } from "@do-soul/alaya-core";
import { physicalRoot, rawSourceTwin, type SelectionTaskFixture }
  from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-selection-fixture.js";
import type { LibraryPageSelector } from "../../../runtime/recall-read-worker/source-semantic-library-delivery.js";
import { measureNativeSubset, roomyDeliveryBytes, type NativeSubsetContext } from "./source-semantic-library-subset-packing.test-support.js";

type Fits = (page: readonly SourceSemanticLibraryPackage[]) => boolean;
/** Declared objective: [direct answer, covered evidence inputs, qualified (proof-bearing) roots]. */
export type ObjectiveVector = readonly [number, number, number];
type PageFacts = Readonly<{ label: string; objective: ObjectiveVector; any_at_k: boolean; complete: boolean; text_inputs: number;
  proof_complete: boolean }>;
type SelectionWork = Readonly<{ logical_work: number; logical_bytes: number }>;
type SelectionReference = Readonly<{ facts: readonly PageFacts[]; optimum: ObjectiveVector }>;
type SelectionGap = Readonly<{
  limit: number; selected: PageFacts; feasible: number; optimum: ObjectiveVector; optimal_pages: readonly string[];
  selector_is_optimal: boolean; best_any_at_k: boolean; best_complete: boolean; best_text_inputs: number;
  complete_pages: readonly string[]; selected_fits_in_pool_order: boolean;
  /** Frozen-plan selector regions, including fit encoding and the native same-root post-pass. */
  selector_work: SelectionWork; preparation_work: SelectionWork;
  /** Whether a root-exclusive feasible page has an alternative whose every input is proof-qualified. */
  best_proof_complete: boolean;
}>;

const compareObjective = (left: ObjectiveVector, right: ObjectiveVector) =>
  left[0] - right[0] || left[1] - right[1] || left[2] - right[2];

/** Exact proof-subset size clusters with the original 200-byte boundary margin. */
export function selectionGapLimits(context: NativeSubsetContext, pool = context.fixture.pool): readonly number[] {
  const sizes: number[] = [];
  for (let mask = 1; mask < 1 << pool.length; mask++) {
    sizes.push(measureNativeSubset(context, roomyDeliveryBytes, pool.filter((_, index) => mask & 1 << index)).reserved_bytes!);
  }
  const clusters: [number, number][] = [];
  for (const size of sizes.sort((a, b) => a - b)) {
    const last = clusters[clusters.length - 1];
    if (last !== undefined && size - last[1] <= 200) last[1] = size; else clusters.push([size, size]);
  }
  return clusters.flatMap(([low, high]) => [low - 200, high + 200]);
}

/** Facts come from the hand-declared source statements, never from the selector or the proof output. */
function pageFacts(fixture: SelectionTaskFixture, page: readonly SourceSemanticLibraryPackage[]): PageFacts {
  const authored = (row: SourceSemanticLibraryPackage) => fixture.sources.find(source => physicalRoot(source.package) === physicalRoot(row))!;
  const covered = new Set(page.filter(row => row.proofs.length > 0).flatMap(row => authored(row).inputs));
  const text = new Set(page.flatMap(row => authored(row).inputs));
  const required = new Set(fixture.alternatives.flat());
  return { label: page.map(row => `${authored(row).id}:${row.proofs.length > 0 ? "proof" : "raw"}`).sort().join(" + "),
    objective: [0, covered.size, page.filter(row => row.proofs.length > 0).length],
    any_at_k: [...text].some(input => required.has(input)),
    complete: fixture.alternatives.some(alternative => alternative.every(input => text.has(input))), text_inputs: text.size,
    proof_complete: fixture.alternatives.some(alternative => alternative.every(input => covered.has(input))) };
}

/** Every nonempty root-exclusive choice of one package per root, before the fit oracle is applied. */
function rootExclusivePages(candidates: readonly SourceSemanticLibraryPackage[], capacity = 5) {
  const byRoot = new Map<string, SourceSemanticLibraryPackage[]>();
  for (const row of candidates) byRoot.set(physicalRoot(row), [...byRoot.get(physicalRoot(row)) ?? [], row]);
  const groups = [...byRoot.values()], pages: SourceSemanticLibraryPackage[][] = [];
  const extend = (index: number, chosen: SourceSemanticLibraryPackage[]) => {
    if (index === groups.length) { if (chosen.length > 0 && chosen.length <= capacity) pages.push(chosen); return; }
    extend(index + 1, chosen);
    for (const row of groups[index]!) extend(index + 1, [...chosen, row]);
  };
  extend(0, []);
  return pages;
}

/** The delivered page labels every slot; the label is part of the encoded bytes the fit oracle measures. */
function withSelectionBasis(fixture: SelectionTaskFixture, page: readonly SourceSemanticLibraryPackage[]) {
  const covered = new Set<number>();
  return page.map(row => {
    const inputs = row.proofs.length === 0 ? [] : fixture.sources.find(source => physicalRoot(source.package) === physicalRoot(row))!.inputs;
    const selection_basis = inputs.some(input => !covered.has(input)) ? "new_input" as const
      : inputs.length > 0 ? "additional_witness" as const : "source_access" as const;
    for (const input of inputs) covered.add(input);
    return { ...row, selection_basis };
  });
}

const FITS_PER_RESERVATION = 12;
/** Each reservation meter charges every encoding, so the real oracle is evaluated in bounded batches. */
function feasibleFirstPages(context: NativeSubsetContext, limit: number, candidates: readonly SourceSemanticLibraryPackage[]) {
  const pages = rootExclusivePages(candidates).map(page => withSelectionBasis(context.fixture, page)), feasible: SourceSemanticLibraryPackage[][] = [];
  for (let start = 0; start < pages.length; start += FITS_PER_RESERVATION) {
    const batch = pages.slice(start, start + FITS_PER_RESERVATION);
    let evaluated = false;
    measureNativeSubset(context, limit, undefined, candidates, input => {
      if (evaluated) return selectSourceSemanticLibraryPage(input);
      evaluated = true;
      for (const page of batch) if (input.fits(page)) feasible.push(page);
      return [];
    });
  }
  return feasible;
}

/** Exhaustive feasible first pages and their O1 optimum at one byte limit; independent of any selector. */
export function exhaustiveReference(context: NativeSubsetContext, limit: number,
  candidates: readonly SourceSemanticLibraryPackage[] = context.fixture.pool.flatMap(row => [rawSourceTwin(row), row])): SelectionReference {
  const facts = feasibleFirstPages(context, limit, candidates).map(page => pageFacts(context.fixture, page));
  const optimum = facts.reduce<ObjectiveVector>((best, row) => compareObjective(row.objective, best) > 0 ? row.objective : best, [0, 0, 0]);
  return { facts, optimum };
}

/** Selector page versus the exhaustive first-page reference at one byte limit. */
export function measureSelectionGap(context: NativeSubsetContext, limit: number,
  candidates: readonly SourceSemanticLibraryPackage[] = context.fixture.pool.flatMap(row => [rawSourceTwin(row), row]),
  selector: LibraryPageSelector = selectSourceSemanticLibraryPage,
  reference: SelectionReference = exhaustiveReference(context, limit, candidates)): SelectionGap {
  const run = measureNativeSubset(context, limit, undefined, candidates, selector);
  const selected = run.plan.pages[0]!;
  let probeFits = false, probed = false;
  // The independent pool-order fit probe must not replace the measured selector
  // or spend its continuation-planning ledger.
  measureNativeSubset(context, limit, undefined, candidates, input => {
    if (!probed) {
      probed = true;
      const position = (row: SourceSemanticLibraryPackage) => input.candidates.findIndex(item => item.entry === row.entry);
      probeFits = input.fits([...selected].sort((a, b) => position(a) - position(b)));
    }
    return [];
  });
  const { facts, optimum } = reference;
  const chosen = pageFacts(context.fixture, selected);
  return { limit, selected: chosen, feasible: facts.length, optimum,
    optimal_pages: facts.filter(row => compareObjective(row.objective, optimum) === 0).map(row => row.label).sort(),
    selector_is_optimal: compareObjective(chosen.objective, optimum) === 0,
    best_any_at_k: facts.some(row => row.any_at_k), best_complete: facts.some(row => row.complete),
    best_proof_complete: facts.some(row => row.proof_complete),
    best_text_inputs: Math.max(0, ...facts.map(row => row.text_inputs)),
    complete_pages: facts.filter(row => row.complete).map(row => row.label).sort(), selected_fits_in_pool_order: probeFits,
    selector_work: run.selector_work, preparation_work: { logical_work: run.preparation_work.logical_work, logical_bytes: run.preparation_work.logical_bytes } };
}
