import { expect, it } from "vitest";
import { SourceSemanticResourceExhausted, SourceSemanticResourceLedger, type SourceSemanticQuery } from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import {
  selectSourceSemanticLibraryPage, selectSourceSemanticLibraryPageWithReturnedTupleNovelty,
  type SourceSemanticLibraryPackage
} from "../../../recall/runtime/source-semantic-library-selection.js";
import { sourceGoldRootIdentity, sourceSemanticLibrarySourceEntry } from "../../../recall/runtime/source-semantic-library-recall.js";
import { deliveredProofFixture, source, query, correspondenceFor, event, ORIGINAL } from "./source-semantic-proof-fixture.js";

const TOOL_NAMES = ["Pixel", "ThinkPad", "earbuds", "charger", "Kindle"] as const;
const budget = () => new SourceSemanticResourceLedger({ work_units: 1_000_000, memory_bytes: 20_000_000 });
const disclosure: SourceSemanticLibraryPackage["source_disclosure"] = {
  material_kind: "original_body", source_binding: "unbound", evaluated_as_of: "2026-09-18T00:00:00.000Z",
  validity: { kind: "unknown", reason: "unbound" }, temporal_state: "unknown",
  proof_use: { kind: "source_only", qualification: "not_current_proof" }
};

function packaged(
  interpretation: ReturnType<typeof source>, semantics: SourceSemanticQuery, preview: string, position = 0,
  original = ORIGINAL, fixed = true
): SourceSemanticLibraryPackage {
  const actual = deliveredProofFixture({
    interpretation, semantics, correspondence: correspondenceFor(interpretation, semantics, fixed),
    original, library: true
  });
  expect(actual.proof.binding_results?.length).toBeGreaterThan(0);
  return {
    entry: actual.entry, entries: actual.index.entries, explanations: actual.index.explanations ?? [],
    proofs: [actual.proof], preview, source_disclosure: disclosure, access_position: position, payload_support: "available"
  };
}

function aliceTools(
  sourceId: string, tools: readonly string[], semantics: SourceSemanticQuery = query(), position = 0,
  original = ORIGINAL, fixed = true
): SourceSemanticLibraryPackage {
  const names = ["Alice", ...tools, "uses"];
  const sentence = tools.map(name => `Alice uses ${name}.`).join(" ");
  return packaged({
    ...source(),
    source: { ...source().source, source_id: sourceId, content_digest: `sha256:${fieldContractSha256(sentence)}` },
    mentions: names.map((name, index) => ({
      id: `m${name}`, assertion_id: 1, text: name, utf8_span: [0, name.length],
      source_ref: { first: `a1s${index}`, last: `a1s${index}` }
    })),
    referents: ["Alice", ...tools].map(name => ({ id: `r${name}`, referent_kind: "grouped" as const, mentions: [`m${name}`] })),
    frames: tools.map(name => event(`f${name}`, "rAlice", `r${name}`)),
    entry_roots: tools.map(name => `f${name}`),
    asserted_at_scope: tools.map(name => `f${name}`)
  }, semantics, sentence, position, original, fixed);
}

function raw(id: string, position = 0): SourceSemanticLibraryPackage {
  const entry = sourceSemanticLibrarySourceEntry({
    workspaceId: "ws", root_id: id, source_version: "1",
    content_digest: `sha256:${"ab".repeat(32)}`, evidence_object_id: null, hypothesis_id: "library"
  });
  return {
    entry, entries: [entry], explanations: [], proofs: [], preview: "weather", source_disclosure: disclosure,
    access_position: position, payload_support: "not_applicable"
  };
}

function rootOf(row: SourceSemanticLibraryPackage): string {
  if (row.entry.target.kind !== "source_evidence") throw new Error("source root expected");
  return sourceGoldRootIdentity(row.entry.target);
}

function mentionText(row: SourceSemanticLibraryPackage, nodeId: string): string[] {
  const texts = new Set<string>();
  for (const proof of row.proofs) {
    const referent = proof.interpretation.referents.find(item => item.id === nodeId);
    for (const id of referent?.mentions ?? []) {
      const text = proof.interpretation.mentions.find(item => item.id === id)?.text;
      if (text !== undefined) texts.add(text);
    }
  }
  return [...texts];
}

