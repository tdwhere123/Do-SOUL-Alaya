import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../../../../recall/field/field-identity.js";
import {
  bindAllObservableCompletion,
  CANONICAL_QUERY_OPERATOR_ID,
  digestCanonicalQueryV1,
  impactsFor,
  validateCanonicalQueryV1,
  type CanonicalQueryCompilationV1,
  type CanonicalQueryHoleV1,
  type CanonicalQueryInputV1,
  type CanonicalQueryV1,
  type CanonicalVariableV1
} from "../../../../../recall/query/canonical-query/index.js";
import {
  EXTREMUM_CLOSURE_WITNESS_OPERATOR_ID,
  type ExtremumClosureWitness
} from "../../../../../recall/decision/query-proof/closure/extremum.js";
import {
  compileQueryGamma,
  extremumClosureDigest,
  extremumPrincipalDigest,
  extremumUniverseDigest,
  type QueryGammaCompileInputV1
} from "../../../../../recall/decision/query-proof/gamma/compile.js";
import type {
  QueryCompiledGammaV1,
  QueryGammaAtomJurisdictionV1,
  QueryGammaAtomV1,
  QueryGammaCandidateEvidenceV1,
  QueryGammaPropositionEvidenceV1
} from "../../../../../recall/decision/query-proof/gamma/contract.js";

export const ENTITY: CanonicalVariableV1 = { name: "x", sort: "entity" };
export const TIME: CanonicalVariableV1 = { name: "t", sort: "time" };
export const SNAPSHOT = `sha256:${"c".repeat(64)}` as RecallFieldDigest;
export const QUERY_IDENTITY = Object.freeze({
  condition_identity: "cond-1",
  query_operator_id: "recall_query_v1",
  generation_id: "gen-1",
  query_cache_key: "cache-1"
});

export function supportedQuery(input: CanonicalQueryInputV1): CanonicalQueryV1 {
  const result = validateCanonicalQueryV1(input);
  if (result.status !== "supported") {
    throw new Error(result.reason_code);
  }
  return result.query;
}

export function compilationFor(
  query: CanonicalQueryV1,
  holes: readonly CanonicalQueryHoleV1[] = []
): CanonicalQueryCompilationV1 {
  const compile_status = queryStatus(query, holes);
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: CANONICAL_QUERY_OPERATOR_ID,
    hypotheses: Object.freeze([query]),
    unresolved: Object.freeze([]),
    provenance: Object.freeze([]),
    hypothesis_provenance: Object.freeze([]),
    holes: Object.freeze([...holes]),
    compile_status,
    hypothetical_mode: hypotheticalMode(compile_status, holes),
    sensitivities: Object.freeze([]),
    snapshot_receipt_digest: SNAPSHOT,
    query_identity: QUERY_IDENTITY
  });
  return Object.freeze({
    ...body,
    digest: digestRecallFieldIdentity(body)
  });
}

export function hole(code: string): CanonicalQueryHoleV1 {
  return Object.freeze({
    provenance: "test",
    code,
    impacts: Object.freeze(impactsFor(code))
  });
}

export const PLANTED_OSF_SOURCE = Object.freeze({
  owner: "osf",
  available: true
});

export function compileInputFor(
  query: CanonicalQueryV1,
  candidates: readonly QueryGammaCandidateEvidenceV1[],
  extra: Partial<QueryGammaCompileInputV1> = {}
): QueryGammaCompileInputV1 {
  const class_source = extra.class_source ?? (query.answer.kind === "scalar"
    ? PLANTED_OSF_SOURCE
    : extra.class_source);
  return Object.freeze({
    compilation: extra.compilation ?? compilationFor(query),
    candidates,
    hypothesis_digest: extra.hypothesis_digest ?? digestCanonicalQueryV1(query),
    ...(extra.extremum_witness !== undefined ? { extremum_witness: extra.extremum_witness } : {}),
    ...(extra.resource_policy !== undefined ? { resource_policy: extra.resource_policy } : {}),
    ...(class_source !== undefined ? { class_source } : {})
  });
}

export function compileGamma(
  query: CanonicalQueryV1,
  candidates: readonly QueryGammaCandidateEvidenceV1[],
  extra: Partial<QueryGammaCompileInputV1> = {}
) {
  return compileQueryGamma(compileInputFor(query, candidates, extra));
}

export function candidate(
  key: string,
  patch: Partial<QueryGammaCandidateEvidenceV1> = {}
): QueryGammaCandidateEvidenceV1 {
  return Object.freeze({
    candidate_key: key,
    object_key: patch.object_key ?? key,
    token_cost: patch.token_cost ?? 1,
    dimension: patch.dimension ?? "mem",
    bindings_status: patch.bindings_status ?? "observed",
    bindings: Object.freeze([...(patch.bindings ?? [])]),
    propositions_status: patch.propositions_status ?? "observed",
    propositions: Object.freeze([...(patch.propositions ?? [])]),
    sequence_slots: Object.freeze([...(patch.sequence_slots ?? [])]),
    extremal_bindings: Object.freeze([...(patch.extremal_bindings ?? [])])
  });
}

export function binding(
  identity: string,
  distinctness: QueryGammaCandidateEvidenceV1["bindings"][number]["distinctness"] =
    "proved_distinct",
  variable = "x"
): QueryGammaCandidateEvidenceV1["bindings"][number] {
  return Object.freeze({ variable, semantic_identity: identity, distinctness });
}

