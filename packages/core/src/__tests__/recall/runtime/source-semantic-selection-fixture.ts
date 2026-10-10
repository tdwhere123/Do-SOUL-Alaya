import { evaluateBooleanHypergraph } from "@do-soul/alaya-graph-algorithms";
import { vi } from "vitest";
import { buildSourceReferenceCatalog, projectSourceSemanticQuerySupport, sourceGoldRootIdentity,
  sourceReferenceResolver, sourceSemanticInterpretationIdentity, sourceSemanticQueryIdentity,
  SourceSemanticResourceExhausted, SourceSemanticResourceLedger,
  type RequestBudget, type SourceSemanticCorrespondence, type SourceSemanticInterpretation, type SourceSemanticQuery
} from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import type { SourceSemanticLibraryPackage } from "../../../recall/runtime/source-semantic-library-selection.js";
import { sourceSemanticLibrarySourceEntry } from "../../../recall/runtime/source-semantic-library-recall.js";
import { SOURCE_SEMANTIC_REASONING_BUDGET } from "../../../recall/runtime/source-semantic-reasoning.js";
import { CLOCK, deliveredProofFixture, query, source, correspondenceFor } from "./source-semantic-proof-fixture.js";

const DEPLOYMENT = "Deployment Cedar";
export const selectionExecutionBudget: RequestBudget = { ...SOURCE_SEMANTIC_REASONING_BUDGET,
  work_units: 1_000_000, memory_bytes: 64_000_000 };
const deploymentPredicates = ["permission granted", "backup completed", "schema validated", "migration rehearsed",
  "rollback verified", "capacity reserved", "health checks passed", "audit logging enabled", "secrets rotated",
  "network rules approved", "dependency versions pinned", "operator handoff recorded", "maintenance window confirmed"] as const;
export const deploymentStatement = (input: number) => `${DEPLOYMENT} ${deploymentPredicates[input - 1]!}.`;
type BudgetRejection = Readonly<{ phase: string; requested_work: number; requested_bytes: number;
  remaining_work: number; remaining_bytes: number; spent_work: number; spent_bytes: number }>;
type AuthoredSource = Readonly<{ id: string; inputs: readonly number[]; body: string; package: SourceSemanticLibraryPackage;
  budget_rejections: readonly BudgetRejection[] }>;
export type SelectionTaskFixture = Readonly<{
  original: string; semantics: SourceSemanticQuery; alternatives: readonly (readonly number[])[];
  execution_budget: RequestBudget;
  sources: readonly AuthoredSource[]; pool: readonly SourceSemanticLibraryPackage[];
}>;

export function coverageSelectionFixture(executionBudget: RequestBudget = SOURCE_SEMANTIC_REASONING_BUDGET): SelectionTaskFixture {
  const original = `For ${DEPLOYMENT}, collect all thirteen required source statements: ${deploymentPredicates.join("; ")}.`;
  return selectionFixture(original, [deploymentPredicates.map((_, index) => index + 1)], [
    { id: "a-trap", inputs: [1, 2, 3, 4, 5, 6, 7] }, { id: "b-trap", inputs: [8, 9, 11, 12] },
    { id: "c-left", inputs: [1, 2, 3, 8, 9, 10] }, { id: "d-right", inputs: [4, 5, 6, 11, 12, 13] }
  ], executionBudget);
}

export function alternativeSelectionFixture(executionBudget: RequestBudget = SOURCE_SEMANTIC_REASONING_BUDGET): SelectionTaskFixture {
  const original = `For ${DEPLOYMENT}, establish either (permission granted AND backup completed) OR `
    + "(schema validated AND migration rehearsed AND rollback verified AND capacity reserved AND health checks passed).";
  return selectionFixture(original, [[1, 2], [3, 4, 5, 6, 7]], [
    { id: "permission", inputs: [1] }, { id: "backup", inputs: [2] },
    { id: "checks-left", inputs: [3, 4] }, { id: "checks-right", inputs: [5, 6] },
    { id: "backup-compatible", inputs: [2] }
  ], executionBudget);
}

