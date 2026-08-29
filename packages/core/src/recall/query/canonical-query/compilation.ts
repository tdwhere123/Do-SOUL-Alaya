import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../field/field-identity.js";
import { stableStringify } from "../../../shared/stable-stringify.js";
import type { SnapshotCoherenceReceiptV1 } from
  "../../runtime/snapshot-coherence/index.js";
import {
  CANONICAL_QUERY_OPERATOR_ID,
  type CanonicalAnswerProgramV1,
  type CanonicalCompletionV1,
  type CanonicalQueryV1
} from "./types.js";
import {
  compileCanonicalQueryEvidence,
  type CanonicalQueryCompileV1,
  type CanonicalQueryEvidenceV1,
  type CanonicalQueryUnresolvedV1
} from "./compile.js";
import { digestCanonicalQueryV1, validateCanonicalQueryV1 } from "./validate.js";

export const QUERY_HOLE_IMPACTS = [
  "blocks_membership",
  "blocks_pointwise_comparison",
  "blocks_operator_resolution",
  "blocks_completeness_claim",
  "blocks_certified_delivery",
  "blocks_all_delivery"
] as const;

export type QueryHoleImpactV1 = (typeof QUERY_HOLE_IMPACTS)[number];

export type CanonicalQueryHoleV1 = Readonly<{
  readonly provenance: string;
  readonly code: string;
  readonly impacts: readonly QueryHoleImpactV1[];
  readonly hypothesis_digest?: RecallFieldDigest;
}>;

export type CanonicalQueryCompileStatusV1 =
  | "certified_program"
  | "partial_program"
  | "unsupported";

export type CanonicalQueryHypotheticalModeV1 =
  | "certified"
  | "best_effort"
  | "abstained"
  | "unsupported";

export type CanonicalQueryIdentityV1 = Readonly<{
  readonly condition_identity: string;
  readonly query_operator_id: string;
  readonly generation_id: string;
  readonly query_cache_key: string;
}>;

export type CanonicalQuerySensitivityV1 = Readonly<{
  readonly effect:
    | "answer_binding"
    | "answer_position"
    | "proposition_bound"
    | "extremum_range"
    | "completion_scope";
  readonly target: string;
}>;

export const UNBOUND_CANONICAL_QUERY_IDENTITY: CanonicalQueryIdentityV1 = Object.freeze({
  condition_identity: "unbound",
  query_operator_id: "unbound",
  generation_id: "unbound",
  query_cache_key: "unbound"
});

export type CanonicalQueryCompilationV1 = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof CANONICAL_QUERY_OPERATOR_ID;
  readonly hypotheses: readonly CanonicalQueryV1[];
  readonly unresolved: readonly CanonicalQueryUnresolvedV1[];
  readonly provenance: readonly string[];
  readonly hypothesis_provenance: CanonicalQueryCompileV1["hypothesis_provenance"];
  readonly holes: readonly CanonicalQueryHoleV1[];
  readonly compile_status: CanonicalQueryCompileStatusV1;
  readonly hypothetical_mode: CanonicalQueryHypotheticalModeV1;
  readonly sensitivities: readonly CanonicalQuerySensitivityV1[];
  readonly snapshot_receipt_digest: RecallFieldDigest;
  readonly query_identity: CanonicalQueryIdentityV1;
  readonly digest: RecallFieldDigest;
}>;

type QuerySnapshotInputV1 = Readonly<Pick<SnapshotCoherenceReceiptV1,
  "principal" | "authorized_scopes" | "receipt_digest" | "coherence_state">>;

