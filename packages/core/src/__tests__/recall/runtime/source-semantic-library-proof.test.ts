import { expect, it } from "vitest";
import { hashSourceRecordId, interpretationNodeIdentity } from "@do-soul/alaya-protocol";
import { SOURCE_SEMANTIC_REASONING_BUDGET } from "../../../recall/runtime/source-semantic-reasoning.js";
import { deliveredSourceSemanticLibraryProof } from "../../../recall/runtime/source-semantic-library-proof.js";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import { source, query, correspondenceFor, deliveredProofFixture } from "./source-semantic-proof-fixture.js";
import { finiteSource, finiteQuery, finiteCorrespondence, FINITE_QUERY } from "./source-semantic-finite-fixture.js";
import { BindingContextStore, encodeBindingContext } from "../../../recall/conditional-field/engine/binding-environment.js";


it("requires independently supplied publication provenance for a native conditional proof", () => {
  const { record, proof, index, entry, qualifier } = deliveredProofFixture();
  expect(deliveredSourceSemanticLibraryProof(index, entry, qualifier, [proof], record).proof).toBe(proof);
  expect(deliveredSourceSemanticLibraryProof(index, entry, qualifier, [proof]).proof).toBeUndefined();
});

it.each(["root", "workspace", "version", "digest", "record"] as const)("rejects a proof rebound to another %s", (kind) => {
  const { record, proof, index, entry, qualifier, target } = deliveredProofFixture();
  const changedRecord = { ...record, source_id: "forged-source", workspace_id: "other-workspace" };
  changedRecord.identity = hashSourceRecordId(changedRecord, fieldContractSha256);
  const changed = { ...target,
    ...(kind === "root" ? { root_id: "forged-root" } : kind === "workspace" ? { workspace_id: "other-workspace" }
      : kind === "version" ? { source_version: "another-version" } : kind === "digest" ? { content_digest: `sha256:${"00".repeat(32)}` }
        : { root_id: changedRecord.identity, workspace_id: changedRecord.workspace_id }) };
  const forged = { ...proof, source_target: changed, ...(kind === "record" ? { source_record: changedRecord } : {}) };
  expect(deliveredSourceSemanticLibraryProof(index, { ...entry, target: changed }, qualifier, [forged], record).proof).toBeUndefined();
});

it.each([null, undefined])("does not promote unknown source scope to project (%s)", (scope_class) => {
  const { record, proof, index, entry, qualifier } = deliveredProofFixture();
  const unbound = { ...record, scope_class };
  expect(deliveredSourceSemanticLibraryProof(index, entry, qualifier, [{ ...proof, source_record: unbound }], unbound).proof).toBeUndefined();
});

it("rejects an occupied entry rebound to another evidence object within the same source root", () => {
  const { record, proof, index, entry, qualifier, target } = deliveredProofFixture({ library: true });
  const rebound = { ...entry, target: { ...target, evidence_object_id: "another-evidence-object" } };
  expect(deliveredSourceSemanticLibraryProof(index, rebound, qualifier, [proof], record).verified_proofs).toEqual([]);
});

it("retains the executed proof root identity when delivery adds a source window", () => {
  const { record, proof, index, entry, qualifier, target } = deliveredProofFixture({ library: true });
  const delivered = { ...entry, target: { ...target, span: { content_start: 0, content_end: 24,
    retained_extent: "body" as const, content_complete: true, original_complete: false } } };
  expect(proof.source_target?.span).toBeUndefined();
  expect(deliveredSourceSemanticLibraryProof(index, delivered, qualifier, [proof], record).proof).toBe(proof);
  expect(deliveredSourceSemanticLibraryProof(index, { ...delivered, target: { ...delivered.target,
    evidence_object_id: "other-object" } }, qualifier, [proof], record).proof).toBeUndefined();
  expect(deliveredSourceSemanticLibraryProof(index, { ...delivered, target: { ...delivered.target,
    span: { ...delivered.target.span, content_complete: false } } }, qualifier, [proof], record).proof).toBeUndefined();
});

it.each([false, true])("binds delivered coordinates and alternatives to the execution witness (library namespace=%s)", (library) => {
  const { record, proof, index, entry, qualifier } = deliveredProofFixture({ library });
  expect(deliveredSourceSemanticLibraryProof(index, entry, qualifier, [proof], record).proof).toBe(proof);
  for (const mutation of ["coordinate", "alternative", "rehashed_binding", "acceptance_marker"] as const) {
    const forged = structuredClone(proof), answer = forged.binding_results!.find((row) => row.binding_id === entry.output_binding)!;
    let changedEntry = entry;
    if (mutation === "alternative") Object.assign(answer, { alternative: 1 });
    else if (mutation === "coordinate") {
      Object.assign(answer.bindings.tools!, { node_id: "rY" });
      Object.assign(answer.returned.tools!, { node_id: "rY" });
    } else {
      const declared = new Map(Object.entries(answer.bindings).map(([variable, coordinate]) => [variable, interpretationNodeIdentity(coordinate)]));
      if (mutation === "acceptance_marker") declared.set("@accepted:999", interpretationNodeIdentity(answer.bindings.use!));
      const binding = encodeBindingContext(declared, new BindingContextStore(1_000_000));
      Object.assign(answer, { binding_id: binding });
      changedEntry = { ...entry, output_binding: binding };
    }
    expect(deliveredSourceSemanticLibraryProof(index, changedEntry, qualifier, [forged], record).proof, mutation).toBeUndefined();
  }
});

