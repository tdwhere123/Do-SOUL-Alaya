import { expect, it } from "vitest";
import { SourceSemanticResourceLedger, projectSourceSemanticQuerySupport, sourceSemanticQueryIdentity, type SourceSemanticQuery } from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import { selectSourceSemanticLibraryPage, type SourceSemanticLibraryPackage } from "../../../recall/runtime/source-semantic-library-selection.js";
import { assembleSourceSemanticLibraryIndex, sourceGoldRootIdentity, sourceSemanticLibrarySourceEntry } from "../../../recall/runtime/source-semantic-library-recall.js";
import { SOURCE_SEMANTIC_REASONING_BUDGET } from "../../../recall/runtime/source-semantic-reasoning.js";
import { deliveredProofFixture, source, query, correspondenceFor } from "./source-semantic-proof-fixture.js";
import { alternativeSelectionFixture, compatibleTaskSupport, coverageSelectionFixture, deliveredInputNumbers,
  deploymentStatement, executedInputNumbers, feasibleSubsets, physicalRoot as root, rawSourceTwin, selectionExecutionBudget
} from "./source-semantic-selection-fixture.js";

const budget = () => new SourceSemanticResourceLedger({ work_units: 1_000_000, memory_bytes: 20_000_000 });
const disclosure: SourceSemanticLibraryPackage["source_disclosure"] = {
  material_kind: "original_body", source_binding: "unbound", evaluated_as_of: "2026-09-18T00:00:00.000Z",
  validity: { kind: "unknown", reason: "unbound" }, temporal_state: "unknown",
  proof_use: { kind: "source_only", qualification: "not_current_proof" }
};
const evidenceQuery: SourceSemanticQuery = { ...query(), requested_operation: { reading: "collect tools", support: { kind: "query_text", excerpt: "tools" } },
  alternatives: query().alternatives.map(row => ({ ...row, answer_frames: [], evidence_inputs: [{ frames: ["qUse"] }] })) };
function witnessed(id: string, semantics = evidenceQuery): SourceSemanticLibraryPackage {
  const interpretation = { ...source(), source: { ...source().source, source_id: id } };
  const actual = deliveredProofFixture({ interpretation, semantics, correspondence: correspondenceFor(interpretation, semantics), library: true });
  expect(actual.proof.binding_results?.length).toBeGreaterThan(0);
  return { entry: actual.entry, entries: actual.index.entries, explanations: actual.index.explanations ?? [],
    proofs: [actual.proof], preview: "Alice uses X.", source_disclosure: disclosure,
    access_position: 10, payload_support: "available" };
}
function raw(id: string, position = 0): SourceSemanticLibraryPackage {
  const entry = sourceSemanticLibrarySourceEntry({ workspaceId: "ws", root_id: id, source_version: "1",
    content_digest: `sha256:${"ab".repeat(32)}`, evidence_object_id: null, hypothesis_id: "library" });
  return { entry, entries: [entry], explanations: [], proofs: [], preview: "weather", source_disclosure: disclosure,
    access_position: position, payload_support: "not_applicable" };
}
const qualified = Array.from({ length: 6 }, (_, index) => witnessed(`speaker-${index}`));

function demandWitnesses() {
  const frames = Array.from({ length: 6 }, (_, index) => ({ ...query().alternatives[0]!.frames[0]!, id: `qUse${index}`, variable: `use${index}` }));
  const semantics: SourceSemanticQuery = { ...evidenceQuery,
    variables: [...query().variables.filter(row => row.id !== "use"), ...frames.map(row => ({ id: row.variable, sort: "proposition" as const }))],
    alternatives: [{ frames, context_obligations: frames.map(row => ({ frame: row.id, kind: "asserted_at_source" })),
      answer_frames: [], evidence_inputs: frames.map(row => ({ frames: [row.id] })) }] };
  return (id: string, inputs: readonly number[]): SourceSemanticLibraryPackage => {
    const interpretation = { ...source(), source: { ...source().source, source_id: id } };
    const original = correspondenceFor(interpretation, query());
    const correspondence = { ...original, query_semantics_id: sourceSemanticQueryIdentity(semantics, fieldContractSha256),
      correspondences: original.correspondences.flatMap(row => row.query_endpoint.kind === "referent" ? [row]
        : inputs.map(input => ({ ...row, query_endpoint: { ...row.query_endpoint, frame: `qUse${input}` } }))) };
    const actual = deliveredProofFixture({ interpretation, semantics, correspondence, library: true });
    return { entry: actual.entry, entries: actual.index.entries, explanations: actual.index.explanations ?? [],
      proofs: [actual.proof], preview: id, source_disclosure: disclosure,
      access_position: 0, payload_support: "available" };
  };
}

