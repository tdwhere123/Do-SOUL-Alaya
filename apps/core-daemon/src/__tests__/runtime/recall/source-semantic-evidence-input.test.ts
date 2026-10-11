import { expect, it } from "vitest";
import { deliveredSourceSemanticLibraryProof, projectSourceSemanticQuerySupport,
  executeSourceSemanticInterpretation, assembleSourceSemanticLibraryIndex, fieldContractSha256, slotQualifiersFor,
  admitSourceSemanticCorrespondence } from "@do-soul/alaya-core";
import { sourceSemanticQueryBranchViews } from "@do-soul/alaya-protocol";
import { correspondenceFor, deliveredProofFixture, query as simpleQuery, source as simpleSource,
  BUDGET as BASE_BUDGET } from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-proof-fixture.js";
import { authoredSource, authoredAlignment, evidenceQuery, mentionTexts, COUNT, DURATION } from "./source-semantic-evidence-input-support.js";

// Explicit finite-engine witness control. Production defaults are unchanged; the low-budget case below remains partial.
const BUDGET = { ...BASE_BUDGET, work_units: 10_000_000 };
const fixtures = new Map<string, ReturnType<typeof deliveredProofFixture>>();

function fixture(name: string, kind: "count" | "duration", direct = true) {
  const key = JSON.stringify([name, kind, direct]), cached = fixtures.get(key);
  if (cached !== undefined) return cached;
  const interpretation = authoredSource(name), semantics = evidenceQuery(kind, direct), original = kind === "count" ? COUNT : DURATION;
  const correspondence = authoredAlignment(interpretation, semantics, original);
  const result = deliveredProofFixture({ interpretation, semantics, correspondence, original, library: true, budget: BUDGET });
  fixtures.set(key, result);
  return result;
}

it.each([
  ["forum-final", "count", "four"], ["personnel-summary", "duration", "twelve"]
] as const)("proves the fully qualified direct answer in %s without requiring operand events", (name, kind, value) => {
  const { proof, index, entry, qualifier, record } = fixture(name, kind);
  expect(proof.query.gaps).toEqual([]);
  expect(proof.binding_results).toHaveLength(1);
  const binding = proof.binding_results![0]!;
  expect(binding).toMatchObject({ kind: "answer", query_complete: true });
  expect(mentionTexts(proof.interpretation, binding.returned.amount!.node_id)).toEqual([value]);
  expect(qualifier.support).toMatchObject({ answer: "supported", operation: "not_executed" });
  expect(qualifier.support!.evidence_inputs.every(row => row.status === "open")).toBe(true);
  expect(deliveredSourceSemanticLibraryProof(index, entry, qualifier, [proof], record, BUDGET).verified_proofs).toEqual([proof]);
  for (const role of kind === "count" ? ["population", "actual participation", "date"] : ["calendar scope", "employee", "unit"]) {
    const queryRole = proof.query.alternatives[0]!.frames.find(frame => frame.id === "answer")!.role_requirements.find(row => row.role_reading === role)!;
    const without = { ...proof.semantic_correspondence, correspondences: proof.semantic_correspondence.correspondences.filter(row =>
      row.query_endpoint.kind !== "slot" || row.query_endpoint.frame !== "answer" || row.query_endpoint.slot !== queryRole.id) };
    const result = executeSourceSemanticInterpretation({ source_interpretation: proof.interpretation, query_semantics: proof.query,
      semantic_correspondence: without, original_query: proof.original_query, workspaceId: "ws", scope: "project", authorizedScopes: ["project"],
      asOf: index.as_of! }).result;
    expect(result.binding_results ?? [], role).toEqual([]);
  }
}, 90_000);

it("keeps an unfinished evidence phase partial even when the direct-answer phase exhausted empty", () => {
  const interpretation = authoredSource("forum-notebook"), query = evidenceQuery("count"), correspondence = authoredAlignment(interpretation, query, COUNT);
  const executed = executeSourceSemanticInterpretation({ source_interpretation: interpretation, query_semantics: query,
    semantic_correspondence: correspondence, original_query: COUNT, workspaceId: "ws", scope: "project", authorizedScopes: ["project"],
    asOf: "2026-09-18T00:00:00.000Z" });
  expect(executed.result.outcome.status).toBe("resource_exhausted");
  expect(executed.result.completeness?.logical_index).toBe("partial");
  expect(executed.index?.completeness.logical_index).toBe("partial");
  expect(projectSourceSemanticQuerySupport(query, executed.result.binding_results ?? [])).toMatchObject({
    answer: "open", evidence_inputs: [{ alternative: 0, input: 0, status: "open" }] });
});