function selectionFixture(original: string, alternatives: readonly (readonly number[])[],
  declarations: readonly Readonly<{ id: string; inputs: readonly number[] }>[], executionBudget: RequestBudget): SelectionTaskFixture {
  const inputs = [...new Set(alternatives.flat())];
  const semantics: SourceSemanticQuery = { ...query(original), return_variables: [],
    requested_operation: { reading: alternatives.length === 1 ? "collect all thirteen required source statements" : "establish either complete alternative",
      support: { kind: "query_text", excerpt: original } },
    variables: [{ id: "deployment", sort: "entity", reference: { kind: "query_text", excerpt: DEPLOYMENT } },
      ...inputs.map(input => ({ id: `input${input}`, sort: "proposition" as const }))],
    alternatives: alternatives.map(inputs => ({
      frames: inputs.map(input => ({ id: `qInput${input}`, variable: `input${input}`,
        predicate_reading: deploymentPredicates[input - 1]!, role_requirements: [{ id: "deployment", role_reading: "deployment",
          target_variable: "deployment", support: { kind: "query_text", excerpt: DEPLOYMENT } }] })),
      context_obligations: inputs.map(input => ({ frame: `qInput${input}`, kind: "asserted_at_source" })),
      answer_frames: [], evidence_inputs: inputs.map(input => ({ frames: [`qInput${input}`] }))
    })) };
  const sources = declarations.map(declaration => {
    const body = declaration.inputs.map(deploymentStatement).join("\n");
    const interpretation = deploymentInterpretation(declaration.id, declaration.inputs, body);
    const correspondence = deploymentCorrespondence(interpretation, semantics, alternatives, declaration.inputs);
    const { actual, budget_rejections } = measuredProof({ interpretation, semantics, correspondence, original,
      library: true, budget: executionBudget });
    const row: SourceSemanticLibraryPackage = { entry: actual.entry, entries: actual.index.entries,
      explanations: actual.index.explanations ?? [], proofs: [actual.proof], preview: body, access_position: 0,
      payload_support: "available", source_disclosure: { material_kind: "original_body", source_binding: "unbound",
        evaluated_as_of: CLOCK, validity: { kind: "unknown", reason: "unbound" }, temporal_state: "unknown",
        proof_use: { kind: "conditional_support", qualification: "not_world_claim" } } };
    return { ...declaration, body, package: row, budget_rejections };
  });
  return { original, semantics, alternatives, execution_budget: executionBudget, sources, pool: sources.map(row => row.package) };
}

function measuredProof(input: Parameters<typeof deliveredProofFixture>[0]) {
  const budget_rejections: BudgetRejection[] = [];
  const reserve = SourceSemanticResourceLedger.prototype.reserve;
  const observe = vi.spyOn(SourceSemanticResourceLedger.prototype, "reserve").mockImplementation(
    function (this: SourceSemanticResourceLedger, work, bytes, phase = "preparation") {
      try { return reserve.call(this, work, bytes, phase); }
      catch (error) {
        if (error instanceof SourceSemanticResourceExhausted) budget_rejections.push({ phase,
          requested_work: work, requested_bytes: bytes, remaining_work: this.work, remaining_bytes: this.bytes,
          spent_work: this.spentWork, spent_bytes: this.spentBytes });
        throw error;
      }
    });
  try { return { actual: deliveredProofFixture(input), budget_rejections }; }
  finally { observe.mockRestore(); }
}