function groundedReturns(row: SourceSemanticLibraryPackage, variable = "tools"): string[] {
  const values: string[] = [];
  for (const proof of row.proofs) for (const binding of proof.binding_results ?? []) {
    const coordinate = binding.returned[variable];
    if (coordinate === undefined) continue;
    const texts = mentionText(row, coordinate.node_id);
    if (texts.length === 1) values.push(texts[0]!);
  }
  return values;
}

function groundedPairs(row: SourceSemanticLibraryPackage): readonly (readonly [string, string])[] {
  const pairs: [string, string][] = [];
  for (const proof of row.proofs) for (const binding of proof.binding_results ?? []) {
    const actor = binding.returned.actor, tools = binding.returned.tools;
    if (actor === undefined || tools === undefined) continue;
    const actors = mentionText(row, actor.node_id), names = mentionText(row, tools.node_id);
    if (actors.length === 1 && names.length === 1) pairs.push([actors[0]!, names[0]!]);
  }
  return pairs;
}

function defaultPage(candidates: readonly SourceSemanticLibraryPackage[], fits: SelectionFits = rows => rows.length <= 5) {
  return selectSourceSemanticLibraryPage({ candidates, meter: budget(), fits });
}
function noveltyPage(candidates: readonly SourceSemanticLibraryPackage[], fits: SelectionFits = rows => rows.length <= 5) {
  return selectSourceSemanticLibraryPageWithReturnedTupleNovelty({ candidates, meter: budget(), fits });
}
type SelectionFits = (rows: readonly SourceSemanticLibraryPackage[]) => boolean;

function tenReports(original = ORIGINAL): SourceSemanticLibraryPackage[] {
  const semantics = query(original);
  return TOOL_NAMES.flatMap(name => [
    aliceTools(`note-${name}-home`, [name], semantics, 0, original),
    aliceTools(`note-${name}-bag`, [name], semantics, 1, original)
  ]);
}

it("keeps every source-grounded tool name from ten reports while default ranking stays unchanged", () => {
  const candidates = tenReports();
  const poolNames = [...new Set(candidates.flatMap(row => groundedReturns(row)))].sort();
  expect(poolNames).toEqual([...TOOL_NAMES].sort());
  expect(candidates).toHaveLength(10);
  const baseline = defaultPage(candidates);
  const again = defaultPage(candidates);
  const selected = noveltyPage(candidates);
  expect(again.map(rootOf)).toEqual(baseline.map(rootOf));
  expect(baseline).toHaveLength(5);
  expect(selected).toHaveLength(5);
  expect(new Set(selected.map(rootOf)).size).toBe(5);
  expect([...new Set(selected.flatMap(row => groundedReturns(row)))].sort()).toEqual([...TOOL_NAMES].sort());
  expect(baseline.every(row => row.proofs.length > 0)).toBe(true);
});

it("treats one accepted binding as a whole two-coordinate tuple and does not mix coordinates", () => {
  const original = "who uses tools?";
  const semantics: SourceSemanticQuery = { ...query(original, false), return_variables: ["actor", "tools"] };
  const aligned = (sourceId: string) => packaged({
    ...source(), source: { ...source().source, source_id: sourceId }
  }, semantics, "Alice uses X. Bob uses Y.", 0, original, false);
  const crossed = (sourceId: string) => {
    const sentence = "Alice uses Y. Bob uses X.", base = source();
    return packaged({
      ...base,
      source: { ...base.source, source_id: sourceId, content_digest: `sha256:${fieldContractSha256(sentence)}` },
      frames: [event("fAlice", "rAlice", "rY"), event("fBob", "rBob", "rX")]
    }, semantics, sentence, 0, original, false);
  };
  const first = aligned("aligned-0"), second = aligned("aligned-1");
  const [rootA, rootB] = rootOf(first) < rootOf(second) ? [first, second] : [second, first];
  let rootC: SourceSemanticLibraryPackage | undefined;
  for (let index = 0; index < 16; index += 1) {
    const candidate = crossed(`crossed-${index}`);
    if (rootOf(rootA) < rootOf(candidate) && rootOf(rootB) < rootOf(candidate)) {
      rootC = candidate;
      break;
    }
  }
  expect(rootC).toBeDefined();
  const A = rootA, B = rootB, C = rootC!;
  expect(rootOf(A) < rootOf(B) && rootOf(B) < rootOf(C)).toBe(true);
  expect(groundedPairs(A)).toEqual([["Alice", "X"], ["Bob", "Y"]]);
  expect(groundedPairs(B)).toEqual([["Alice", "X"], ["Bob", "Y"]]);
  expect(groundedPairs(C)).toEqual([["Alice", "Y"], ["Bob", "X"]]);
  expect(A.proofs[0]!.binding_results).toHaveLength(2);
  expect(B.proofs[0]!.binding_results).toHaveLength(2);
  expect(C.proofs[0]!.binding_results).toHaveLength(2);
  const selected = noveltyPage([A, B, C], rows => rows.length <= 2);
  expect(selected.map(rootOf)).toEqual([rootOf(A), rootOf(C)]);
});

