import { expect, it } from "vitest";
import { fieldReceiptContractFields, hashSourceRecordId, SourceRecordIdentitySchema,
  SOURCE_SPAN_IDENTITY_OPERATOR_ID, SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION, sourceRecallTarget, interpretationNodeIdentity,
  type SourceSemanticLibraryProof, type SourceSemanticInterpretation, type SourceSemanticQuery,
  type SourceSemanticCorrespondence, type RequestBudget } from "@do-soul/alaya-protocol";
import { executeSourceSemanticInterpretation, SOURCE_SEMANTIC_REASONING_BUDGET } from "../../../recall/runtime/source-semantic-reasoning.js";
import { admitSourceSemanticCorrespondence } from "../../../recall/conditional-field/query/source-semantic-correspondence-admission.js";
import { deliveredSourceSemanticLibraryProof } from "../../../recall/runtime/source-semantic-library-proof.js";
import { scopeSourceSemanticLibraryBranch, sourceSemanticLibraryQueryIdentity, slotQualifiersFor } from "../../../recall/runtime/source-semantic-library-recall.js";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import { source, query, align, CLOCK, ORIGINAL } from "./source-semantic-proof-fixture.js";
import { finiteSource, finiteQuery, finiteCorrespondence, FINITE_QUERY } from "./source-semantic-finite-fixture.js";
import { BindingContextStore, encodeBindingContext } from "../../../recall/conditional-field/engine/binding-environment.js";

function deliveredFixture(input: { interpretation?: SourceSemanticInterpretation; semantics?: SourceSemanticQuery;
  correspondence?: SourceSemanticCorrespondence; original?: string; library?: boolean; budget?: RequestBudget } = {}) {
  const interpretation = input.interpretation ?? source(), semantics = input.semantics ?? query();
  const correspondence = input.correspondence ?? align(interpretation, semantics), original = input.original ?? ORIGINAL;
  const identity = hashSourceRecordId(interpretation.source, fieldContractSha256);
  const record = SourceRecordIdentitySchema.parse({ ...fieldReceiptContractFields({ identity,
    producer: SOURCE_SPAN_IDENTITY_OPERATOR_ID, consumer: "projection_generation" }), schema_version: 1,
    workspace_id: "ws", ...interpretation.source, evidence_object_id: null, recorded_at: CLOCK,
    event_time: null, valid_from: null, valid_to: null, scope_class: "project", operator_id: SOURCE_SPAN_IDENTITY_OPERATOR_ID });
  const target = sourceRecallTarget({ workspace_id: record.workspace_id, root_kind: "source_record", root_id: record.identity,
    source_version: record.source_version, content_digest: record.content_digest, evidence_object_id: record.evidence_object_id });
  const admitted = admitSourceSemanticCorrespondence({ source_interpretation: interpretation, query_semantics: semantics,
    semantic_correspondence: correspondence, original_query: original });
  if (admitted.kind !== "admitted") throw new Error("fixture correspondence must be admitted");
  const executed = executeSourceSemanticInterpretation({ source_interpretation: interpretation, query_semantics: semantics,
    semantic_correspondence: correspondence, original_query: original, workspaceId: "ws", scope: "project",
    authorizedScopes: ["project"], asOf: CLOCK, source_target: target, sourceValidity: record,
    request: { contract: "source-interpretation-reasoning-v4", accepts_unreviewed_conditional_results: true,
      source_interpretation_id: admitted.interpretation_id, query_semantics_id: admitted.query_id,
      semantic_correspondence_id: admitted.semantic_correspondence_id, original_query: original,
      budget: input.budget ?? SOURCE_SEMANTIC_REASONING_BUDGET, output_byte_limit: 1_000_000 } });
  if (executed.index === null) throw new Error("fixture must produce native proof");
  const delivered = input.library ? scopeSourceSemanticLibraryBranch(executed.index, executed.result) : { ...executed, index: executed.index };
  const proof: SourceSemanticLibraryProof = { ...delivered.result, original_query: original, interpretation,
    query: semantics, semantic_correspondence: correspondence, context: admitted.context, source_record: record };
  const index = { ...delivered.index, query_id: sourceSemanticLibraryQueryIdentity(original),
    ...(input.library ? { result_version: SOURCE_SEMANTIC_LIBRARY_RESULT_VERSION } : {}) };
  const qualifiers = slotQualifiersFor(index, [proof]);
  const offset = qualifiers.findIndex((row) => row.evidence_kind === "semantic_proof");
  if (offset < 0) throw new Error("fixture must deliver a proof slot");
  return { record, target, proof, index, entry: index.entries[offset]!, qualifier: qualifiers[offset]! };
}