it("matches a tiny exhaustive eligibility oracle after demand saturation without claiming distinct people", () => {
  const pool = [raw("unrelated"), ...qualified, qualified[0]!];
  // Independent subset oracle: root uniqueness, five slots, one demand, qualified exposure.
  const best = Math.max(...feasibleSubsets(pool, () => true).map(subset => subset.filter(row => row !== pool[0]).length));
  for (const candidates of [pool, [...pool].reverse(), [...pool.slice(3), ...pool.slice(0, 3)]]) {
    const selected = selectSourceSemanticLibraryPage({ candidates, meter: budget(), fits: rows => rows.length <= 5 });
    expect(selected.filter(row => row.proofs.length > 0)).toHaveLength(best);
    expect(new Set(selected.map(row => JSON.stringify(row.entry.target))).size).toBe(5);
    expect(selected.map(row => row.selection_basis)).toEqual(["new_input", ...Array(4).fill("additional_witness")]);
    expect(new Set(selected.flatMap(row => row.proofs.flatMap(proof => proof.binding_results?.map(binding =>
      binding.kind === "evidence" ? `${binding.alternative}:${binding.input}` : "answer") ?? []))).size).toBe(1);
  }
  // Hidden-world equality is unavailable to the host. The selected five can represent
  // four or five people; an omniscient selector would choose differently in one world.
  expect(qualified.every(row => row.proofs[0]!.binding_results![0]!.kind === "evidence")).toBe(true);
});

it("tests actual indivisible package cost before awarding semantic eligibility", () => {
  const tooLarge = { ...qualified[0]!, preview: "x".repeat(1_000_000) };
  const pool = [tooLarge, ...qualified.slice(1), raw("unrelated")];
  const bytes = Buffer.byteLength(JSON.stringify(qualified.slice(1))) + 1000;
  const selected = selectSourceSemanticLibraryPage({ candidates: pool, meter: budget(),
    fits: rows => Buffer.byteLength(JSON.stringify(rows)) <= bytes });
  expect(selected.some(row => row.entry === tooLarge.entry)).toBe(false);
  expect(selected).toHaveLength(5);
  expect(selected.every(row => row.proofs.length > 0)).toBe(true);
});

it("prefers an actually executed complete answer and fills remaining slots from native access order", () => {
  const answer = witnessed("answer", query());
  const pool = [raw("canonical-first", 9), raw("query-related", 0), answer];
  const selected = selectSourceSemanticLibraryPage({ candidates: pool, meter: budget(), fits: () => true });
  expect(selected.map(row => row.selection_basis)).toEqual(["direct_answer", "source_access", "source_access"]);
  expect(selected[1]!.entry.target).toEqual(pool[1]!.entry.target);
});

it("keeps the same qualified packages and fit envelope in frozen source order", () => {
  const candidates = [raw("first", 0), raw("second", 1), witnessed("late-answer", query())];
  const fits = (rows: readonly SourceSemanticLibraryPackage[]) => rows.length <= 2;
  const field = selectSourceSemanticLibraryPage({ candidates, meter: budget(), fits });
  const access = selectSourceSemanticLibraryPage({ candidates, meter: budget(), fits, order: "source_access" });
  expect(field.map(root)).toEqual([root(candidates[2]!), root(candidates[0]!)]);
  expect(access.map(root)).toEqual([root(candidates[0]!), root(candidates[1]!)]);
  expect(access.every(row => row.selection_basis === "source_access")).toBe(true);
});

