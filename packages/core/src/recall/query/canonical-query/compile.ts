import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../field/field-identity.js";
import { isSnapshotDigest } from
  "../../runtime/snapshot-coherence/digest.js";
import { compileRecallAnswerShapePlan, type RecallAnswerShapePlan } from
  "../recall-answer-shape-plan.js";
import { compileRecallQueryDemand, type RecallQueryDemand } from
  "../recall-query-demand.js";
import type { RecallQueryProbes } from "../recall-query-probes.js";
import {
  type CanonicalEvidenceProvenanceV1,
  type CanonicalPredicateV1,
  type CanonicalQueryV1
} from "./types.js";
import { digestCanonicalQueryV1, validateCanonicalQueryV1 } from "./validate.js";

export type CanonicalQueryCaptureEvidenceV1 = Readonly<{
  readonly status?: string;
  readonly capture_digest?: string;
}>;

export type CanonicalQueryEvidenceV1 = Readonly<{
  readonly probes: Readonly<RecallQueryProbes>;
  readonly demand?: Readonly<RecallQueryDemand>;
  readonly shape?: Readonly<RecallAnswerShapePlan>;
  readonly factFrameCapture?: CanonicalQueryCaptureEvidenceV1 | null;
  readonly osfCapture?: CanonicalQueryCaptureEvidenceV1 | null;
  readonly observer?: Readonly<{
    readonly principal: string;
    readonly scope: string;
    readonly observer_contract: string;
  }>;
}>;

export type CanonicalQueryUnresolvedV1 = Readonly<{
  readonly code: string;
  readonly source: string;
  readonly capture_digest?: RecallFieldDigest;
  readonly detail?: string;
}>;

export type CanonicalQueryCompileV1 = Readonly<{
  readonly hypotheses: readonly CanonicalQueryV1[];
  readonly unresolved: readonly CanonicalQueryUnresolvedV1[];
  readonly provenance: readonly string[];
  readonly hypothesis_provenance: readonly CanonicalEvidenceProvenanceV1[];
}>;

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

export function compileCanonicalQueryEvidence(
  evidence: CanonicalQueryEvidenceV1
): CanonicalQueryCompileV1 {
  const demand = evidence.demand ?? compileRecallQueryDemand(evidence.probes);
  const shape = evidence.shape ?? compileRecallAnswerShapePlan(evidence.probes);
  const ordering = demand.atoms.filter((atom) => atom.kind === "ordering");
  const unresolved: CanonicalQueryUnresolvedV1[] = [...unadaptedEvidence(evidence)];
  const provenance = ["probes", "demand", "shape"];
  const hypotheses: CanonicalQueryV1[] = [];
  const hypothesis_provenance: CanonicalEvidenceProvenanceV1[] = [];
  pushShapePrograms(shape, evidence, hypotheses, hypothesis_provenance, unresolved, provenance);
  pushOrderingHoles(ordering, unresolved);
  unresolved.push(...unadaptedDemandAtoms(demand, hypotheses));
  unresolved.push(...unboundTargetTerms(shape, hypotheses));
  if (hypotheses.length === 0 && (shape.status === "unknown" || shape.target_terms.length === 0)
    && shape.shape !== "count" && shape.shape !== "sum" && shape.shape !== "duration") {
    unresolved.push({ code: "unknown_answer_variable", source: "shape" });
  }
  const unique = dedupeQueries(hypotheses, hypothesis_provenance);
  return Object.freeze({
    hypotheses: Object.freeze(unique.hypotheses),
    unresolved: Object.freeze(unresolved),
    provenance: Object.freeze(provenance),
    hypothesis_provenance: Object.freeze(unique.provenance)
  });
}

function unadaptedEvidence(
  evidence: CanonicalQueryEvidenceV1
): CanonicalQueryUnresolvedV1[] {
  return [
    ...unadaptedCapture(evidence.factFrameCapture, "unadapted_fact_frame", "fact_frame"),
    ...unadaptedCapture(evidence.osfCapture, "unadapted_osf", "osf")
  ];
}

function unadaptedCapture(
  capture: CanonicalQueryCaptureEvidenceV1 | null | undefined,
  code: string,
  source: string
): CanonicalQueryUnresolvedV1[] {
  if (capture === undefined || capture === null) return [];
  return [Object.freeze({
    code,
    source,
    capture_digest: captureIdentity(capture),
    detail: capture.status
  })];
}

function captureIdentity(capture: CanonicalQueryCaptureEvidenceV1): RecallFieldDigest {
  const digest = capture.capture_digest;
  if (typeof digest === "string" && isSnapshotDigest(digest)) return digest;
  return digestRecallFieldIdentity(capture);
}

function pushShapePrograms(
  shape: Readonly<RecallAnswerShapePlan>,
  evidence: CanonicalQueryEvidenceV1,
  hypotheses: CanonicalQueryV1[],
  hypothesisProvenance: CanonicalEvidenceProvenanceV1[],
  unresolved: CanonicalQueryUnresolvedV1[],
  provenance: string[]
): void {
  if (rejectUnsupportedShape(shape, evidence, unresolved)) return;
  const answer = shape.shape === "distinct_entities"
    ? distinctAnswer(evidence)
    : { kind: "scalar" as const, variable: "x0" };
  if (answer === null) {
    unresolved.push({ code: "unknown_scope", source: "observer" });
    return;
  }
  const query = supportedQuery({
    variables: [{ name: "x0", sort: "entity" }],
    predicates: relationPredicates(shape),
    answer
  }, unresolved);
  if (query !== null) {
    hypotheses.push(query);
    hypothesisProvenance.push(Object.freeze({
      source_id: "shape.relation_terms",
      producer: "recall_answer_shape_plan"
    }));
    provenance.push("shape.relation_terms");
  }
}