it("keeps invited AND actually spoke on one person and event without counting local IDs or merging equal names", () => {
  const { proof, index, entry, qualifier, record } = fixture("forum-notebook", "count");
  expect(proof.binding_results).toHaveLength(3);
  expect(proof.binding_results!.every(row => row.kind === "evidence" && row.input === 0 && !row.query_complete)).toBe(true);
  const people = proof.binding_results!.map(row => row.returned.person!.node_id);
  expect(new Set(people).size).toBe(2);
  expect(people.map(id => mentionTexts(proof.interpretation, id).some(text => text.includes("Amir Chen")))).toEqual([true, true, true]);
  expect(qualifier.support).toEqual({ answer: "open", evidence_inputs: [{ alternative: 0, input: 0, status: "supported" }],
    operation: "not_executed", compatibility: "unknown", distinctness: "unknown" });
  expect(qualifier.witnesses).toHaveLength(3);
  expect(deliveredSourceSemanticLibraryProof(index, entry, qualifier, [proof], record, BUDGET).proof).toBe(proof);
  const views = sourceSemanticQueryBranchViews(proof.query.alternatives[0]!);
  expect(views[1]!.alternative.frames.map(frame => frame.id)).toEqual(["invited", "spoke"]);
  const withoutInvitation = { ...proof.semantic_correspondence, correspondences: proof.semantic_correspondence.correspondences.filter(row =>
    row.query_endpoint.kind === "referent" || row.query_endpoint.frame !== "invited") };
  const admitted = admitSourceSemanticCorrespondence({
    source_interpretation: proof.interpretation, query_semantics: proof.query,
    semantic_correspondence: withoutInvitation, original_query: COUNT });
  expect(admitted.kind).toBe("admitted");
  if (admitted.kind !== "admitted") throw new Error("withoutInvitation correspondence must be admitted");
  expect(executeSourceSemanticInterpretation({ source_interpretation: proof.interpretation, query_semantics: proof.query,
    semantic_correspondence: withoutInvitation, original_query: COUNT, workspaceId: "ws", scope: "project", authorizedScopes: ["project"],
    asOf: index.as_of!,
    request: { contract: "source-interpretation-reasoning-v5", accepts_unreviewed_conditional_results: true,
      source_interpretation_id: admitted.interpretation_id, query_semantics_id: admitted.query_id,
      semantic_correspondence_id: admitted.semantic_correspondence_id, original_query: COUNT,
      budget: BUDGET, output_byte_limit: 1_000_000 } }).result.binding_results).toEqual([]);
}, 90_000);

it("retains two dates as individually supported inputs with unknown cross-source compatibility and no subtraction", () => {
  const joining = fixture("joining-note", "duration"), promotion = fixture("promotion-note", "duration");
  for (const [index, row] of [joining, promotion].entries()) {
    expect(row.proof.binding_results).toHaveLength(1);
    expect(row.proof.binding_results![0]).toMatchObject({ kind: "evidence", input: index, query_complete: false });
    expect(row.qualifier.support!.evidence_inputs.map(input => input.status)).toEqual(index === 0 ? ["supported", "open"] : ["open", "supported"]);
  }
  const combined = projectSourceSemanticQuerySupport(joining.proof.query,
    [...joining.proof.binding_results!, ...promotion.proof.binding_results!]);
  expect(combined).toEqual({ answer: "open", evidence_inputs: [{ alternative: 0, input: 0, status: "supported" },
    { alternative: 0, input: 1, status: "supported" }], operation: "not_executed", compatibility: "unknown", distinctness: "unknown" });
  expect(joining.proof.binding_results![0]!.bindings.employee).not.toEqual(promotion.proof.binding_results![0]!.bindings.employee);
}, 90_000);

it.each([["forum-notebook", "count"], ["joining-note", "duration"]] as const)
("keeps gap-free %s inputs unrepresented as answers through native library verification", (name, kind) => {
  const { proof, index, entry, qualifier, record } = fixture(name, kind, false);
  expect(proof.query.gaps).toEqual([]);
  expect(proof.query.alternatives[0]!.answer_frames).toEqual([]);
  expect(proof.query.requested_operation).toBeDefined();
  expect(proof.binding_results!.length).toBeGreaterThan(0);
  expect(proof.binding_results!.every(binding => binding.kind === "evidence" && binding.query_complete === false)).toBe(true);
  expect(qualifier.support).toEqual({ answer: "unrepresented", evidence_inputs: kind === "count"
    ? [{ alternative: 0, input: 0, status: "supported" }]
    : [{ alternative: 0, input: 0, status: "supported" }, { alternative: 0, input: 1, status: "open" }],
    operation: "not_executed", compatibility: "unknown", distinctness: "unknown" });
  expect(deliveredSourceSemanticLibraryProof(index, entry, qualifier, [proof], record, BUDGET).verified_proofs).toEqual([proof]);
}, 90_000);