it("compares the same immutable candidates in native canonical and selected index orders", () => {
  const candidates = [raw("a0"), raw("a1"), raw("a2"), raw("a3"), raw("a4"), raw("a5"), witnessed("z-answer", query())];
  const expectedAnswer = root(candidates[6]!);
  const selected = selectSourceSemanticLibraryPage({ candidates, meter: budget(), fits: rows => rows.length <= 5 });
  const input = { query_id: "fixed-query", snapshot_id: `sha256:${"cd".repeat(32)}`, interpretation_id: "fixed-interpretation",
    as_of: "2026-09-18T00:00:00.000Z", proof_groups: candidates.filter(row => row.proofs.length > 0)
      .map(row => ({ entries: row.entries, explanations: row.explanations })),
    source_entries: candidates.map(row => row.entry), truncated: false, open_residuals: false };
  const canonical = assembleSourceSemanticLibraryIndex(input);
  const proposed = assembleSourceSemanticLibraryIndex({ ...input, root_order: selected.map(root),
    selected_entries: selected.map(row => row.entry), more_roots: true });
  expect(new Set(candidates.map(root)).size).toBe(7);
  expect(canonical.index.entries).toHaveLength(5);
  expect(proposed.index.entries).toHaveLength(5);
  expect(proposed.index.entries[0]?.target.kind === "source_evidence"
    && sourceGoldRootIdentity(proposed.index.entries[0].target)).toBe(expectedAnswer);
  expect(canonical.index.entries.some(row => row.target.kind === "source_evidence"
    && sourceGoldRootIdentity(row.target) === expectedAnswer)).toBe(false);
  expect(selected[0]?.selection_basis).toBe("direct_answer");
});

it("repairs the greedy overlapping-demand choice by one root exchange against exhaustive subsets", () => {
  const make = demandWitnesses();
  const pool = [make("overlap", [0, 1, 2, 3]), make("left", [0, 1, 4]), make("right", [2, 3, 5])];
  const coverage = (rows: readonly SourceSemanticLibraryPackage[]) => new Set(rows.flatMap(row => row.proofs.flatMap(proof =>
    proof.binding_results?.flatMap(binding => binding.kind === "evidence" ? [binding.input] : []) ?? []))).size;
  const optimum = Math.max(...feasibleSubsets(pool, () => true, 2).map(coverage));
  expect(coverage([pool[0]!, pool[1]!])).toBe(5);
  const selected = selectSourceSemanticLibraryPage({ candidates: pool, meter: budget(), fits: rows => rows.length <= 2 });
  expect(coverage(selected)).toBe(optimum);
  expect(optimum).toBe(6);
  expect(selected.map(row => row.preview).sort()).toEqual(["left", "right"]);
  const neighbors = [...pool, make("another-right", [2, 3, 5])];
  const memberships = [neighbors, [...neighbors].reverse(), [...neighbors.slice(2), ...neighbors.slice(0, 2)]].map(candidates =>
    selectSourceSemanticLibraryPage({ candidates, meter: budget(), fits: rows => rows.length <= 2 })
      .map(row => JSON.stringify(row.entry.target)).sort());
  expect(memberships[1]).toEqual(memberships[0]);
  expect(memberships[2]).toEqual(memberships[0]);
});

it("leaves one of six necessary source-local inputs outside the fixed first five roots", () => {
  const make = demandWitnesses();
  const candidates = Array.from({ length: 6 }, (_, input) => make(`necessary-${input}`, [input]));
  const selected = selectSourceSemanticLibraryPage({ candidates, meter: budget(), fits: rows => rows.length <= 5 });
  const covered = new Set(selected.flatMap(row => row.proofs.flatMap(proof => proof.binding_results?.flatMap(binding =>
    binding.kind === "evidence" ? [binding.input] : []) ?? [])));
  expect(new Set(candidates.map(root)).size).toBe(6);
  expect(selected).toHaveLength(5);
  expect(new Set(selected.map(root)).size).toBe(5);
  expect(covered.size).toBe(5);
  expect([0, 1, 2, 3, 4, 5].filter(input => !covered.has(input))).toHaveLength(1);
});