function deploymentInterpretation(id: string, inputs: readonly number[], body: string): SourceSemanticInterpretation {
  const digest = fieldContractSha256(body);
  const assertions = inputs.map((input, index) => ({ assertion_id: index + 1, text: deploymentStatement(input) }));
  const catalog = buildSourceReferenceCatalog(digest, assertions, fieldContractSha256);
  const resolver = sourceReferenceResolver(catalog, fieldContractSha256);
  let offset = 0;
  const mentions: SourceSemanticInterpretation["mentions"][number][] = [];
  const assertion_locations: NonNullable<SourceSemanticInterpretation["source"]["assertion_locations"]>[number][] = [];
  const frames: SourceSemanticInterpretation["frames"] = inputs.map((input, index) => {
    const assertion_id = index + 1, sentence = assertions[index]!.text;
    assertion_locations.push({ assertion_id, source_utf8_span: [offset, offset + Buffer.byteLength(sentence)] });
    for (const [name, text, start] of [[`mDeployment${input}`, DEPLOYMENT, 0],
      [`mPredicate${input}`, deploymentPredicates[input - 1]!, DEPLOYMENT.length + 1]] as const) {
      mentions.push({ id: name, assertion_id, text, span_space: "source_utf8",
        source_ref: resolver.referenceForSpan(assertion_id, [start, start + text.length]),
        utf8_span: [offset + start, offset + start + text.length] });
    }
    offset += Buffer.byteLength(sentence) + 1;
    return { id: `fInput${input}`, assertion_ids: [assertion_id],
      context_owner: { kind: "source_act", source_act: "assertion" }, additional_support: [],
      predicate_support: { kind: "explicit", reading: deploymentPredicates[input - 1]!, mentions: [`mPredicate${input}`] },
      slots: [{ id: "deployment", role_reading: "deployment", support: [] }],
      bindings: [{ slot_id: "deployment", target: { kind: "node", id: "rDeployment" },
        support: [{ kind: "lexical", mentions: [`mDeployment${input}`] }] }] };
  });
  return { ...source(), source: { ...source().source, source_id: id, content_digest: `sha256:${digest}`, assertion_locations },
    mentions, referents: [{ id: "rDeployment", referent_kind: "grouped", mentions: inputs.map(input => `mDeployment${input}`) }],
    frames, operators: [], gaps: [], entry_roots: frames.map(row => row.id), asserted_at_scope: frames.map(row => row.id) };
}

function deploymentCorrespondence(interpretation: SourceSemanticInterpretation, semantics: SourceSemanticQuery,
  alternatives: readonly (readonly number[])[], inputs: readonly number[]): SourceSemanticCorrespondence {
  const correspondences: SourceSemanticCorrespondence["correspondences"][number][] = [{ relation: "contextual_equivalence",
    query_endpoint: { kind: "referent", variable: "deployment" }, source_endpoint: { kind: "referent", referent: "rDeployment" },
    query_support: { kind: "query_text", excerpt: DEPLOYMENT }, source_semantic_support: [{ kind: "lexical", mentions: [`mDeployment${inputs[0]}`] }] }];
  alternatives.forEach((required, alternative) => {
    for (const input of inputs.filter(input => required.includes(input))) {
      correspondences.push({ relation: "contextual_equivalence",
        query_endpoint: { kind: "predicate", alternative, frame: `qInput${input}` },
        source_endpoint: { kind: "frame", frame: `fInput${input}` },
        query_support: { kind: "query_text", excerpt: deploymentPredicates[input - 1]! },
        source_semantic_support: [{ kind: "lexical", mentions: [`mPredicate${input}`] }] },
      { relation: "contextual_equivalence", query_endpoint: { kind: "slot", alternative, frame: `qInput${input}`, slot: "deployment" },
        source_endpoint: { kind: "slot", frame: `fInput${input}`, slot: "deployment" },
        query_support: { kind: "query_text", excerpt: DEPLOYMENT }, source_semantic_support: [] });
    }
  });
  return { ...correspondenceFor(source(), query()), correspondences,
    source_interpretation_id: sourceSemanticInterpretationIdentity(interpretation, fieldContractSha256),
    query_semantics_id: sourceSemanticQueryIdentity(semantics, fieldContractSha256) };
}

export function physicalRoot(row: SourceSemanticLibraryPackage): string {
  if (row.entry.target.kind !== "source_evidence") throw new Error("source root expected");
  return sourceGoldRootIdentity(row.entry.target);
}

export function feasibleSubsets(pool: readonly SourceSemanticLibraryPackage[],
  fits: (rows: readonly SourceSemanticLibraryPackage[]) => boolean, capacity = 5): readonly (readonly SourceSemanticLibraryPackage[])[] {
  if (pool.length > 12 || capacity > 5) throw new Error("finite selection reference bound exceeded");
  const subsets: SourceSemanticLibraryPackage[][] = [];
  for (let mask = 0; mask < 1 << pool.length; mask++) {
    const rows = pool.filter((_, index) => mask & 1 << index);
    if (rows.length <= capacity && new Set(rows.map(physicalRoot)).size === rows.length && fits(rows)) subsets.push(rows);
  }
  return subsets;
}

