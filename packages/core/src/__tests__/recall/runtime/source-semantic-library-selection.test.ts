import { expect, it } from "vitest";
import { SourceSemanticResourceLedger, sourceSemanticQueryIdentity, type SourceSemanticQuery } from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import { selectSourceSemanticLibraryPage, type SourceSemanticLibraryPackage } from "../../../recall/runtime/source-semantic-library-selection.js";
import { assembleSourceSemanticLibraryIndex, sourceGoldRootIdentity, sourceSemanticLibrarySourceEntry } from "../../../recall/runtime/source-semantic-library-recall.js";
import { deliveredProofFixture, source, query, correspondenceFor } from "./source-semantic-proof-fixture.js";

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

function root(row: SourceSemanticLibraryPackage): string {
  if (row.entry.target.kind !== "source_evidence") throw new Error("source root expected");
  return sourceGoldRootIdentity(row.entry.target);
}

it("matches a tiny exhaustive eligibility oracle after demand saturation without claiming distinct people", () => {
  const pool = [raw("unrelated"), ...qualified, qualified[0]!];
  // Independent subset oracle: root uniqueness, five slots, one demand, qualified exposure.
  let best = 0;
  for (let mask = 0; mask < 1 << pool.length; mask++) {
    const subset = pool.filter((_, index) => mask & 1 << index);
    if (subset.length > 5 || new Set(subset.map(row => JSON.stringify(row.entry.target))).size !== subset.length) continue;
    best = Math.max(best, subset.filter(row => row !== pool[0]).length);
  }
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
  let optimum = 0;
  for (let mask = 0; mask < 1 << pool.length; mask++) {
    const rows = pool.filter((_, index) => mask & 1 << index);
    if (rows.length <= 2) optimum = Math.max(optimum, coverage(rows));
  }
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

it("keeps reserved slots when later selection work exhausts", () => {
  const meter = new SourceSemanticResourceLedger({ work_units: 14, memory_bytes: 20000 });
  const pool = [raw("first"), raw("second", 1), raw("third", 2)];
  const selected = selectSourceSemanticLibraryPage({ candidates: pool, meter, fits: () => {
    meter.charge(5, 0, "actual candidate encoding"); return true;
  } });
  expect(selected.map(row => row.entry.target)).toEqual([pool[0]!.entry.target]);
  expect(meter.spentWork).toBe(13);
});