it("defers a proof root instead of consuming its smaller raw twin on a crowded page", () => {
  const answer = witnessed("answer", query()), proof = qualified[0]!;
  const rawTwin = { ...proof, proofs: [], entries: [proof.entry], explanations: [], preview: "raw",
    payload_support: "envelope_budget" as const };
  const unrelated = raw("unrelated");
  const cost = (row: SourceSemanticLibraryPackage) => row.proofs.length > 0 ? 6 : 1;
  const fits = (rows: readonly SourceSemanticLibraryPackage[]) => rows.reduce((sum, row) => sum + cost(row), 0) <= 8;
  const first = selectSourceSemanticLibraryPage({ candidates: [answer, proof, rawTwin, unrelated], meter: budget(), fits });
  expect(first.map(root)).toEqual([root(answer), root(unrelated)]);
  expect(first.some(row => root(row) === root(proof))).toBe(false);
  const next = selectSourceSemanticLibraryPage({ candidates: [proof, rawTwin], meter: budget(), fits });
  expect(next).toHaveLength(1);
  expect(next[0]!.proofs).toEqual(proof.proofs);
});

it("uses raw support only when the indivisible proof cannot fit an empty page", () => {
  const proof = qualified[0]!;
  const rawTwin = { ...proof, proofs: [], entries: [proof.entry], explanations: [], preview: "raw",
    payload_support: "envelope_budget" as const };
  const selected = selectSourceSemanticLibraryPage({ candidates: [proof, rawTwin], meter: budget(),
    fits: rows => rows.every(row => row.proofs.length === 0) });
  expect(selected).toHaveLength(1);
  expect(selected[0]!.proofs).toEqual([]);
  expect(selected[0]!.selection_basis).toBe("source_access");
});

it("honors a reachable final singleton instead of taking its raw twin before an earlier root", () => {
  const proof = witnessed("a-first", query()), earlier = raw("b-earlier");
  const rawTwin = { ...proof, proofs: [], entries: [proof.entry], explanations: [],
    payload_support: "envelope_budget" as const };
  const first = selectSourceSemanticLibraryPage({ candidates: [proof, rawTwin, earlier], meter: budget(),
    fits: rows => rows.every(row => row.proofs.length === 0) && rows.length === 1,
    fitsStandalone: candidate => candidate === proof || candidate.entry === proof.entry });
  expect(first.map(root)).toEqual([root(earlier)]);
  const final = selectSourceSemanticLibraryPage({ candidates: [proof, rawTwin], meter: budget(), fits: rows => rows.length === 1 });
  expect(final[0]?.proofs).toEqual(proof.proofs);
  expect(new Set([...first, ...final].map(root)).size).toBe(2);
});

it("checks every same-root proof variant before allowing raw fallback", () => {
  const proof = qualified[0]!, smaller = { ...proof, preview: "fitting proof" };
  const rawTwin = { ...proof, proofs: [], entries: [proof.entry], explanations: [],
    payload_support: "envelope_budget" as const };
  const earlier = raw("earlier");
  const probes: string[] = [];
  const selected = selectSourceSemanticLibraryPage({ candidates: [proof, smaller, rawTwin, earlier], meter: budget(),
    fits: rows => rows.length === 1 && rows.every(row => row.proofs.length === 0),
    fitsStandalone: candidate => { probes.push(candidate.preview); return candidate.preview === smaller.preview; } });
  expect(probes).toEqual([proof.preview, smaller.preview]);
  expect(selected.map(root)).toEqual([root(earlier)]);
});

it("allows raw fallback when another frozen final root leaves no reachable proof envelope", () => {
  const proof = qualified[0]!;
  const rawTwin = { ...proof, proofs: [], entries: [proof.entry], explanations: [],
    payload_support: "envelope_budget" as const };
  const selected = selectSourceSemanticLibraryPage({ candidates: [proof, rawTwin], meter: budget(),
    fits: rows => rows.length === 1 && rows[0]!.proofs.length === 0,
    fitsStandalone: () => false });
  expect(selected).toHaveLength(1);
  expect(selected[0]?.proofs).toEqual([]);
  expect(selectSourceSemanticLibraryPage({ candidates: [proof, rawTwin], meter: budget(),
    fits: () => false, fitsStandalone: () => false })).toEqual([]);
});

