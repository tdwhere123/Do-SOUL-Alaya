import { expect, it, vi } from "vitest";
import { projectSourceSemanticQuerySupport, SourceSemanticQuerySchema, SourceSemanticResourceLedger, sourceSemanticQueryIdentity,
  type SourceSemanticQuery } from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import { selectSourceSemanticLibraryPage, selectSourceSemanticLibraryPageWithEvidenceSetCoverage,
  type SourceSemanticLibraryPackage } from "../../../recall/runtime/source-semantic-library-selection.js";
import { correspondenceFor, deliveredProofFixture, query, source } from "./source-semantic-proof-fixture.js";
import { alternativeSelectionFixture, compatibleTaskSupport, coverageSelectionFixture, deliveredInputNumbers,
  feasibleSubsets, physicalRoot as root, rawSourceTwin, selectionExecutionBudget
} from "./source-semantic-selection-fixture.js";

const budget = () => new SourceSemanticResourceLedger(selectionExecutionBudget);
const coverage = coverageSelectionFixture(selectionExecutionBudget);
const alternatives = alternativeSelectionFixture(selectionExecutionBudget);
const twoRoots = (rows: readonly SourceSemanticLibraryPackage[]) => rows.length <= 2;
const rootUnits = new Map(alternatives.sources.map(source => [root(source.package), source.inputs.length]));
const singletonCapacity = (rows: readonly SourceSemanticLibraryPackage[]) => rows.reduce((sum, row) => sum + rootUnits.get(root(row))!, 0) <= 2;
const select = selectSourceSemanticLibraryPageWithEvidenceSetCoverage;

it("escapes a strict one-root local maximum using the same finite source-sentence reference", () => {
  const pool = coverage.pool;
  const optimum = Math.max(...feasibleSubsets(pool, twoRoots).map(rows => deliveredInputNumbers(coverage, rows).length));
  const baseline = selectSourceSemanticLibraryPage({ candidates: pool, meter: budget(), fits: twoRoots });
  expect(deliveredInputNumbers(coverage, baseline)).toHaveLength(11);
  expect(optimum).toBe(12);
  const memberships = [pool, [...pool].reverse(), [...pool.slice(2), ...pool.slice(0, 2)]].map(candidates => {
    const selected = select({ candidates, meter: budget(), fits: twoRoots });
    expect(deliveredInputNumbers(coverage, selected)).toHaveLength(optimum);
    expect(compatibleTaskSupport(coverage, selected).complete_alternatives).toBe(0);
    expect(new Set(selected.map(root)).size).toBe(selected.length);
    return selected.map(root).sort();
  });
  expect(memberships[1]).toEqual(memberships[0]);
  expect(memberships[2]).toEqual(memberships[0]);
});

it.each([{ capacity: "two roots", fits: twoRoots, baselineInputs: [3, 4, 5, 6] },
  { capacity: "a stalled singleton", fits: singletonCapacity, baselineInputs: [3, 4] }])(
  "selects a potentially sufficient alternative from $capacity without turning local proofs into a joint answer", ({ fits, baselineInputs }) => {
  const pool = alternatives.pool.slice(0, 4);
  const optimum = Math.max(...feasibleSubsets(pool, fits).map(rows => compatibleTaskSupport(alternatives, rows).complete_alternatives));
  const baseline = selectSourceSemanticLibraryPage({ candidates: pool, meter: budget(), fits });
  expect(deliveredInputNumbers(alternatives, baseline)).toEqual(baselineInputs);
  expect(compatibleTaskSupport(alternatives, baseline).complete_alternatives).toBe(0);
  for (const candidates of [pool, [...pool].reverse(), [...pool.slice(1), pool[0]!], [...pool, pool[0]!, rawSourceTwin(pool[0]!)]]) {
    const selected = select({ candidates, meter: budget(), fits });
    expect(deliveredInputNumbers(alternatives, selected)).toEqual([1, 2]);
    expect(new Set(selected.map(root)).size).toBe(2);
    expect(fits(selected)).toBe(true);
    expect(compatibleTaskSupport(alternatives, selected).complete_alternatives).toBe(optimum);
    expect(optimum).toBe(1);
    const unknown = new Map(selected.map(row => [root(row), null]));
    const exclusive = new Map(selected.map((row, index) => [root(row), `environment-${index}`]));
    expect(compatibleTaskSupport(alternatives, selected, unknown).alternatives).toEqual(["unknown", "incomplete"]);
    expect(compatibleTaskSupport(alternatives, selected, exclusive).complete_alternatives).toBe(0);
    for (const row of selected) {
      expect(row.proofs).toBe(pool.find(candidate => root(candidate) === root(row))!.proofs);
      expect(projectSourceSemanticQuerySupport(row.proofs[0]!.query, row.proofs.flatMap(proof => proof.binding_results ?? [])))
        .toMatchObject({ answer: "unrepresented", operation: "not_executed", compatibility: "unknown", distinctness: "unknown" });
    }
  }
});