it("credits two complete bindings on one root together and a duplicate tuple only once", () => {
  const joined = aliceTools("desk-pair", ["Pixel", "ThinkPad"]);
  const pixel = aliceTools("pixel-bag", ["Pixel"]);
  const pixelAgain = aliceTools("pixel-home", ["Pixel"]);
  const earbuds = aliceTools("earbuds-run", ["earbuds"]);
  const charger = aliceTools("charger-desk", ["charger"]);
  const kindle = aliceTools("kindle-train", ["Kindle"]);
  expect(groundedReturns(joined).sort()).toEqual(["Pixel", "ThinkPad"]);
  expect(joined.proofs[0]!.binding_results).toHaveLength(2);
  const selected = noveltyPage([pixel, pixelAgain, joined, earbuds, charger, kindle]);
  expect(selected.some(row => rootOf(row) === rootOf(joined))).toBe(true);
  expect(selected.filter(row => rootOf(row) === rootOf(pixel) || rootOf(row) === rootOf(pixelAgain))).toHaveLength(1);
  expect([...new Set(selected.flatMap(row => groundedReturns(row)))].sort()).toEqual([...TOOL_NAMES].sort());
});

it("gives no novelty for unresolved coordinates or ambiguous mention texts and keeps baseline eligibility", () => {
  const unresolvedBase = aliceTools("pixel-unresolved", ["Pixel"]);
  const aliasBase = aliceTools("pixel-alias", ["Pixel"]);
  const thinkPad = aliceTools("thinkpad-home", ["ThinkPad"]);
  const unresolved: SourceSemanticLibraryPackage = {
    ...unresolvedBase,
    proofs: unresolvedBase.proofs.map(proof => ({
      ...proof,
      binding_results: proof.binding_results?.map(binding => ({
        ...binding,
        returned: Object.fromEntries(Object.entries(binding.returned).map(([handle, coordinate]) =>
          [handle, { ...coordinate, node_id: "rMissing" }]))
      }))
    }))
  };
  const target = aliasBase.proofs[0]!.binding_results![0]!.returned.tools!.node_id;
  const ambiguous: SourceSemanticLibraryPackage = {
    ...aliasBase,
    proofs: aliasBase.proofs.map(proof => ({
      ...proof,
      interpretation: {
        ...proof.interpretation,
        mentions: [...proof.interpretation.mentions, {
          id: "mAlias", assertion_id: 1, text: "Pixel-device", utf8_span: [0, 12],
          source_ref: { first: "a1s9", last: "a1s9" }
        }],
        referents: proof.interpretation.referents.map(referent => referent.id === target
          ? { ...referent, mentions: [...referent.mentions, "mAlias"] } : referent)
      }
    }))
  };
  expect(mentionText(ambiguous, target).length).toBeGreaterThan(1);
  const selected = noveltyPage([unresolved, ambiguous, thinkPad]);
  expect(selected.some(row => rootOf(row) === rootOf(thinkPad))).toBe(true);
  expect(selected.map(rootOf).sort()).toEqual([rootOf(unresolved), rootOf(ambiguous), rootOf(thinkPad)].sort());
  expect(selected.map(row => row.selection_basis).every(basis => basis === "direct_answer" || basis === "additional_witness")).toBe(true);
});

it("keeps answer, input, and witness preference above returned-tuple novelty", () => {
  const evidenceQuery: SourceSemanticQuery = {
    ...query(), requested_operation: { reading: "collect tools", support: { kind: "query_text", excerpt: "tools" } },
    alternatives: query().alternatives.map(row => ({ ...row, answer_frames: [], evidence_inputs: [{ frames: ["qUse"] }] }))
  };
  const answer = aliceTools("answered-pixel", ["Pixel"], query(), 9);
  const diverse = TOOL_NAMES.slice(1).map((name, index) => aliceTools(`evidence-${name}`, [name], evidenceQuery, index));
  expect(answer.proofs[0]!.binding_results?.some(binding => binding.kind === "answer" && binding.query_complete)).toBe(true);
  const selected = noveltyPage([diverse[0]!, diverse[1]!, answer, diverse[2]!, diverse[3]!]);
  expect(rootOf(selected[0]!)).toBe(rootOf(answer));
  expect(selected[0]!.selection_basis).toBe("direct_answer");
});