it("keeps reserved slots when later selection work exhausts", () => {
  const meter = new SourceSemanticResourceLedger({ work_units: 14, memory_bytes: 20000 });
  const pool = [raw("first"), raw("second", 1), raw("third", 2)];
  const selected = selectSourceSemanticLibraryPage({ candidates: pool, meter, fits: () => {
    meter.charge(5, 0, "actual candidate encoding"); return true;
  } });
  expect(selected.map(row => row.entry.target)).toEqual([pool[0]!.entry.target]);
  expect(meter.spentWork).toBe(13);
});

const coverageTask = coverageSelectionFixture(selectionExecutionBudget);
const alternativeTask = alternativeSelectionFixture(selectionExecutionBudget);

it("finishes this source's statements inside the default reasoning allowance", () => {
  const original = coverageSelectionFixture(), covered = original.pool[0]!, complete = coverageTask.pool[0]!;
  const proof = covered.proofs[0]!;
  expect(original.execution_budget).toMatchObject({ work_units: 200_000, memory_bytes: 20_000_000,
    page_budget: 100_000, finalization_reserve: 10_000, min_envelope: 10 });
  expect(root(covered)).toBe(root(complete));
  expect(proof.source_interpretation_id).toBe(complete.proofs[0]!.source_interpretation_id);
  expect(proof.query_semantics_id).toBe(complete.proofs[0]!.query_semantics_id);
  expect(proof.semantic_correspondence_id).toBe(complete.proofs[0]!.semantic_correspondence_id);
  expect(proof.outcome).toEqual({ status: "interpreted", gaps: [] });
  expect(proof.completeness).toMatchObject({ logical_index: "complete", observed_coverage: "complete", order_coverage: "complete" });
  const executed = executedInputNumbers(covered);
  expect(executed).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(deliveredInputNumbers(original, [covered])).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(proof.resource_usage!.work_units).toBeLessThanOrEqual(original.execution_budget.work_units);
  expect(proof.resource_usage!.memory_bytes).toBeLessThan(original.execution_budget.memory_bytes);
  expect(projectSourceSemanticQuerySupport(proof.query, proof.binding_results ?? []).evidence_inputs.map(row => row.status))
    .toEqual([...Array(executed.length).fill("supported"), ...Array(13 - executed.length).fill("open")]);
});

it("retains an ordered open prefix when the work allowance stops early", () => {
  // Half the default allowance still stops before this source's last statement.
  const allowance = { ...SOURCE_SEMANTIC_REASONING_BUDGET, work_units: SOURCE_SEMANTIC_REASONING_BUDGET.work_units / 2 };
  const original = coverageSelectionFixture(allowance), partial = original.pool[0]!, complete = coverageTask.pool[0]!;
  const proof = partial.proofs[0]!;
  expect(root(partial)).toBe(root(complete));
  expect(proof.source_interpretation_id).toBe(complete.proofs[0]!.source_interpretation_id);
  expect(proof.query_semantics_id).toBe(complete.proofs[0]!.query_semantics_id);
  expect(proof.semantic_correspondence_id).toBe(complete.proofs[0]!.semantic_correspondence_id);
  expect(proof.outcome).toEqual({ status: "resource_exhausted" });
  expect(proof.completeness).toMatchObject({ logical_index: "partial", observed_coverage: "open", order_coverage: "partial" });
  const executed = executedInputNumbers(partial);
  expect(executed.length).toBeGreaterThanOrEqual(4);
  expect(executed.length).toBeLessThan(7);
  expect(executed).toEqual([1, 2, 3, 4, 5, 6, 7].slice(0, executed.length));
  expect(deliveredInputNumbers(original, [partial])).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(proof.resource_usage!.work_units).toBeLessThanOrEqual(allowance.work_units);
  expect(proof.resource_usage!.memory_bytes).toBeLessThan(allowance.memory_bytes);
  expect(projectSourceSemanticQuerySupport(proof.query, proof.binding_results ?? []).evidence_inputs.map(row => row.status))
    .toEqual([...Array(executed.length).fill("supported"), ...Array(13 - executed.length).fill("open")]);
  // Coverage must not put this fixture back on the production allowance, which now finishes the prefix.
}, 30_000);