it("keeps the reserved singleton when every improving pair fails the complete page fit", () => {
  const pool = alternatives.pool.slice(0, 4), fits = vi.fn((rows: readonly SourceSemanticLibraryPackage[]) => rows.length <= 1);
  const selected = select({ candidates: pool, meter: budget(), fits });
  expect(deliveredInputNumbers(alternatives, selected)).toEqual([3, 4]);
  expect(selected).toHaveLength(1);
  const replacementPairs = fits.mock.calls.map(([rows]) => rows)
    .filter(rows => rows.length === 2 && rows.every(row => root(row) !== root(selected[0]!)));
  expect(replacementPairs).toHaveLength(3);
  expect(replacementPairs.every(rows => new Set(rows.map(root)).size === 2)).toBe(true);
  expect(new Set(replacementPairs.map(rows => rows.map(root).sort().join("|"))).size).toBe(3);
});

it("does not count an unrepresented evidence-input alternative as a completed evidence set", () => {
  const first = alternatives.semantics.alternatives[0]!;
  // Omitting both views leaves an answer body with no represented evidence inputs.
  const answerOnly = { frames: first.frames, context_obligations: first.context_obligations };
  const semantics: SourceSemanticQuery = SourceSemanticQuerySchema.parse({ ...alternatives.semantics, alternatives: [
    ...alternatives.semantics.alternatives,
    answerOnly
  ] });
  const pool = alternatives.pool.slice(0, 4).map(row => {
    const proof = row.proofs[0]!;
    const actual = deliveredProofFixture({ interpretation: proof.interpretation, semantics, original: alternatives.original,
      correspondence: { ...proof.semantic_correspondence,
        query_semantics_id: sourceSemanticQueryIdentity(semantics, fieldContractSha256) },
      library: true, budget: selectionExecutionBudget });
    return { ...row, entry: actual.entry, entries: actual.index.entries,
      explanations: actual.index.explanations ?? [], proofs: [actual.proof] };
  });
  const selected = select({ candidates: pool, meter: budget(), fits: twoRoots });
  expect(deliveredInputNumbers(alternatives, selected)).toEqual([1, 2]);
  expect(selected.every(row => projectSourceSemanticQuerySupport(semantics,
    row.proofs.flatMap(proof => proof.binding_results ?? [])).answer !== "supported")).toBe(true);
});

it("prioritizes an executed answer over a completed evidence-input alternative", () => {
  const original = query(), base = original.alternatives[0]!;
  const semantics: SourceSemanticQuery = SourceSemanticQuerySchema.parse({ ...original,
    requested_operation: { reading: "collect tools", support: { kind: "query_text", excerpt: "tools" } },
    alternatives: [base, { ...base, answer_frames: [], evidence_inputs: [{ frames: ["qUse"] }] }] });
  const pool = [0, 1].map(alternative => {
    const interpretation = { ...source(), source: { ...source().source, source_id: `answer-or-input-${alternative}` } };
    const correspondence = correspondenceFor(interpretation, semantics);
    const actual = deliveredProofFixture({ interpretation, semantics, library: true, budget: selectionExecutionBudget,
      correspondence: { ...correspondence, correspondences: correspondence.correspondences.map(row => ({ ...row,
        query_endpoint: row.query_endpoint.kind === "referent" ? row.query_endpoint : { ...row.query_endpoint, alternative } })) } });
    return { ...coverage.pool[0]!, entry: actual.entry, entries: actual.index.entries,
      explanations: actual.index.explanations ?? [], proofs: [actual.proof], preview: "Alice uses X. Bob uses Y." };
  });
  expect(projectSourceSemanticQuerySupport(semantics, pool[0]!.proofs[0]!.binding_results ?? []).answer).toBe("supported");
  const inputSupport = projectSourceSemanticQuerySupport(semantics, pool[1]!.proofs[0]!.binding_results ?? []);
  expect(inputSupport.answer).not.toBe("supported");
  expect(inputSupport.evidence_inputs).toContainEqual(expect.objectContaining({ alternative: 1, input: 0, status: "supported" }));
  const selected = select({ candidates: [...pool].reverse(), meter: budget(), fits: rows => rows.length <= 1 });
  expect(selected.map(root)).toEqual([root(pool[0]!)]);
  expect(selected[0]!.selection_basis).toBe("direct_answer");
});