function rejectUnsupportedShape(
  shape: Readonly<RecallAnswerShapePlan>,
  evidence: CanonicalQueryEvidenceV1,
  unresolved: CanonicalQueryUnresolvedV1[]
): boolean {
  if (shape.shape === "count" || shape.shape === "sum") {
    unresolved.push({ code: "count_sum_unsupported", source: "shape" });
    return true;
  }
  if (shape.shape === "duration") {
    unresolved.push({ code: "unsupported_nesting", source: "shape" });
    if (CJK.test(evidence.probes.normalized_query ?? "")) {
      unresolved.push({ code: "ambiguous_cjk_segmentation", source: "probes" });
    }
    return true;
  }
  if (shape.status === "ambiguous") {
    unresolved.push({ code: "conflicting_shape", source: "shape" });
    return true;
  }
  if (shape.status !== "high_confidence" || shape.target_terms.length === 0) return true;
  if (shape.relation_terms.length === 0) {
    unresolved.push({ code: "unknown_relation", source: "shape" });
    return true;
  }
  if (shape.relation_terms.length > 8) {
    unresolved.push({
      code: "limit_overflow",
      source: "shape",
      detail: "relation_terms"
    });
    return true;
  }
  return false;
}

function pushOrderingHoles(
  ordering: readonly { readonly value: string }[],
  unresolved: CanonicalQueryUnresolvedV1[]
): void {
  for (const atom of ordering) {
    if (atom.value === "latest" || atom.value === "earliest") {
      unresolved.push({ code: "latest_without_typed_time_key", source: "demand" });
      unresolved.push({ code: "unknown_time_basis", source: "demand" });
    }
    if (atom.value === "sequence") {
      unresolved.push({ code: "unsupported_nesting", source: "demand" });
    }
  }
}

function distinctAnswer(evidence: CanonicalQueryEvidenceV1) {
  const observer = evidence.observer;
  if (observer === undefined) return null;
  return {
    kind: "distinct" as const,
    variable: "x0",
    completion: {
      kind: "all_observable" as const,
      scope: observer.scope,
      principal: observer.principal,
      snapshot_bind: "Sigma_q" as const,
      observer_contract: observer.observer_contract
    }
  };
}

function unadaptedDemandAtoms(
  demand: Readonly<RecallQueryDemand>,
  hypotheses: readonly CanonicalQueryV1[]
): CanonicalQueryUnresolvedV1[] {
  const used = usedHypothesisTokens(hypotheses);
  const items: CanonicalQueryUnresolvedV1[] = [];
  for (const atom of demand.atoms) {
    if (atom.kind === "ordering") continue;
    if (atom.kind === "lexical_term" && used.has(atom.value)) continue;
    items.push({
      code: `unadapted_demand_${atom.kind}`,
      source: "demand",
      detail: atom.id
    });
  }
  return items;
}

function unboundTargetTerms(
  shape: Readonly<RecallAnswerShapePlan>,
  hypotheses: readonly CanonicalQueryV1[]
): CanonicalQueryUnresolvedV1[] {
  const used = usedHypothesisTokens(hypotheses);
  return shape.target_terms.flatMap((term) => used.has(term)
    ? []
    : [{ code: "unbound_target_term", source: "shape", detail: term }]);
}

function usedHypothesisTokens(hypotheses: readonly CanonicalQueryV1[]): Set<string> {
  const used = new Set<string>();
  for (const query of hypotheses) {
    for (const predicate of query.predicates) {
      used.add(predicate.relation);
      for (const argument of predicate.arguments) used.add(argument);
    }
  }
  return used;
}

function relationPredicates(shape: Readonly<RecallAnswerShapePlan>): CanonicalPredicateV1[] {
  return shape.relation_terms.map((relation, index) => Object.freeze({
    id: `p${index}`,
    relation,
    arguments: Object.freeze(["x0"]),
    provenance: Object.freeze({
      source_id: "shape.relation_terms",
      producer: "recall_answer_shape_plan"
    })
  }));
}

function supportedQuery(
  input: Parameters<typeof validateCanonicalQueryV1>[0],
  unresolved: CanonicalQueryUnresolvedV1[]
): CanonicalQueryV1 | null {
  if (input.answer === undefined && input.answers === undefined) {
    unresolved.push({ code: "unknown_scope", source: "observer" });
    return null;
  }
  const result = validateCanonicalQueryV1(input);
  if (result.status === "supported") return result.query;
  unresolved.push({ code: result.reason_code, source: "validator" });
  return null;
}

function dedupeQueries(
  queries: readonly CanonicalQueryV1[],
  provenance: readonly CanonicalEvidenceProvenanceV1[]
): {
  hypotheses: CanonicalQueryV1[];
  provenance: CanonicalEvidenceProvenanceV1[];
} {
  const seen = new Set<string>();
  const unique: CanonicalQueryV1[] = [];
  const uniqueProvenance: CanonicalEvidenceProvenanceV1[] = [];
  queries.forEach((query, index) => {
    const key = digestCanonicalQueryV1(query);
    if (seen.has(key)) return;
    seen.add(key);
    unique.push(query);
    const row = provenance[index];
    if (row !== undefined) uniqueProvenance.push(row);
  });
  return { hypotheses: unique, provenance: uniqueProvenance };
}