it("executes only the distinct source-bound deployment inputs without claiming task completion", () => {
  const readiness = [coverageTask, alternativeTask].flatMap(fixture => fixture.sources.map(authored => ({
    source_id: authored.id, declared_inputs: authored.inputs, executed_inputs: executedInputNumbers(authored.package),
    budget: fixture.execution_budget, outcome: authored.package.proofs[0]!.outcome,
    completeness: authored.package.proofs[0]!.completeness, resource_usage: authored.package.proofs[0]!.resource_usage,
    budget_rejections: authored.budget_rejections
  })));
  expect(readiness, `Native fixture readiness: ${JSON.stringify(readiness, null, 2)}`).toMatchObject(
    readiness.map(row => ({ source_id: row.source_id, executed_inputs: row.declared_inputs, outcome: { status: "interpreted" } }))
  );
  for (const fixture of [coverageTask, alternativeTask]) {
    expect(new Set(fixture.sources.map(row => root(row.package))).size).toBe(fixture.sources.length);
    for (const authored of fixture.sources) {
      const proof = authored.package.proofs[0]!;
      expect(authored.body).toBe(authored.inputs.map(deploymentStatement).join("\n"));
      expect(proof.interpretation.source.content_digest).toBe(`sha256:${fieldContractSha256(authored.body)}`);
      expect(proof.original_query).toBe(fixture.original);
      expect(new Set(proof.interpretation.frames.map(frame => frame.predicate_support.reading)).size).toBe(authored.inputs.length);
      for (const mention of proof.interpretation.mentions) {
        expect(mention.span_space).toBe("source_utf8");
        expect(Buffer.from(authored.body).subarray(...mention.utf8_span).toString("utf8")).toBe(mention.text);
      }
      expect(executedInputNumbers(authored.package)).toEqual(authored.inputs);
      expect(deliveredInputNumbers(fixture, [authored.package])).toEqual(authored.inputs);
      expect(projectSourceSemanticQuerySupport(proof.query, proof.binding_results ?? [])).toMatchObject({
        answer: "unrepresented", operation: "not_executed", compatibility: "unknown", distinctness: "unknown"
      });
      expect(proof.binding_results?.every(binding => binding.kind === "evidence")).toBe(true);
    }
  }
});

it("retains a strict one-exchange local maximum below the finite two-root coverage optimum", () => {
  const { pool } = coverageTask;
  const coverage = (rows: readonly SourceSemanticLibraryPackage[]) => deliveredInputNumbers(coverageTask, rows).length;
  expect(pool.map(row => coverage([row]))).toEqual([7, 4, 6, 6]);
  expect([pool[1]!, pool[2]!, pool[3]!].map(row => coverage([pool[0]!, row]) - 7)).toEqual([4, 3, 3]);
  const subsets = feasibleSubsets(pool, () => true, 2), pairs = subsets.filter(rows => rows.length === 2);
  expect(pairs.map(coverage)).toEqual([11, 10, 8, 10, 8, 12]);
  const optimum = Math.max(...subsets.map(coverage));
  expect(optimum).toBe(12);
  expect(subsets.every(rows => compatibleTaskSupport(coverageTask, rows).complete_alternatives === 0)).toBe(true);
  for (const candidates of [pool, [...pool].reverse(), [...pool.slice(1), pool[0]!]]) {
    const selected = selectSourceSemanticLibraryPage({ candidates, meter: budget(), fits: rows => rows.length <= 2 });
    expect(selected.map(root)).toEqual([root(pool[0]!), root(pool[1]!)]);
    expect(selected.map(row => row.selection_basis)).toEqual(["new_input", "new_input"]);
    expect(coverage(selected)).toBe(11);
    expect(new Set(selected.flatMap(executedInputNumbers)).size).toBe(11);
    for (const replacement of [pool[2]!, pool[3]!]) {
      expect(coverage([selected[0]!, replacement])).toBeLessThan(11);
      expect(coverage([replacement, selected[1]!])).toBeLessThan(11);
    }
    expect(compatibleTaskSupport(coverageTask, selected).complete_alternatives).toBe(0);
  }
});