it("rejects a non-fitting novelty exchange and keeps reserved roots after exhaustion", () => {
  const joined = { ...aliceTools("desk-pair", ["Pixel", "ThinkPad"]), preview: "x".repeat(1_000_000) };
  const singles = TOOL_NAMES.map(name => aliceTools(`single-${name}`, [name]));
  const bytes = Buffer.byteLength(JSON.stringify(singles.slice(0, 5))) + 1000;
  const fitted = noveltyPage([joined, ...singles], rows => Buffer.byteLength(JSON.stringify(rows)) <= bytes);
  expect(fitted.some(row => rootOf(row) === rootOf(joined))).toBe(false);
  expect(fitted).toHaveLength(5);
  const meter = new SourceSemanticResourceLedger({ work_units: 10_000, memory_bytes: 2_000_000 });
  let accepted = 0;
  const reserved = selectSourceSemanticLibraryPageWithReturnedTupleNovelty({
    candidates: singles, meter, fits: () => {
      accepted += 1;
      if (accepted > 1) meter.charge(meter.remaining().work_units + 1, 0, "actual candidate encoding");
      return true;
    }
  });
  expect(reserved).toHaveLength(1);
  expect(reserved[0]!.entry.target).toEqual(expect.objectContaining({ kind: "source_evidence" }));
  expect(meter.spentWork).toBeGreaterThan(0);
  expect(reserved.length).toBeLessThan(singles.length);
});

it("exhausts before constructing a returned-tuple key and does not convert that into a ranked page", () => {
  const pixel = aliceTools("pixel-desk", ["Pixel"]);
  const thinkPad = aliceTools("thinkpad-home", ["ThinkPad"]);
  const huge: SourceSemanticLibraryPackage = {
    ...pixel,
    proofs: pixel.proofs.map(proof => ({
      ...proof,
      interpretation: {
        ...proof.interpretation,
        mentions: proof.interpretation.mentions.map(mention => mention.text === "Pixel"
          ? { ...mention, text: "P".repeat(60_000) } : mention)
      }
    }))
  };
  const candidates = [huge, thinkPad];
  const baseline = selectSourceSemanticLibraryPage({
    candidates, meter: new SourceSemanticResourceLedger({ work_units: 1_000_000, memory_bytes: 8_000 }), fits: () => true
  });
  expect(baseline).toHaveLength(2);
  const meter = new SourceSemanticResourceLedger({ work_units: 1_000_000, memory_bytes: 8_000 });
  const selected = selectSourceSemanticLibraryPageWithReturnedTupleNovelty({
    candidates, meter, fits: () => true
  });
  expect(selected.length).toBeLessThan(baseline.length);
  expect(meter.spentBytes).toBeGreaterThan(0);
});

