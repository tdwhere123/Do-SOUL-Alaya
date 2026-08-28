import { compileRecallAnswerShapePlan, type RecallAnswerShapePlan } from
  "../recall-answer-shape-plan.js";
import { compileRecallQueryDemand, type RecallQueryDemand } from
  "../recall-query-demand.js";
import type { RecallQueryProbes } from "../recall-query-probes.js";
import {
  type CanonicalQueryValidationV1,
  type CanonicalVariableV1
} from "./types.js";
import { validateCanonicalQueryV1 } from "./validate.js";

export type CanonicalQueryEvidenceV1 = Readonly<{
  readonly probes: Readonly<RecallQueryProbes>;
  readonly demand?: Readonly<RecallQueryDemand>;
  readonly shape?: Readonly<RecallAnswerShapePlan>;
}>;

export type CanonicalQueryUnresolvedV1 = Readonly<{
  readonly code: string;
  readonly source: string;
}>;

export type CanonicalQueryCompileV1 = Readonly<{
  readonly hypotheses: readonly CanonicalQueryValidationV1[];
  readonly unresolved: readonly CanonicalQueryUnresolvedV1[];
}>;

export function compileCanonicalQueryEvidence(
  evidence: CanonicalQueryEvidenceV1
): CanonicalQueryCompileV1 {
  const demand = evidence.demand ?? compileRecallQueryDemand(evidence.probes);
  const shape = evidence.shape ?? compileRecallAnswerShapePlan(evidence.probes);
  const ordering = demand.atoms.filter((atom) => atom.kind === "ordering");
  const unresolved: CanonicalQueryUnresolvedV1[] = [];
  const hypotheses: CanonicalQueryValidationV1[] = [];
  pushShapePrograms(shape, ordering, evidence.probes, hypotheses, unresolved);
  pushOrderingPrograms(ordering, evidence.probes, hypotheses, unresolved);
  if (hypotheses.length === 0 && unresolved.length === 0) {
    unresolved.push({ code: "unknown_answer_variable", source: "shape" });
  }
  return Object.freeze({
    hypotheses: Object.freeze(dedupeHypotheses(hypotheses)),
    unresolved: Object.freeze(unresolved)
  });
}

function pushShapePrograms(
  shape: Readonly<RecallAnswerShapePlan>,
  ordering: readonly { readonly value: string }[],
  probes: Readonly<RecallQueryProbes>,
  hypotheses: CanonicalQueryValidationV1[],
  unresolved: CanonicalQueryUnresolvedV1[]
): void {
  if (shape.shape === "count" || shape.shape === "sum") {
    hypotheses.push(validateCanonicalQueryV1({ variables: [], unsupported: "count" }));
    return;
  }
  if (shape.status === "ambiguous") {
    unresolved.push({ code: "conflicting_shape", source: "shape" });
    return;
  }
  if (shape.status !== "high_confidence" || shape.target_terms.length === 0) return;
  if (ordering.length > 0 && (shape.shape === "place" || shape.shape === "duration")) {
    unresolved.push({ code: "conflicting_demand_shape", source: "demand+shape" });
  }
  hypotheses.push(validateCanonicalQueryV1({
    variables: entityVariables(shape.target_terms, probes),
    predicates: relationPredicates(shape),
    answer: shape.shape === "distinct_entities"
      ? {
          kind: "distinct",
          variable: "x0",
          completion: { kind: "at_most", n: 8 }
        }
      : { kind: "scalar", variable: "x0" }
  }));
}

function pushOrderingPrograms(
  ordering: readonly { readonly value: string }[],
  probes: Readonly<RecallQueryProbes>,
  hypotheses: CanonicalQueryValidationV1[],
  unresolved: CanonicalQueryUnresolvedV1[]
): void {
  for (const atom of ordering) {
    if (atom.value !== "latest" && atom.value !== "earliest" && atom.value !== "sequence") {
      continue;
    }
    if (probes.date_terms.length === 0 && atom.value !== "sequence") {
      hypotheses.push(validateCanonicalQueryV1({
        variables: [],
        unsupported: "latest"
      }));
      unresolved.push({ code: "unknown_time_basis", source: "demand" });
      continue;
    }
    const variables: CanonicalVariableV1[] = [
      { name: "x0", sort: "entity" },
      { name: "t0", sort: "time" }
    ];
    hypotheses.push(validateCanonicalQueryV1({
      variables,
      answer: atom.value === "sequence"
        ? {
            kind: "sequence",
            order_key: "t0",
            variable: "x0",
            completion: { kind: "at_most", n: 8 }
          }
        : {
            kind: atom.value === "earliest" ? "argmin" : "argmax",
            order_key: "t0",
            inner: { kind: "scalar", variable: "x0" }
          }
    }));
  }
}

function entityVariables(
  targetTerms: readonly string[],
  probes: Readonly<RecallQueryProbes>
): CanonicalVariableV1[] {
  const names = targetTerms.length > 0 ? targetTerms : probes.object_ids;
  const limited = names.slice(0, 8);
  if (limited.length === 0) return [{ name: "x0", sort: "entity" }];
  return limited.map((term, index) => ({
    name: index === 0 ? "x0" : `x${index}`,
    sort: "entity" as const,
    label: term
  })).map(({ name, sort }) => ({ name, sort }));
}

function relationPredicates(shape: Readonly<RecallAnswerShapePlan>) {
  return shape.relation_terms.slice(0, 8).map((relation, index) => Object.freeze({
    id: `p${index}`,
    relation,
    arguments: Object.freeze(["x0"])
  }));
}

function dedupeHypotheses(
  hypotheses: readonly CanonicalQueryValidationV1[]
): CanonicalQueryValidationV1[] {
  const seen = new Set<string>();
  const unique: CanonicalQueryValidationV1[] = [];
  for (const hypothesis of hypotheses) {
    const key = JSON.stringify(hypothesis);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(hypothesis);
  }
  return unique;
}