it("prefers four partial inputs even though a two-input page supplies one complete task alternative", () => {
  const pool = alternativeTask.pool.slice(0, 4);
  const reference = feasibleSubsets(pool, () => true, 2).map(rows => ({ rows, support: compatibleTaskSupport(alternativeTask, rows) }));
  const maximumInputCount = Math.max(...reference.map(row => row.support.supported_inputs.length));
  expect(maximumInputCount).toBe(4);
  expect(reference.filter(row => row.support.supported_inputs.length === maximumInputCount)
    .every(row => row.support.complete_alternatives === 0)).toBe(true);
  const sufficient = reference.filter(row => row.support.complete_alternatives === 1);
  expect(sufficient).toHaveLength(1);
  expect(sufficient[0]!.rows.map(root)).toEqual(pool.slice(0, 2).map(root));
  expect(sufficient[0]!.support.supported_inputs).toEqual([1, 2]);
  for (const candidates of [pool, [...pool].reverse()]) {
    const selected = selectSourceSemanticLibraryPage({ candidates, meter: budget(), fits: rows => rows.length <= 2 });
    expect(selected.map(root).sort()).toEqual(pool.slice(2).map(root).sort());
    expect(new Set(selected.flatMap(executedInputNumbers)).size).toBe(4);
    expect(compatibleTaskSupport(alternativeTask, selected)).toMatchObject({
      supported_inputs: [3, 4, 5, 6], complete_alternatives: 0, alternatives: ["incomplete", "incomplete"]
    });
  }
});

it("keeps exclusive and unknown evaluator environments separate from native source-local proofs", () => {
  const [permission, backup, , , compatibleBackup] = alternativeTask.pool;
  const pair = [permission!, backup!];
  const exclusive = new Map([[root(permission!), "h"], [root(backup!), "h-prime"]]);
  expect(compatibleTaskSupport(alternativeTask, pair, exclusive)).toMatchObject({
    supported_inputs: [1, 2], complete_alternatives: 0, alternatives: ["incomplete", "incomplete"]
  });
  expect(compatibleTaskSupport(alternativeTask, pair, new Map([[root(backup!), null]]))).toMatchObject({
    supported_inputs: [1, 2], complete_alternatives: 0, alternatives: ["unknown", "incomplete"], unresolved_qualifiers: ["environment"]
  });
  expect(compatibleTaskSupport(alternativeTask, [permission!, backup!, compatibleBackup!], exclusive)).toMatchObject({
    supported_inputs: [1, 2], complete_alternatives: 1, alternatives: ["complete", "incomplete"], unresolved_qualifiers: []
  });
  expect(compatibleTaskSupport(alternativeTask, [permission!, compatibleBackup!], exclusive).complete_alternatives).toBe(1);
  expect(new Set(pair.flatMap(executedInputNumbers)).size).toBe(2);
  expect(pair.every(row => row.proofs[0]!.binding_results?.every(binding => binding.kind === "evidence"))).toBe(true);
});

it("charges a raw and proof twin as one physical root and requires the supporting source text", () => {
  const proof = coverageTask.pool[0]!, twin = rawSourceTwin(proof);
  const subsets = feasibleSubsets([proof, twin, ...coverageTask.pool.slice(1)], () => true, 2);
  expect(subsets.every(rows => new Set(rows.map(root)).size === rows.length)).toBe(true);
  expect(subsets.some(rows => rows.includes(proof) && rows.includes(twin))).toBe(false);
  expect(deliveredInputNumbers(coverageTask, [twin])).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(executedInputNumbers(twin)).toEqual([]);
  const selected = selectSourceSemanticLibraryPage({ candidates: [twin, proof], meter: budget(), fits: rows => rows.length <= 1 });
  expect(selected).toHaveLength(1);
  expect(selected[0]!.proofs).toEqual(proof.proofs);
  expect(deliveredInputNumbers(coverageTask, selected)).toHaveLength(7);
  const missingText = { ...proof, preview: proof.preview.replace(deploymentStatement(1), "") };
  expect(deliveredInputNumbers(coverageTask, [missingText])).toEqual([2, 3, 4, 5, 6, 7]);
  expect(executedInputNumbers(missingText)).toHaveLength(7);
});