it("leaves a past-use question open against an assertion of future use when past meaning is a located gap", () => {
  const original = "which tools did Alice use?";
  const prospectiveText = "Alice will use X. Bob will use Y.";
  const base = simpleSource();
  const prospective = {
    ...base,
    source: { ...base.source, content_digest: `sha256:${fieldContractSha256(prospectiveText)}` },
    mentions: base.mentions.map(row => row.id === "muses" ? { ...row, text: "will use", utf8_span: [0, 8] as const } : row),
    frames: base.frames.map(row => ({ ...row, predicate_support: { ...row.predicate_support, reading: "will use" } }))
  };
  const bare = simpleQuery(original);
  const past = { ...bare, gaps: [{ kind: "unsupported_meaning" as const, affected_ids: ["use"],
    support: [{ kind: "query_text" as const, excerpt: "did Alice use" }],
    description: "The bare use predicate does not encode past use." }] };
  const bareProof = deliveredProofFixture({ interpretation: prospective, semantics: bare,
    correspondence: correspondenceFor(prospective, bare), original, library: true });
  const limitedProof = deliveredProofFixture({ interpretation: prospective, semantics: past,
    correspondence: correspondenceFor(prospective, past), original, library: true });
  expect(bareProof.proof.binding_results?.[0]).toMatchObject({ kind: "answer", query_complete: true });
  expect(limitedProof.proof.binding_results?.[0]).toMatchObject({ kind: "answer", query_complete: false });
  expect(limitedProof.proof.query_gaps).toMatchObject([{ affected_ids: ["use"],
    support: [{ excerpt: "did Alice use" }] }]);
  expect(limitedProof.qualifier.support?.answer).toBe("open");
});

it("preserves every shared-person conjunction binding when condition and correspondence input order reverse", () => {
  const forward = fixture("forum-notebook", "count");
  const query = { ...forward.proof.query, alternatives: forward.proof.query.alternatives.map(body => ({
    ...body, frames: [...body.frames].reverse(), evidence_inputs: body.evidence_inputs?.map(input => ({ frames: [...input.frames].reverse() }))
  })) };
  const authored = authoredAlignment(forward.proof.interpretation, query, COUNT);
  const correspondence = { ...authored, correspondences: [...authored.correspondences].reverse() };
  const reversed = deliveredProofFixture({ interpretation: forward.proof.interpretation, semantics: query,
    correspondence, original: COUNT, library: true, budget: BUDGET });
  // Reordered query semantics and semantic correspondence have their own computation identity; compare retained coordinates within the same authored source interpretation.
  const bindings = (proof: typeof forward.proof) => proof.binding_results!.map(row =>
    JSON.stringify(Object.entries(row.bindings).map(([variable, coordinate]) =>
      [variable, coordinate.packet_id, coordinate.node_id]).sort(([left], [right]) => left!.localeCompare(right!)))).sort();
  expect(forward.proof.outcome.status).toBe("interpreted");
  expect(reversed.proof.outcome.status).toBe("interpreted");
  expect(bindings(reversed.proof)).toEqual(bindings(forward.proof));
  expect(reversed.qualifier.support).toEqual(forward.qualifier.support);
}, 90_000);

// Three complete native proof replays need a larger wall-clock allowance under V8 coverage.
it("keeps all binding witnesses in one occupied root and rejects a forged nonrepresentative sibling", () => {
  const { proof, index: branch, record } = fixture("forum-notebook", "count");
  const { index } = assembleSourceSemanticLibraryIndex({ query_id: branch.query_id, snapshot_id: branch.snapshot_id,
    interpretation_id: branch.interpretation_id!, as_of: branch.as_of!, proof_groups: [{ entries: branch.entries, explanations: branch.explanations }],
    source_entries: [], truncated: false, open_residuals: false });
  expect(index.entries).toHaveLength(1);
  const entry = index.entries[0]!, qualifier = slotQualifiersFor(index, [proof])[0]!;
  expect(qualifier.witnesses).toHaveLength(3);
  expect(deliveredSourceSemanticLibraryProof(index, entry, qualifier, [proof], record, BUDGET).proof).toBe(proof);
  const forged = structuredClone(proof), sibling = forged.binding_results!.find(row => row.binding_id !== entry.output_binding)!;
  Object.assign(sibling, { input: 15 });
  expect(deliveredSourceSemanticLibraryProof(index, entry, qualifier, [forged], record, BUDGET).verified_proofs).toEqual([]);
  const missing = { ...index, explanations: index.explanations!.filter(row => !sibling.explanation_ids.includes(row.derivation_id)) };
  expect(deliveredSourceSemanticLibraryProof(missing, entry, qualifier, [proof], record, BUDGET).proof).toBeUndefined();
}, 180_000);