export function proposition(
  id: string,
  support: QueryGammaPropositionEvidenceV1["support"] = "supports",
  independence: QueryGammaPropositionEvidenceV1["independence"] = "not_applicable",
  jurisdiction: QueryGammaAtomJurisdictionV1 = "predicate"
): QueryGammaPropositionEvidenceV1 {
  return Object.freeze({ proposition_id: id, jurisdiction, support, independence });
}

export function findGammaAtom(
  compiled: QueryCompiledGammaV1,
  match: Readonly<{
    readonly kind: QueryGammaAtomV1["kind"];
    readonly target?: string;
    readonly variable?: string;
    readonly semantic_identity?: string;
    readonly jurisdiction?: QueryGammaAtomJurisdictionV1;
  }>
): QueryGammaAtomV1 {
  const found = compiled.atoms.find((atom) =>
    atom.kind === match.kind &&
    (match.target === undefined || atom.target === match.target) &&
    (match.variable === undefined || atom.variable === match.variable) &&
    (match.semantic_identity === undefined || atom.semantic_identity === match.semantic_identity) &&
    (match.jurisdiction === undefined || atom.jurisdiction === match.jurisdiction));
  if (found === undefined) {
    throw new Error(`missing gamma atom ${match.kind}`);
  }
  return found;
}

export function scalarQuery(
  predicates: CanonicalQueryInputV1["predicates"] = [],
  constraints: CanonicalQueryInputV1["constraints"] = []
): CanonicalQueryV1 {
  return supportedQuery({
    variables: [ENTITY],
    predicates,
    constraints,
    answer: { kind: "scalar", variable: "x" }
  });
}

export function distinctQuery(
  completion: { kind: "at_most"; n: number } | ReturnType<typeof bindAllObservableCompletion> = {
    kind: "at_most",
    n: 5
  }
): CanonicalQueryV1 {
  return supportedQuery({
    variables: [ENTITY],
    answer: { kind: "distinct", variable: "x", completion }
  });
}

export function allObservableDistinct(): CanonicalQueryV1 {
  return distinctQuery(bindAllObservableCompletion({
    scope: "workspace-1",
    principal: "principal-1",
    observer_universe: ["obs-1"],
    snapshot: {
      principal: "principal-1",
      authorized_scopes: ["workspace-1", "scope-1"],
      receipt_digest: SNAPSHOT
    }
  }));
}

export function sequenceQuery(n = 3): CanonicalQueryV1 {
  return supportedQuery({
    variables: [ENTITY, TIME],
    answer: {
      kind: "sequence",
      order_key: "t",
      variable: "x",
      completion: { kind: "at_most", n }
    }
  });
}

export function argmaxQuery(): CanonicalQueryV1 {
  return supportedQuery({
    variables: [ENTITY, TIME],
    answer: { kind: "argmax", order_key: "t", inner: { kind: "scalar", variable: "x" } }
  });
}

export function argminQuery(): CanonicalQueryV1 {
  return supportedQuery({
    variables: [ENTITY, TIME],
    answer: { kind: "argmin", order_key: "t", inner: { kind: "scalar", variable: "x" } }
  });
}

export function extremumWitness(
  compilation: CanonicalQueryCompilationV1,
  operator: "argmax" | "argmin",
  bindings: readonly string[],
  query: CanonicalQueryV1 = operator === "argmax" ? argmaxQuery() : argminQuery(),
  candidateKeys: readonly string[] = ["A"]
): ExtremumClosureWitness {
  const interval_digest = digestRecallFieldIdentity({ interval: "test" });
  const query_digest = digestCanonicalQueryV1(query);
  const snapshot_digest = compilation.snapshot_receipt_digest;
  const extremal_binding_ids = Object.freeze([...bindings]);
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: EXTREMUM_CLOSURE_WITNESS_OPERATOR_ID,
    operator,
    query_digest,
    snapshot_digest,
    principal_digest: extremumPrincipalDigest(compilation),
    universe_digest: extremumUniverseDigest(compilation, candidateKeys.map((key) =>
      candidate(key))),
    sensitivity_id: "extremum:t",
    extremal_binding_ids,
    interval_digest,
    closure_result_digest: extremumClosureDigest({
      operator,
      query_digest,
      snapshot_digest,
      interval_digest,
      extremal_binding_ids
    })
  });
  return Object.freeze({
    ...body,
    witness_digest: digestRecallFieldIdentity(body)
  });
}

function queryStatus(
  query: CanonicalQueryV1,
  holes: readonly CanonicalQueryHoleV1[]
): CanonicalQueryCompilationV1["compile_status"] {
  if (holes.length === 0) return "certified_program";
  return query === undefined ? "unsupported" : "partial_program";
}

function hypotheticalMode(
  status: CanonicalQueryCompilationV1["compile_status"],
  holes: readonly CanonicalQueryHoleV1[]
): CanonicalQueryCompilationV1["hypothetical_mode"] {
  if (holes.some((row) => row.impacts.includes("blocks_all_delivery"))) {
    return status === "unsupported" ? "unsupported" : "abstained";
  }
  if (status === "certified_program") return "certified";
  if (status === "partial_program") return "best_effort";
  return "unsupported";
}