export function executedInputNumbers(row: SourceSemanticLibraryPackage): readonly number[] {
  const proof = row.proofs[0];
  if (proof === undefined) return [];
  const support = projectSourceSemanticQuerySupport(proof.query, row.proofs.flatMap(proof => proof.binding_results ?? []));
  return support.evidence_inputs.filter(input => input.status === "supported").map(input => {
    const frame = proof.query.alternatives[input.alternative]!.evidence_inputs![input.input]!.frames[0]!;
    return Number(frame.slice("qInput".length));
  });
}

export function deliveredInputNumbers(fixture: SelectionTaskFixture, rows: readonly SourceSemanticLibraryPackage[]): readonly number[] {
  return [...new Set(rows.flatMap(row => {
    const authored = fixture.sources.find(source => physicalRoot(source.package) === physicalRoot(row));
    if (authored === undefined) throw new Error("source outside authored task");
    return authored.inputs.filter(input => row.preview.includes(deploymentStatement(input)));
  }))].sort((left, right) => left - right);
}

/** Environment declarations are evaluator premises; they never amend native H/Q/C. */
export function compatibleTaskSupport(fixture: SelectionTaskFixture, rows: readonly SourceSemanticLibraryPackage[],
  environments: ReadonlyMap<string, string | null> = new Map()): Readonly<{
    supported_inputs: readonly number[]; alternatives: readonly ("complete" | "incomplete" | "unknown")[];
    complete_alternatives: number; unresolved_qualifiers: readonly string[];
  }> {
  const environmentOf = (row: SourceSemanticLibraryPackage) => environments.has(physicalRoot(row)) ? environments.get(physicalRoot(row))! : "h";
  const known = [...new Set(rows.flatMap(row => environmentOf(row) === null ? [] : [environmentOf(row)!]))];
  const environmentsToCheck = known.length === 0 ? ["h"] : known;
  const declared = (environment: string, allowUnknown: boolean) => formulaSupport(fixture.alternatives,
    deliveredInputNumbers(fixture, rows.filter(row => environmentOf(row) === environment || allowUnknown && environmentOf(row) === null)));
  const definite = environmentsToCheck.map(environment => declared(environment, false));
  const possible = environmentsToCheck.map(environment => declared(environment, true));
  const alternatives = fixture.alternatives.map((_, index) => definite.some(row => row[index]) ? "complete" as const
    : possible.some(row => row[index]) ? "unknown" as const : "incomplete" as const);
  return { supported_inputs: deliveredInputNumbers(fixture, rows), alternatives,
    complete_alternatives: alternatives.filter(row => row === "complete").length,
    unresolved_qualifiers: alternatives.includes("unknown") ? ["environment"] : [] };
}

function formulaSupport(alternatives: readonly (readonly number[])[], inputs: readonly number[]): readonly boolean[] {
  const atomicNodes = [...new Set(alternatives.flat())].map(input => `input${input}`);
  const alternativeNodes = alternatives.map((_, index) => `alternative${index}`);
  const values = evaluateBooleanHypergraph({ nodeIds: [...atomicNodes, ...alternativeNodes, "task"],
    seeds: new Map(inputs.map(input => [`input${input}`, 1000])), bottom: 0, top: 1000,
    edges: [...alternatives.map((required, index) => ({ kind: "and" as const, from: required.map(input => `input${input}`),
      to: alternativeNodes[index]!, strength: 1000 })), { kind: "or", from: alternativeNodes, to: "task", strength: 1000 }] });
  return alternativeNodes.map(node => values.has(node));
}

export function rawSourceTwin(row: SourceSemanticLibraryPackage): SourceSemanticLibraryPackage {
  const target = row.entry.target;
  if (target.kind !== "source_evidence") throw new Error("source root expected");
  const entry = sourceSemanticLibrarySourceEntry({ workspaceId: target.workspace_id, root_id: target.root_id,
    source_version: target.source_version, content_digest: target.content_digest,
    evidence_object_id: target.evidence_object_id, hypothesis_id: "library" });
  return { ...row, entry, entries: [entry], proofs: [], explanations: [], payload_support: "envelope_budget",
    source_disclosure: { ...row.source_disclosure, proof_use: { kind: "source_only", qualification: "not_current_proof" } } };
}