it("keeps proof verification exhaustion unavailable", () => {
  const { record, proof, index, entry, qualifier } = deliveredProofFixture();
  const evaluated = deliveredSourceSemanticLibraryProof(index, entry, qualifier, [proof], record,
    { ...SOURCE_SEMANTIC_REASONING_BUDGET, work_units: 100, finalization_reserve: 10 });
  expect(evaluated.proof).toBeUndefined();
  expect(evaluated.resource_usage.work_units).toBeGreaterThan(0);
  expect(evaluated.resource_usage.work_units).toBeLessThanOrEqual(100);
  expect(evaluated.resource_usage.memory_bytes).toBeGreaterThan(0);
});

it("reports fresh evaluator cost independently of the retained proof's generation usage", () => {
  const { record, proof, index, entry, qualifier } = deliveredProofFixture();
  const claimed = { ...proof, resource_usage: { ...proof.resource_usage!, work_units: 123_456_789 } };
  const evaluated = deliveredSourceSemanticLibraryProof(index, entry, qualifier, [claimed], record);
  expect(evaluated.proof).toBe(claimed);
  expect(evaluated.resource_usage.work_units).toBeGreaterThan(0);
  expect(evaluated.resource_usage.work_units).toBeLessThanOrEqual(SOURCE_SEMANTIC_REASONING_BUDGET.work_units);
  expect(evaluated.resource_usage.work_units).not.toBe(claimed.resource_usage.work_units);
});

it("rejects substitution of another admitted alternative while preserving its original binding", () => {
  const interpretation = source(), initial = query();
  const semantics = { ...initial, alternatives: [...initial.alternatives, initial.alternatives[0]!] };
  const original = correspondenceFor(interpretation, semantics);
  const correspondence = { ...original, correspondences: [...original.correspondences,
    ...original.correspondences.flatMap((row) => row.query_endpoint.kind === "referent" ? []
      : [{ ...row, query_endpoint: { ...row.query_endpoint, alternative: 1 } }])] };
  const { record, proof, index, entry, qualifier } = deliveredProofFixture({ interpretation, semantics, correspondence, library: true });
  expect(new Set(proof.binding_results?.map((answer) => answer.alternative))).toEqual(new Set([0, 1]));
  expect(deliveredSourceSemanticLibraryProof(index, entry, qualifier, [proof], record).proof).toBe(proof);
  const forged = structuredClone(proof), answer = forged.binding_results!.find((row) => row.binding_id === entry.output_binding)!;
  Object.assign(answer, { alternative: answer.alternative === 0 ? 1 : 0 });
  expect(deliveredSourceSemanticLibraryProof(index, entry, qualifier, [forged], record).proof).toBeUndefined();
});

it.each(["instantiation", "query_entity", "universal", "comparison"] as const)("admits actual %s witnesses through the same projection owner", (kind) => {
  let interpretation = finiteSource(), semantics = finiteQuery(kind === "universal" || kind === "comparison");
  if (kind === "query_entity") {
    interpretation = { ...interpretation, domains: interpretation.domains!.map((row) => ({ ...row, closure: { kind: "open" as const } })) };
    semantics = { ...semantics, variables: semantics.variables.map((row) => row.id === "actor"
      ? { ...row, reference: { kind: "query_text" as const, excerpt: "New" } } : row) };
  }
  if (kind === "comparison") semantics = { ...semantics, variables: [{ id: "actor", sort: "entity" }],
    alternatives: [{ frames: [], context_obligations: [] }], return_variables: ["actor"],
    evaluation: { kind: "comparison", domain: "people", operation: "minimum", left: "actor", strict: false,
      metric: "speed", unit: "ms", context: "lab", scope: "asserted" } };
  let correspondence = finiteCorrespondence(interpretation, semantics);
  if (kind === "query_entity") correspondence = { ...correspondence, membership_assumptions: [{ query_variable: "actor", source_domain: "users",
    restrictions: [], status: "member", query_support: { kind: "query_text", excerpt: "New" }, description: "Assume New belongs to users." }] };
  if (kind === "comparison") correspondence = { ...correspondence, correspondences: [] };
  const budget = { ...SOURCE_SEMANTIC_REASONING_BUDGET, work_units: 10_000_000, memory_bytes: 60_000_000, finalization_reserve: 50_000 };
  const { record, proof, index, entry, qualifier } = deliveredProofFixture({ interpretation, semantics, correspondence,
    original: FINITE_QUERY, library: true, budget });
  expect(proof.outcome.status).toBe("interpreted");
  if (kind === "instantiation" || kind === "query_entity") expect(proof.derived_nodes?.some((row) => row.kind === kind)).toBe(true);
  else expect(proof.evaluation?.status).toBe("supported");
  expect(deliveredSourceSemanticLibraryProof(index, entry, qualifier, [proof], record, budget).proof).toBe(proof);
  const forged = structuredClone(proof), answer = forged.binding_results!.find((row) => row.binding_id === entry.output_binding)!;
  Object.assign(answer, { alternative: 999 });
  expect(deliveredSourceSemanticLibraryProof(index, entry, qualifier, [forged], record, budget).proof).toBeUndefined();
}, 15_000);