it("requires independently supplied publication provenance for a native conditional proof", () => {
  const { record, proof, index, entry, qualifier } = deliveredFixture();
  expect(deliveredSourceSemanticLibraryProof(index, entry, qualifier, [proof], record)).toBe(proof);
  expect(deliveredSourceSemanticLibraryProof(index, entry, qualifier, [proof])).toBeUndefined();
});

it.each(["root", "workspace", "version", "digest", "record"] as const)("rejects a proof rebound to another %s", (kind) => {
  const { record, proof, index, entry, qualifier, target } = deliveredFixture();
  const changedRecord = { ...record, source_id: "forged-source", workspace_id: "other-workspace" };
  changedRecord.identity = hashSourceRecordId(changedRecord, fieldContractSha256);
  const changed = { ...target,
    ...(kind === "root" ? { root_id: "forged-root" } : kind === "workspace" ? { workspace_id: "other-workspace" }
      : kind === "version" ? { source_version: "another-version" } : kind === "digest" ? { content_digest: `sha256:${"00".repeat(32)}` }
        : { root_id: changedRecord.identity, workspace_id: changedRecord.workspace_id }) };
  const forged = { ...proof, source_target: changed, ...(kind === "record" ? { source_record: changedRecord } : {}) };
  expect(deliveredSourceSemanticLibraryProof(index, { ...entry, target: changed }, qualifier, [forged], record)).toBeUndefined();
});

it.each([null, undefined])("does not promote unknown source scope to project (%s)", (scope_class) => {
  const { record, proof, index, entry, qualifier } = deliveredFixture();
  const unbound = { ...record, scope_class };
  expect(deliveredSourceSemanticLibraryProof(index, entry, qualifier, [{ ...proof, source_record: unbound }], unbound)).toBeUndefined();
});

it.each([false, true])("binds delivered coordinates and alternatives to the execution witness (library namespace=%s)", (library) => {
  const { record, proof, index, entry, qualifier } = deliveredFixture({ library });
  expect(deliveredSourceSemanticLibraryProof(index, entry, qualifier, [proof], record)).toBe(proof);
  for (const mutation of ["coordinate", "alternative", "rehashed_binding", "acceptance_marker"] as const) {
    const forged = structuredClone(proof), answer = forged.answers!.find((row) => row.binding_id === entry.output_binding)!;
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
    expect(deliveredSourceSemanticLibraryProof(index, changedEntry, qualifier, [forged], record), mutation).toBeUndefined();
  }
});

it("keeps proof verification exhaustion unavailable", () => {
  const { record, proof, index, entry, qualifier } = deliveredFixture();
  expect(deliveredSourceSemanticLibraryProof(index, entry, qualifier, [proof], record,
    { ...SOURCE_SEMANTIC_REASONING_BUDGET, work_units: 100, finalization_reserve: 10 })).toBeUndefined();
});

it("rejects substitution of another admitted alternative while preserving its original binding", () => {
  const interpretation = source(), initial = query();
  const semantics = { ...initial, alternatives: [...initial.alternatives, initial.alternatives[0]!] };
  const original = align(interpretation, semantics);
  const correspondence = { ...original, correspondences: [...original.correspondences,
    ...original.correspondences.flatMap((row) => row.query_endpoint.kind === "referent" ? []
      : [{ ...row, query_endpoint: { ...row.query_endpoint, alternative: 1 } }])] };
  const { record, proof, index, entry, qualifier } = deliveredFixture({ interpretation, semantics, correspondence, library: true });
  expect(new Set(proof.answers?.map((answer) => answer.alternative))).toEqual(new Set([0, 1]));
  expect(deliveredSourceSemanticLibraryProof(index, entry, qualifier, [proof], record)).toBe(proof);
  const forged = structuredClone(proof), answer = forged.answers!.find((row) => row.binding_id === entry.output_binding)!;
  Object.assign(answer, { alternative: answer.alternative === 0 ? 1 : 0 });
  expect(deliveredSourceSemanticLibraryProof(index, entry, qualifier, [forged], record)).toBeUndefined();
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
  const { record, proof, index, entry, qualifier } = deliveredFixture({ interpretation, semantics, correspondence,
    original: FINITE_QUERY, library: true, budget });
  expect(proof.outcome.status).toBe("interpreted");
  if (kind === "instantiation" || kind === "query_entity") expect(proof.derived_nodes?.some((row) => row.kind === kind)).toBe(true);
  else expect(proof.evaluation?.status).toBe("supported");
  expect(deliveredSourceSemanticLibraryProof(index, entry, qualifier, [proof], record, budget)).toBe(proof);
  const forged = structuredClone(proof), answer = forged.answers!.find((row) => row.binding_id === entry.output_binding)!;
  Object.assign(answer, { alternative: 999 });
  expect(deliveredSourceSemanticLibraryProof(index, entry, qualifier, [forged], record, budget)).toBeUndefined();
}, 15_000);