export function compileCanonicalQueryCompilation(
  evidence: CanonicalQueryEvidenceV1,
  snapshot: QuerySnapshotInputV1
): CanonicalQueryCompilationV1 {
  const compiled = compileCanonicalQueryEvidence(evidence, snapshot);
  const queryIdentity = bindQueryIdentity(evidence.query_identity);
  const holes = Object.freeze([
    ...collectHoles(compiled),
    ...snapshotHoles(snapshot),
    ...queryIdentityHoles(queryIdentity.bound)
  ]);
  const compile_status = compileStatus(compiled.hypotheses, holes);
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: CANONICAL_QUERY_OPERATOR_ID,
    hypotheses: compiled.hypotheses,
    unresolved: compiled.unresolved,
    provenance: compiled.provenance,
    hypothesis_provenance: compiled.hypothesis_provenance,
    holes,
    compile_status,
    hypothetical_mode: hypotheticalMode(compile_status, holes),
    sensitivities: collectSensitivities(compiled.hypotheses),
    snapshot_receipt_digest: snapshot.receipt_digest,
    query_identity: queryIdentity.identity
  });
  return Object.freeze({
    ...body,
    digest: digestRecallFieldIdentity(body)
  });
}

export function verifyCanonicalQueryCompilationV1(
  compilation: CanonicalQueryCompilationV1,
  evidence: CanonicalQueryEvidenceV1,
  snapshot: QuerySnapshotInputV1
): void {
  verifyHypotheses(compilation.hypotheses);
  verifyHoleImpacts(compilation.holes);
  verifyHoleBindings(compilation.holes, compilation.hypotheses);
  verifyCompileDisposition(compilation);
  verifySensitivities(compilation);
  if (digestRecallFieldIdentity(compilationBody(compilation)) !== compilation.digest) {
    throw new Error("canonical query compilation digest mismatch");
  }
  const expected = compileCanonicalQueryCompilation(evidence, snapshot);
  if (expected.digest !== compilation.digest) {
    throw new Error("canonical query compilation evidence mismatch");
  }
}

function compilationBody(
  compilation: CanonicalQueryCompilationV1
): Omit<CanonicalQueryCompilationV1, "digest"> {
  return {
    schema_version: compilation.schema_version,
    operator_id: compilation.operator_id,
    hypotheses: compilation.hypotheses,
    unresolved: compilation.unresolved,
    provenance: compilation.provenance,
    hypothesis_provenance: compilation.hypothesis_provenance,
    holes: compilation.holes,
    compile_status: compilation.compile_status,
    hypothetical_mode: compilation.hypothetical_mode,
    sensitivities: compilation.sensitivities,
    snapshot_receipt_digest: compilation.snapshot_receipt_digest,
    query_identity: compilation.query_identity
  };
}

function verifyHypotheses(hypotheses: readonly CanonicalQueryV1[]): void {
  for (const hypothesis of hypotheses) {
    if (validateCanonicalQueryV1(hypothesis).status !== "supported") {
      throw new Error("canonical query compilation hypothesis invalid");
    }
  }
}

function verifyHoleImpacts(holes: readonly CanonicalQueryHoleV1[]): void {
  for (const hole of holes) {
    if (stableStringify([...hole.impacts]) !== stableStringify(impactsFor(hole.code))) {
      throw new Error("canonical query compilation hole impact mismatch");
    }
  }
}

function verifyHoleBindings(
  holes: readonly CanonicalQueryHoleV1[],
  hypotheses: readonly CanonicalQueryV1[]
): void {
  const digests = new Set(hypotheses.map(digestCanonicalQueryV1));
  for (const hole of holes) {
    if (hole.code === "unbound_target_term" && hole.hypothesis_digest === undefined) {
      throw new Error("canonical query target hole is not hypothesis-bound");
    }
    if (hole.hypothesis_digest !== undefined && !digests.has(hole.hypothesis_digest)) {
      throw new Error("canonical query hole references an unknown hypothesis");
    }
  }
}

function verifyCompileDisposition(compilation: CanonicalQueryCompilationV1): void {
  const status = compileStatus(compilation.hypotheses, compilation.holes);
  if (compilation.compile_status !== status) {
    throw new Error("canonical query compilation status mismatch");
  }
  if (compilation.hypothetical_mode !== hypotheticalMode(status, compilation.holes)) {
    throw new Error("canonical query compilation mode mismatch");
  }
}