it("rejects mixed or unbound query identities before proposing a combined page", () => {
  const fits = vi.fn(() => true);
  expect(() => select({ candidates: [coverage.pool[0]!, alternatives.pool[0]!], meter: budget(), fits }))
    .toThrow("one common bound query");
  const row = coverage.pool[0]!;
  const unbound = { ...row, proofs: row.proofs.map(proof => ({ ...proof, query_semantics_id: `sha256:${"00".repeat(32)}` })) };
  expect(() => select({ candidates: [unbound], meter: budget(), fits })).toThrow("one common bound query");
  expect(fits).not.toHaveBeenCalled();
});

it("keeps indivisible package bytes inside the fit owner's limit during both exchange phases", () => {
  const pool = coverage.pool.map((row, index) => index === 2 ? { ...row, preview: `${row.preview}${" ".repeat(1_000_000)}` } : row);
  const bytes = Buffer.byteLength(JSON.stringify(coverage.pool.slice(0, 2))) + 1000;
  const fits = (rows: readonly SourceSemanticLibraryPackage[]) => twoRoots(rows) && Buffer.byteLength(JSON.stringify(rows)) <= bytes;
  const optimum = Math.max(...feasibleSubsets(pool, fits).map(rows => deliveredInputNumbers(coverage, rows).length));
  const selected = select({ candidates: pool, meter: budget(), fits });
  expect(optimum).toBe(11);
  expect(deliveredInputNumbers(coverage, selected)).toHaveLength(optimum);
  expect(fits(selected)).toBe(true);
  expect(selected.some(row => root(row) === root(pool[2]!))).toBe(false);
});

it("reserves reachable standalone proof variants and admits raw fallback only when none can fit", () => {
  const proof = coverage.pool[0]!, raw = rawSourceTwin(proof), unrelated = rawSourceTwin(coverage.pool[1]!);
  const probes: number[] = [];
  const reserved = select({ candidates: [proof, raw, unrelated], meter: budget(),
    fits: rows => rows.length <= 1 && rows.every(row => row.proofs.length === 0),
    fitsStandalone: (row, precedingSlots) => { probes.push(precedingSlots); return row.proofs.length > 0; } });
  expect(reserved.map(root)).toEqual([root(unrelated)]);
  expect(probes).toContain(0);
  const fallback = select({ candidates: [proof, raw], meter: budget(),
    fits: rows => rows.length <= 1 && rows.every(row => row.proofs.length === 0), fitsStandalone: () => false });
  expect(fallback).toHaveLength(1);
  expect(fallback[0]!.proofs).toEqual([]);
  const proofPage = select({ candidates: [raw, proof, proof], meter: budget(), fits: () => true });
  expect(proofPage).toHaveLength(1);
  expect(proofPage[0]!.proofs).toBe(proof.proofs);
});

it("preserves source-access page order and ledger use through the existing selector", () => {
  const candidates = [rawSourceTwin(coverage.pool[0]!), rawSourceTwin(coverage.pool[1]!), alternatives.pool[0]!]
    .map((row, access_position) => ({ ...row, access_position }));
  const originalBudget = budget(), experimentalBudget = budget();
  const original = selectSourceSemanticLibraryPage({ candidates, meter: originalBudget, fits: twoRoots, order: "source_access" });
  const experimental = select({ candidates, meter: experimentalBudget, fits: twoRoots, order: "source_access" });
  expect(experimental).toEqual(original);
  expect(experimental.map(root)).toEqual(candidates.slice(0, 2).map(root));
  expect(experimentalBudget.spentWork).toBe(originalBudget.spentWork);
  expect(experimentalBudget.spentBytes).toBe(originalBudget.spentBytes);
});

it.each([
  { capacity: "two roots", fixture: coverage, fits: twoRoots, targetInputs: 12, retainedInputs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12] },
  { capacity: "a singleton", fixture: alternatives, fits: singletonCapacity, targetInputs: 2, retainedInputs: [3, 4] }
].flatMap(row => (["work", "bytes"] as const).map(resource => ({ ...row, resource }))))(
  "retains $capacity when a later pair fit exhausts $resource", ({ fixture, fits, targetInputs, retainedInputs, resource }) => {
  const meter = budget();
  let exhausted = false;
  const selected = select({ candidates: fixture.pool.slice(0, 4), meter, fits: rows => {
    if (!fits(rows)) return false;
    if (rows.length === 2 && deliveredInputNumbers(fixture, rows).length === targetInputs) {
      exhausted = true;
      meter.charge(resource === "work" ? meter.work + 1 : 0, resource === "bytes" ? meter.bytes + 1 : 0,
        "actual candidate page encoding");
    }
    return true;
  } });
  expect(exhausted).toBe(true);
  expect(deliveredInputNumbers(fixture, selected)).toEqual(retainedInputs);
  expect(new Set(selected.map(root)).size).toBe(selected.length);
});
