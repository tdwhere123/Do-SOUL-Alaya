import { expect, it } from "vitest";
import { ORDINARY_NATIVE_FIELD_RESULT_VERSION, QueryViewSchema, hashSourceRecordId, interpretationNodeIdentity } from "@do-soul/alaya-protocol";
import { SOURCE_SEMANTIC_REASONING_BUDGET } from "../../../recall/runtime/source-semantic-reasoning.js";
import { SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";
import { sourceSemanticSupportExtent } from "../../../memory/evidence-create/source-semantic-support-window.js";
import { deliveredSourceSemanticLibraryProof } from "../../../recall/runtime/source-semantic-library-proof.js";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import { source, query, correspondenceFor, deliveredProofFixture, ORIGINAL, CLOCK } from "./source-semantic-proof-fixture.js";
import { compileConditionalFieldQuery } from "../../../recall/conditional-field/query/compile-query.js";

/** The trusted request that a field page is compiled from. The page's query identity
 * is Core's compiled identity of this request, so a verifier can bind the delivered
 * page to its proof's own query without trusting the page. */
const FIELD_BUDGET = { schema_version: 1 as const, work_units: 10_000_000, memory_bytes: 60_000_000,
  page_budget: 100, finalization_reserve: 50_000, min_envelope: 10 };
const FIELD_COMPILE_INPUT = { source: "ordinary" as const, text: ORIGINAL, snapshot_id: `sha256:${"a".repeat(64)}`,
  budget: FIELD_BUDGET, interpretation_clock: CLOCK, authorized_scopes: null,
  view: QueryViewSchema.parse({ schema_version: 1 as const, requested_roles: ["requested", "associated"] as const,
    enumeration_policy: "native_query" as const, result_kind_view: "mixed" as const,
    delivery_budget: { max_total_tokens: FIELD_BUDGET.memory_bytes, max_encoded_bytes: FIELD_BUDGET.memory_bytes } }) };
const FIELD_QUERY_ID = compileConditionalFieldQuery(FIELD_COMPILE_INPUT).query_id;
const FIELD_BODY_BYTES = Buffer.byteLength("Alice uses X. Bob uses Y.", "utf8");
const FIELD_TRUST = { compile_input: FIELD_COMPILE_INPUT, source_body_bytes: FIELD_BODY_BYTES };
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
  const bodyBytes = Buffer.byteLength("Alice uses X. Bob uses Y.", "utf8");
  const delivered = { ...entry, target: { ...target, span: { content_start: 0, content_end: bodyBytes,
    retained_extent: "body" as const, content_complete: true, original_complete: false } } };
  expect(proof.source_target?.span).toBeUndefined();
  // The fixture has no assertion locations, so the whole-body fallback applies and
  // needs the authoritative extent as well as the delivered interval.
  const trust = { source_body_bytes: bodyBytes };
  expect(deliveredSourceSemanticLibraryProof(index, delivered, qualifier, [proof], record,
    SOURCE_SEMANTIC_REASONING_BUDGET, trust).proof).toBe(proof);
  expect(deliveredSourceSemanticLibraryProof(index, { ...delivered, target: { ...delivered.target,
    evidence_object_id: "other-object" } }, qualifier, [proof], record,
    SOURCE_SEMANTIC_REASONING_BUDGET, trust).proof).toBeUndefined();
  expect(deliveredSourceSemanticLibraryProof(index, { ...delivered, target: { ...delivered.target,
    span: { ...delivered.target.span, content_complete: false } } }, qualifier, [proof], record,
    SOURCE_SEMANTIC_REASONING_BUDGET, trust).proof).toBeUndefined();
});

it("binds a root-bound executed proof to its authoritative dependency support locations", () => {
  const { execution, interpretation } = deliveredProofFixture({
    assertionLocations: [{ assertion_id: 1, source_utf8_span: [0, 18] }] });
  expect(execution.index).not.toBeNull();
  expect(execution.source_dependencies?.length ?? 0).toBeGreaterThan(0);
  const meter = new SourceSemanticResourceLedger(SOURCE_SEMANTIC_REASONING_BUDGET);
  expect(sourceSemanticSupportExtent(interpretation, execution.source_dependencies!, meter))
    .toEqual({ status: "located", start: 0, end: 18 });
});

/** A field page's proof is authored through the same scoped-branch owner the daemon
 * producer uses; only the page family differs. */
function fieldProofFixture(input: Parameters<typeof deliveredProofFixture>[0] = {}) {
  const fixture = deliveredProofFixture({ ...input, library: true });
  return { ...fixture, index: { ...fixture.index, query_id: FIELD_QUERY_ID,
    result_version: ORDINARY_NATIVE_FIELD_RESULT_VERSION } };
}