function verifySensitivities(compilation: CanonicalQueryCompilationV1): void {
  if (
    stableStringify(compilation.sensitivities)
    !== stableStringify(collectSensitivities(compilation.hypotheses))
  ) {
    throw new Error("canonical query compilation sensitivities mismatch");
  }
}

function bindQueryIdentity(
  identity: CanonicalQueryIdentityV1 | undefined
): Readonly<{ readonly identity: CanonicalQueryIdentityV1; readonly bound: boolean }> {
  if (!isBoundQueryIdentity(identity)) {
    return Object.freeze({ identity: UNBOUND_CANONICAL_QUERY_IDENTITY, bound: false });
  }
  return Object.freeze({ identity: Object.freeze({
    condition_identity: identity.condition_identity,
    query_operator_id: identity.query_operator_id,
    generation_id: identity.generation_id,
    query_cache_key: identity.query_cache_key
  }), bound: true });
}

function isBoundQueryIdentity(value: unknown): value is CanonicalQueryIdentityV1 {
  if (typeof value !== "object" || value === null) return false;
  const identity = value as Partial<Record<keyof CanonicalQueryIdentityV1, unknown>>;
  return [
    identity.condition_identity,
    identity.query_operator_id,
    identity.generation_id,
    identity.query_cache_key
  ].every((token) => typeof token === "string" && token.length > 0 && token.trim() === token);
}

function queryIdentityHoles(bound: boolean): readonly CanonicalQueryHoleV1[] {
  return bound ? [] : [holeFromCode("unbound_query_identity", "query_identity")];
}

function snapshotHoles(
  snapshot: Readonly<Pick<SnapshotCoherenceReceiptV1, "coherence_state">>
): readonly CanonicalQueryHoleV1[] {
  if (snapshot.coherence_state === "coherent_exact") return [];
  return [holeFromCode(snapshot.coherence_state, "snapshot")];
}

function collectHoles(compiled: CanonicalQueryCompileV1): CanonicalQueryHoleV1[] {
  return [
    ...compiled.unresolved.map((item) => holeFromUnresolved(item)),
    ...completenessHoles(compiled.hypotheses)
  ];
}

function completenessHoles(
  hypotheses: readonly CanonicalQueryV1[]
): CanonicalQueryHoleV1[] {
  return hypotheses.flatMap((query) => usesAllObservable(query.answer)
    ? [holeFromCode("blocks_completeness_claim", "completion")]
    : []);
}

function usesAllObservable(answer: CanonicalAnswerProgramV1): boolean {
  if (answer.kind === "distinct" || answer.kind === "sequence") {
    return answer.completion.kind === "all_observable";
  }
  if (answer.kind === "argmax" || answer.kind === "argmin") {
    return usesAllObservable(answer.inner);
  }
  return false;
}

function holeFromUnresolved(
  item: CanonicalQueryUnresolvedV1
): CanonicalQueryHoleV1 {
  return holeFromCode(item.code, unresolvedProvenance(item), item.hypothesis_digest);
}

function unresolvedProvenance(item: CanonicalQueryUnresolvedV1): string {
  return [item.source, item.detail, item.capture_digest, item.hypothesis_digest]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(":");
}

function holeFromCode(
  code: string,
  provenance: string,
  hypothesisDigest?: RecallFieldDigest
): CanonicalQueryHoleV1 {
  return Object.freeze({
    provenance,
    code,
    impacts: Object.freeze(impactsFor(code)),
    ...(hypothesisDigest === undefined ? {} : { hypothesis_digest: hypothesisDigest })
  });
}