function minWorkForCount(candidates: readonly SourceSemanticLibraryPackage[], count: number): number {
  const probe = new SourceSemanticResourceLedger({ work_units: 1_000_000, memory_bytes: 2_000_000 });
  selectSourceSemanticLibraryPageWithReturnedTupleNovelty({ candidates, meter: probe, fits: () => true });
  let lo = 1, hi = Math.max(1, probe.spentWork), found = hi;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const selected = selectSourceSemanticLibraryPageWithReturnedTupleNovelty({
      candidates, meter: new SourceSemanticResourceLedger({ work_units: mid, memory_bytes: 2_000_000 }), fits: () => true
    });
    if (selected.length >= count) { found = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  return found;
}

class RankingPhaseLedger extends SourceSemanticResourceLedger {
  exhaustedPhase: string | undefined;
  override reserve(work: number, bytes: number, phase = "preparation"): void {
    try { super.reserve(work, bytes, phase); }
    catch (error) {
      if (error instanceof SourceSemanticResourceExhausted) this.exhaustedPhase = error.phase;
      throw error;
    }
  }
}

function observeRankingBudget(candidates: readonly SourceSemanticLibraryPackage[], work: number) {
  let firstAccepted: SourceSemanticLibraryPackage | undefined;
  const meter = new RankingPhaseLedger({ work_units: work, memory_bytes: 2_000_000 });
  const selected = selectSourceSemanticLibraryPageWithReturnedTupleNovelty({
    candidates, meter, fits: page => {
      if (page.length === 1 && firstAccepted === undefined) firstAccepted = page[0];
      return true;
    }
  });
  return { selected, firstAccepted, phase: meter.exhaustedPhase };
}

it("keeps the first fit root when a real work budget exhausts during later returned-tuple ranking", () => {
  const candidates = ["Pixel", "ThinkPad", "earbuds"].map(name => aliceTools(`rank-${name}`, [name]));
  const oneWork = minWorkForCount(candidates, 1);
  const twoWork = minWorkForCount(candidates, 2);
  expect(twoWork).toBeGreaterThan(oneWork);
  let observed = observeRankingBudget(candidates, twoWork - 1);
  if (observed.phase !== "returned tuple ranking") {
    for (let work = twoWork - 2; work > oneWork; work -= 1) {
      observed = observeRankingBudget(candidates, work);
      if (observed.phase === "returned tuple ranking") break;
    }
  }
  expect(observed.phase).toBe("returned tuple ranking");
  expect(observed.selected).toHaveLength(1);
  expect(observed.firstAccepted).toBeDefined();
  expect(rootOf(observed.selected[0]!)).toBe(rootOf(observed.firstAccepted!));
});

it("matches default order and accounting for raw-only input and source-access order", () => {
  const rawPool = [raw("first", 0), raw("second", 1), raw("third", 2)];
  const defaultMeter = budget(), noveltyMeter = budget();
  const baseline = selectSourceSemanticLibraryPage({ candidates: rawPool, meter: defaultMeter, fits: () => true });
  const experimental = selectSourceSemanticLibraryPageWithReturnedTupleNovelty({
    candidates: rawPool, meter: noveltyMeter, fits: () => true
  });
  expect(experimental.map(row => row.entry.target)).toEqual(baseline.map(row => row.entry.target));
  expect(experimental.map(row => row.selection_basis)).toEqual(baseline.map(row => row.selection_basis));
  expect(noveltyMeter.spentWork).toBe(defaultMeter.spentWork);
  expect(noveltyMeter.spentBytes).toBe(defaultMeter.spentBytes);
  const mixed = [raw("canonical-first", 0), aliceTools("late-answer", ["Pixel"], query(), 2), raw("query-related", 1)];
  const accessFits = (rows: readonly SourceSemanticLibraryPackage[]) => rows.length <= 2;
  const accessMeter = budget(), experimentalAccessMeter = budget();
  const access = selectSourceSemanticLibraryPage({
    candidates: mixed, meter: accessMeter, fits: accessFits, order: "source_access"
  });
  const experimentalAccess = selectSourceSemanticLibraryPageWithReturnedTupleNovelty({
    candidates: mixed, meter: experimentalAccessMeter, fits: accessFits, order: "source_access"
  });
  expect(experimentalAccess.map(rootOf)).toEqual(access.map(rootOf));
  expect(experimentalAccess.every(row => row.selection_basis === "source_access")).toBe(true);
  expect(experimentalAccessMeter.spentWork).toBe(accessMeter.spentWork);
  expect(experimentalAccessMeter.spentBytes).toBe(accessMeter.spentBytes);
});

it("applies the same returned-tuple heuristic to one-example and all-names questions", () => {
  const allQuestion = "which tools does Alice use?";
  const oneQuestion = "name one of the tools Alice uses";
  expect(query(allQuestion).original_query_digest).not.toBe(query(oneQuestion).original_query_digest);
  const allCandidates = tenReports(allQuestion);
  const oneCandidates = tenReports(oneQuestion);
  const allSelected = noveltyPage(allCandidates);
  const oneSelected = noveltyPage(oneCandidates);
  const allCovered = [...new Set(allSelected.flatMap(row => groundedReturns(row)))].sort();
  const oneCovered = [...new Set(oneSelected.flatMap(row => groundedReturns(row)))];
  expect(allCovered).toEqual([...TOOL_NAMES].sort());
  expect(oneCovered.length).toBeGreaterThan(0);
  expect(TOOL_NAMES.some(name => oneCovered.includes(name))).toBe(true);
  expect(allSelected).toHaveLength(5);
  expect(oneSelected).toHaveLength(5);
  expect(oneSelected.map(row => row.selection_basis)).toEqual(allSelected.map(row => row.selection_basis));
});