it("verifies a field-family proof only through its actual visible support interval", () => {
  const { record, proof, index, entry, qualifier, target } = fieldProofFixture();
  const fieldIndex = index;
  // The field page delivers the source slot, not a proof entry: no interpretation
  // node or explanation list. The side qualifier carries the proof binding.
  const slot = { ...entry, interpretation_node: undefined, explanation_ids: [],
    target: { ...target, span: { content_start: 0, content_end: FIELD_BODY_BYTES, retained_extent: "body" as const,
      content_complete: true, original_complete: true } } };
  expect(deliveredSourceSemanticLibraryProof(fieldIndex, slot, qualifier, [proof], record,
    SOURCE_SEMANTIC_REASONING_BUDGET, FIELD_TRUST).proof).toBe(proof);
  // The delivered page's query identity is its trusted request's identity, and that
  // request is this proof's own query: a page carrying a foreign query id does not
  // verify even when every other delivered binding is unchanged.
  const foreign = { ...fieldIndex, query_id: `sha256:${"f".repeat(64)}` };
  expect(deliveredSourceSemanticLibraryProof(foreign, slot, qualifier, [proof], record,
    SOURCE_SEMANTIC_REASONING_BUDGET, FIELD_TRUST).proof).toBeUndefined();
  // Without the trusted request there is no binding to the page at all.
  expect(deliveredSourceSemanticLibraryProof(fieldIndex, slot, qualifier, [proof], record).proof).toBeUndefined();
  // A trusted request for another query does not adopt this page's proof.
  expect(deliveredSourceSemanticLibraryProof(fieldIndex, slot, qualifier, [proof], record,
    SOURCE_SEMANTIC_REASONING_BUDGET,
    { compile_input: { ...FIELD_COMPILE_INPUT, text: "which tools does Bob use?" } }).proof).toBeUndefined();
  // Without a delivered interval there is no visible support, so nothing verifies.
  expect(deliveredSourceSemanticLibraryProof(fieldIndex, { ...slot, target },
    qualifier, [proof], record, SOURCE_SEMANTIC_REASONING_BUDGET, FIELD_TRUST).proof).toBeUndefined();
  // A truncated body does not expose the whole required support closure.
  expect(deliveredSourceSemanticLibraryProof(fieldIndex, { ...slot, target: { ...slot.target,
    span: { ...slot.target.span, content_complete: false } } }, qualifier, [proof], record,
    SOURCE_SEMANTIC_REASONING_BUDGET, FIELD_TRUST).proof).toBeUndefined();
  // A forged execution binding is not the reproduced proof.
  const forged = structuredClone(proof);
  Object.assign(forged.binding_results![0]!.bindings.tools!, { node_id: "rY" });
  expect(deliveredSourceSemanticLibraryProof(fieldIndex, slot, qualifier, [forged], record,
    SOURCE_SEMANTIC_REASONING_BUDGET, FIELD_TRUST).proof).toBeUndefined();
});

it("treats a missing-location whole-body claim as complete only at the authoritative body extent", () => {
  const { record, proof, index, entry, qualifier, target } = fieldProofFixture();
  const fieldIndex = index;
  const BODY = Buffer.byteLength("Alice uses X. Bob uses Y.", "utf8");
  const slot = (start: number, end: number) => ({ ...entry, interpretation_node: undefined, explanation_ids: [],
    target: { ...target, span: { content_start: start, content_end: end, retained_extent: "body" as const,
      content_complete: true, original_complete: true } } });
  const verify = (start: number, end: number, bodyBytes?: number) =>
    deliveredSourceSemanticLibraryProof(fieldIndex, slot(start, end), qualifier, [proof], record,
      SOURCE_SEMANTIC_REASONING_BUDGET,
      { compile_input: FIELD_COMPILE_INPUT, ...(bodyBytes === undefined ? {} : { source_body_bytes: bodyBytes }) });
  // A producer Boolean over a one-byte prefix cannot attest a complete source.
  expect(verify(0, 1, BODY).proof).toBeUndefined();
  // A declared length larger than the delivered interval is not the same body.
  expect(verify(0, BODY - 1, BODY).proof).toBeUndefined();
  // An unknown body extent stays unverified instead of trusting the Boolean.
  expect(verify(0, BODY).proof).toBeUndefined();
  // The real complete-source positive keeps verifying at the actual extent.
  expect(verify(0, BODY, BODY).proof).toBe(proof);
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
  const { record, proof, index, entry, qualifier, target } = deliveredProofFixture({ interpretation, semantics, correspondence,
    original: FINITE_QUERY, library: true, budget });
  expect(proof.outcome.status).toBe("interpreted");
  if (kind === "instantiation" || kind === "query_entity") expect(proof.derived_nodes?.some((row) => row.kind === kind)).toBe(true);
  else expect(proof.evaluation?.status).toBe("supported");
  expect(deliveredSourceSemanticLibraryProof(index, entry, qualifier, [proof], record, budget).proof).toBe(proof);
  const forged = structuredClone(proof), answer = forged.binding_results!.find((row) => row.binding_id === entry.output_binding)!;
  Object.assign(answer, { alternative: 999 });
  expect(deliveredSourceSemanticLibraryProof(index, entry, qualifier, [forged], record, budget).proof).toBeUndefined();
  // The ordinary field family retains the same positive witnesses and independently
  // supplied request/body binding; it must not become blanket-unverified.
  const compile_input = { ...FIELD_COMPILE_INPUT, text: FINITE_QUERY, budget };
  const fieldIndex = { ...index, result_version: ORDINARY_NATIVE_FIELD_RESULT_VERSION,
    query_id: compileConditionalFieldQuery(compile_input).query_id };
  const fieldSlot = { ...entry, interpretation_node: undefined, explanation_ids: [], target: { ...target,
    span: { retained_extent: "body" as const, content_start: 0, content_end: FIELD_BODY_BYTES,
      content_complete: true, original_complete: true } } };
  const trust = { compile_input, source_body_bytes: FIELD_BODY_BYTES };
  expect(deliveredSourceSemanticLibraryProof(fieldIndex, fieldSlot, qualifier, [proof], record, budget, trust).proof).toBe(proof);
  expect(deliveredSourceSemanticLibraryProof(fieldIndex, fieldSlot, qualifier, [forged], record, budget, trust).proof).toBeUndefined();
  // Coverage instruments comparison projection; the witness budget stays the fixture value.
}, 60_000);