export function impactsFor(code: string): QueryHoleImpactV1[] {
  if (code === "unknown_answer_variable") {
    return ["blocks_membership", "blocks_all_delivery"];
  }
  if (code === "count_sum_unsupported" || code === "unsupported_nesting"
    || code === "ambiguous_cjk_segmentation" || code === "latest_without_typed_time_key"
    || code === "unknown_time_basis" || code === "wrong_temporal_domain"
    || code === "unbound_order_key" || code === "limit_overflow"
    || code === "unadapted_osf") {
    return ["blocks_operator_resolution", "blocks_certified_delivery"];
  }
  if (code === "conflicting_demand_shape" || code === "conflicting_shape"
    || code === "unknown_relation" || code === "unadapted_fact_frame"
    || code === "unbound_target_term" || code === "unknown_correlation") {
    return ["blocks_pointwise_comparison", "blocks_certified_delivery"];
  }
  if (
    code === "blocks_completeness_claim"
    || code === "unknown_scope"
    || code === "invalid_all_observable"
  ) {
    return ["blocks_completeness_claim", "blocks_certified_delivery"];
  }
  if (code === "unavailable") {
    return ["blocks_all_delivery", "blocks_certified_delivery"];
  }
  if (code === "unbound_query_identity") {
    return ["blocks_all_delivery", "blocks_certified_delivery"];
  }
  return ["blocks_certified_delivery"];
}

function compileStatus(
  hypotheses: readonly CanonicalQueryV1[],
  holes: readonly CanonicalQueryHoleV1[]
): CanonicalQueryCompileStatusV1 {
  if (hypotheses.length > 0 && holes.length === 0) return "certified_program";
  if (hypotheses.length > 0) return "partial_program";
  return "unsupported";
}

function hypotheticalMode(
  status: CanonicalQueryCompileStatusV1,
  holes: readonly CanonicalQueryHoleV1[]
): CanonicalQueryHypotheticalModeV1 {
  if (holes.some((hole) => hole.impacts.includes("blocks_all_delivery"))) {
    return status === "unsupported" ? "unsupported" : "abstained";
  }
  if (status === "certified_program") return "certified";
  if (status === "partial_program") return "best_effort";
  return "unsupported";
}

function collectSensitivities(
  hypotheses: readonly CanonicalQueryV1[]
): readonly CanonicalQuerySensitivityV1[] {
  const rows: CanonicalQuerySensitivityV1[] = [];
  const seen = new Set<string>();
  const add = (
    effect: CanonicalQuerySensitivityV1["effect"],
    target: string
  ): void => {
    const key = `${effect}:${target}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(Object.freeze({ effect, target }));
  };
  for (const query of hypotheses) {
    collectAnswerSensitivities(query.answer, add);
    for (const atom of [...query.predicates, ...query.constraints]) {
      const relation = "relation" in atom ? atom.relation : atom.constraint;
      add("proposition_bound", `${atom.id}:${relation}`);
      atom.arguments.forEach((argument, index) => {
        if (isAnswerVariable(query.answer, argument)) {
          add("answer_position", `${atom.id}:${String(index)}`);
        }
      });
    }
  }
  return Object.freeze(rows.sort((left, right) =>
    left.effect.localeCompare(right.effect) || left.target.localeCompare(right.target)
  ));
}

function collectAnswerSensitivities(
  answer: CanonicalAnswerProgramV1,
  add: (effect: CanonicalQuerySensitivityV1["effect"], target: string) => void
): void {
  if (answer.kind === "scalar" || answer.kind === "distinct" || answer.kind === "sequence") {
    add("answer_binding", answer.variable);
  }
  if (answer.kind === "distinct" || answer.kind === "sequence") {
    add("completion_scope", completionTarget(answer.completion));
  }
  if (answer.kind === "argmax" || answer.kind === "argmin" || answer.kind === "sequence") {
    add("extremum_range", answer.order_key);
  }
  if (answer.kind === "argmax" || answer.kind === "argmin") {
    collectAnswerSensitivities(answer.inner, add);
  }
}

function isAnswerVariable(answer: CanonicalAnswerProgramV1, name: string): boolean {
  if (answer.kind === "scalar" || answer.kind === "distinct" || answer.kind === "sequence") {
    return answer.variable === name;
  }
  return isAnswerVariable(answer.inner, name);
}

function completionTarget(completion: CanonicalCompletionV1): string {
  if (completion.kind === "at_most") return `at_most:${String(completion.n)}`;
  return `all_observable:${completion.scope}:${completion.observer_contract}`;
}
